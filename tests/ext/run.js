#!/usr/bin/env node
// Tests the OPTIONAL libc-ext.js contract:
//  1. compiler.js works fully when libc-ext.js is ABSENT (graceful degradation),
//     and a <regex.h> include then fails with a helpful "not present" message.
//  2. compiler.js picks up regex/fnmatch/glob when libc-ext.js IS present.
//
// Run: node tests/ext/run.js   (exit 0 = all pass)

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPILER = path.join(ROOT, 'compiler.js');
const EXT = path.join(ROOT, 'libc-ext.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); failures++; }
}

function run(compilerPath, args, cwd) {
  try {
    const out = execFileSync('node', [compilerPath, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// --- 1. WITHOUT libc-ext.js: copy compiler.js alone into a temp dir ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libcext-'));
fs.copyFileSync(COMPILER, path.join(tmp, 'compiler.js'));
const aloneCompiler = path.join(tmp, 'compiler.js');

fs.writeFileSync(path.join(tmp, 'hello.c'),
  '#include <stdio.h>\nint main(void){ printf("hi\\n"); return 0; }\n');
fs.writeFileSync(path.join(tmp, 'rx.c'),
  '#include <regex.h>\nint main(void){ regex_t r; return regcomp(&r, "a", 0); }\n');

const helloNoExt = run(aloneCompiler, ['hello.c', '-o', 'hello.wasm'], tmp);
check('core compiles without libc-ext.js', helloNoExt.code === 0,
  `exit ${helloNoExt.code}: ${helloNoExt.stderr.trim()}`);

const rxNoExt = run(aloneCompiler, ['rx.c', '-o', 'rx.wasm'], tmp);
check('<regex.h> fails without libc-ext.js', rxNoExt.code !== 0, 'expected failure');
check('...and the error names libc-ext.js',
  /libc-ext\.js/.test(rxNoExt.stderr), `stderr: ${rxNoExt.stderr.trim()}`);

fs.rmSync(tmp, { recursive: true, force: true });

// --- 2. WITH libc-ext.js present (next to the repo compiler.js) ---
check('libc-ext.js exists at repo root', fs.existsSync(EXT), EXT);
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'libcext-pos-'));
fs.writeFileSync(path.join(tmp2, 'rx.c'),
  '#include <regex.h>\n#include <fnmatch.h>\n#include <glob.h>\n' +
  'int main(void){ regex_t r; return regcomp(&r, "^a+$", 1) | fnmatch("*", "x", 0); }\n');
const rxWithExt = run(COMPILER, [path.join(tmp2, 'rx.c'), '-o', path.join(tmp2, 'rx.wasm')], ROOT);
check('regex+fnmatch+glob compile with libc-ext.js', rxWithExt.code === 0,
  `exit ${rxWithExt.code}: ${rxWithExt.stderr.trim()}`);
fs.rmSync(tmp2, { recursive: true, force: true });

// --- 3. SYNC: the committed libc-ext.js matches what ext/ generates (#534) ---
// Without this, an edit under ext/ that skips regeneration is invisible to
// every suite — the compiler reads the committed artifact, not the sources.
const GEN = path.join(ROOT, 'tools', 'build-libc-ext.js');
const syncOk = run(GEN, ['--check'], ROOT);
check('libc-ext.js is in sync with ext/ (build-libc-ext.js --check)',
  syncOk.code === 0, `exit ${syncOk.code}: ${syncOk.stderr.trim()}`);

// Red control: --check must actually FAIL on a drifted artifact, or the leg
// above proves nothing. Generate into a temp file, tamper it, re-check.
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'libcext-sync-'));
const tampered = path.join(tmp3, 'libc-ext.js');
const genOut = run(GEN, [`--out=${tampered}`], ROOT);
check('--out generation succeeds (red-control setup)', genOut.code === 0,
  `exit ${genOut.code}: ${genOut.stderr.trim()}`);
fs.appendFileSync(tampered, '// drift\n');
const syncRed = run(GEN, ['--check', `--out=${tampered}`], ROOT);
check('--check FAILS on a tampered artifact (red control)', syncRed.code === 1,
  `exit ${syncRed.code} (expected 1)`);
check('...and the failure names the regeneration fix',
  /build-libc-ext\.js/.test(syncRed.stderr), `stderr: ${syncRed.stderr.trim()}`);
fs.rmSync(tmp3, { recursive: true, force: true });

console.log(failures === 0 ? '\next: all passed' : `\next: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
