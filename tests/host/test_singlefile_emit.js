// Host-level regression test (code-debt scan CD15): the single-file .js/.html
// emitters inline host.js and must cut it at the structural `// @cc-strip-below`
// sentinel — NOT at a prose comment. Before the fix, the strip was a regex over
// the literal text "Dual-purpose logic": rewording that comment made the strip
// a silent no-op, so the emitted Node bundle kept host.js's run-if-main tail
// and DOUBLE-EXECUTED (the tail ran host.js's own CLI against `a.wasm` before
// the real program), with exit 0 and zero diagnostics. Now the strip keys on
// the sentinel and the emit THROWS, naming the sentinel, when it's absent.
//
// Run: node tests/host/test_singlefile_emit.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST = path.join(ROOT, 'host.js');
const SENTINEL = '// @cc-strip-below';

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Distinctive strings that only exist in host.js's standalone tail — if any
// of them survives into a bundle, the strip regressed.
const TAIL_MARKERS = ['Dual-purpose logic', SENTINEL, "process.argv[2] || 'a.wasm'"];

const SRC = '#include <stdio.h>\nint main(void) { printf("RAN\\n"); return 0; }\n';

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'singlefile-emit-'));
  const cFile = path.join(tmp, 'ran.c');
  fs.writeFileSync(cFile, SRC);

  // --- Leg 1: .js emit strips the tail; the bundle runs exactly once ------
  const jsFile = path.join(tmp, 'ran.js');
  const r1 = cp.spawnSync('node', [COMPILER, cFile, '-o', jsFile], { encoding: 'utf-8' });
  check('.js emit succeeds', r1.status === 0, 'status=' + r1.status + ' stderr=' + r1.stderr);
  const jsBody = fs.readFileSync(jsFile, 'utf-8');
  for (const m of TAIL_MARKERS) {
    check('.js bundle has no tail marker ' + JSON.stringify(m), !jsBody.includes(m));
  }
  const run = cp.spawnSync('node', [jsFile], { encoding: 'utf-8' });
  check('bundle exits 0', run.status === 0, 'status=' + run.status + ' stderr=' + run.stderr);
  check('bundle output is exactly one RAN (no double execution)',
    run.stdout === 'RAN\n', JSON.stringify(run.stdout));

  // --- Leg 2: .html emit strips the tail too (page + worker scripts use ---
  // host.js's top-level declarations directly; the tail is dead weight)
  const htmlFile = path.join(tmp, 'ran.html');
  const r2 = cp.spawnSync('node', [COMPILER, cFile, '-o', htmlFile], { encoding: 'utf-8' });
  check('.html emit succeeds', r2.status === 0, 'status=' + r2.status + ' stderr=' + r2.stderr);
  const htmlBody = fs.readFileSync(htmlFile, 'utf-8');
  for (const m of TAIL_MARKERS) {
    check('.html bundle has no tail marker ' + JSON.stringify(m), !htmlBody.includes(m));
  }
  check('.html bundle still embeds host.js (runModule present)', htmlBody.includes('runModule'));

  // --- Leg 3: tripwire — a reworded/removed sentinel must FAIL LOUD -------
  // Copy compiler.js + a doctored host.js (sentinel reworded, prose kept)
  // into tmp and emit from there; pre-fix this silently emitted the tail.
  fs.copyFileSync(COMPILER, path.join(tmp, 'compiler.js'));
  const hostSrc = fs.readFileSync(HOST, 'utf-8');
  check('repo host.js carries the sentinel', hostSrc.includes(SENTINEL));
  fs.writeFileSync(path.join(tmp, 'host.js'), hostSrc.split(SENTINEL).join('// @cc-cut-here'));
  const badJs = path.join(tmp, 'bad.js');
  const r3 = cp.spawnSync('node', [path.join(tmp, 'compiler.js'), cFile, '-o', badJs],
    { encoding: 'utf-8' });
  check('emit against doctored host.js exits nonzero', r3.status !== 0, 'status=' + r3.status);
  check('error names the sentinel and host.js',
    r3.stderr.includes(SENTINEL) && r3.stderr.includes('host.js'), JSON.stringify(r3.stderr.slice(0, 200)));
  check('no bundle written on failure', !fs.existsSync(badJs));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' check(s) FAILED' : 'test_singlefile_emit: all checks passed');
  process.exit(failures ? 1 : 0);
}

main();
