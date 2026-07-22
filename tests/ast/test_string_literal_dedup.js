'use strict';

// todos/0228 — read-only string literals: dedup OFF by default (a UB write
// through one literal stays LOCAL instead of corrupting every same-spelling
// literal), an opt-in --dedup-literals flag restores content merging, and a
// compile-time diagnostic rejects PROVABLE direct writes through a literal.
//
// These are UB-behavior / flag / diagnostic checks, so they live here rather
// than in tests/unit/conformance (which is clang-differential — clang would
// segfault on the write, having put the literal in .rodata). The point IS the
// difference our two policies produce, which no clang oracle can express.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const C = require('../../compiler.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'strlit-dedup-'));

let failures = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
}

function baseOptions(extra) {
  return Object.assign({
    debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
    allowKnRDefinitions: false, allowImplicitFunctionDecl: false, allowUndefined: false,
    allowZeroLengthArrays: false, gcSections: false, gcNoExportRoots: false,
    noUndefined: false, timeReport: false, requireSources: [], backend: 'default',
  }, extra || {});
}

// Compile `src`; returns { wasmPath } on success or { error: '<stderr>' } when
// compilation reports a diagnostic (never throws for a diagnosed program).
function compileC(src, name, optExtra) {
  const file = path.join(TMP, name + '.c');
  fs.writeFileSync(file, src);
  const pp = C.createDefaultPPRegistry();
  pp.fileReader = (fp) => { try { return fs.readFileSync(fp, 'utf-8'); } catch { return null; } };
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };
  const compilerOptions = baseOptions(optExtra);
  let err = '';
  const writeErr = (s) => { err += s; };
  try {
    const units = C.parseAllUnits(fs, pp, [file], { warningFlags, compilerOptions, writeErr });
    const link = C.linkTranslationUnits(units, compilerOptions);
    if (link.errors.length) return { error: err || link.errors.map(e => e.message).join('; ') };
    const wasm = C.generateCode(units, path.join(TMP, name + '.wasm'), { compilerOptions, warningFlags, writeErr });
    const wasmPath = path.join(TMP, name + '.wasm');
    fs.writeFileSync(wasmPath, wasm);
    return { wasmPath };
  } catch (e) {
    if (e && e.compilationFailed) return { error: err };
    throw e;
  }
}
function runWasm(wasmPath) {
  return execFileSync('node', [path.join(ROOT, 'host.js'), wasmPath], { encoding: 'utf8' });
}

// Two same-spelling literals; a[0] is written through a VARIABLE (not a
// provable literal write, so no diagnostic). Default policy gives each literal
// its own storage → b is untouched; --dedup-literals merges them → b changes.
const ALIAS_SRC = `#include <stdio.h>
int main(void) {
  char *a = "hello";
  char *b = "hello";
  a[0] = 'J';
  printf("%s|%s\\n", a, b);
  return 0;
}`;

// ---- 1. dedup OFF by default: the write stays local ----
{
  const r = compileC(ALIAS_SRC, 'alias_default');
  ok('default-compiles', !r.error, r.error);
  if (!r.error) ok('default-no-alias', runWasm(r.wasmPath) === 'Jello|hello\n',
                   'expected Jello|hello (b unchanged)');
}

// ---- 2. --dedup-literals restores content merging ----
{
  const r = compileC(ALIAS_SRC, 'alias_dedup', { dedupLiterals: true });
  ok('dedup-compiles', !r.error, r.error);
  if (!r.error) ok('dedup-aliases', runWasm(r.wasmPath) === 'Jello|Jello\n',
                   'expected Jello|Jello (both point at one merged literal)');
}

// ---- 3. the diagnostic: PROVABLE direct writes through a literal ----
const REJECT = [
  ['subscript',      `int main(void){ "hello"[0] = 'J'; return 0; }`],
  ['deref',          `int main(void){ *"hello" = 'J'; return 0; }`],
  ['deref-offset',   `int main(void){ *("hello" + 1) = 'J'; return 0; }`],
  ['reverse-index',  `int main(void){ 0["hello"] = 'J'; return 0; }`],
  ['compound-assign',`int main(void){ "hello"[0] += 1; return 0; }`],
  ['pre-inc',        `int main(void){ ++"hello"[0]; return 0; }`],
  ['post-inc',       `int main(void){ "hello"[0]++; return 0; }`],
  ['cast-through',   `int main(void){ *(char*)"hello" = 'J'; return 0; }`],
  ['ternary-lits',   `int main(void){ (1 ? "a" : "b")[0] = 'J'; return 0; }`],
];
for (const [name, src] of REJECT) {
  const r = compileC(src, 'reject_' + name);
  ok('reject-' + name, !!r.error && /read-only string literal/.test(r.error),
     r.error ? JSON.stringify(r.error) : 'compiled without a diagnostic');
}

// ---- 4. legitimate code is NOT diagnosed (no false positives) ----
const ACCEPT = [
  ['read-subscript',  `#include <stdio.h>\nint main(void){ char c = "hello"[1]; printf("%c\\n", c); return 0; }`, 'e\n'],
  ['char-buf-write',  `#include <stdio.h>\nint main(void){ char b[] = "hello"; b[0] = 'J'; printf("%s\\n", b); return 0; }`, 'Jello\n'],
  ['ptr-var-write',   `#include <stdio.h>\nint main(void){ char *p = "hello"; p[0] = 'J'; printf("%s\\n", p); return 0; }`, 'Jello\n'],
];
for (const [name, src, want] of ACCEPT) {
  const r = compileC(src, 'accept_' + name);
  ok('accept-' + name, !r.error, r.error);
  if (!r.error) ok('accept-' + name + '-runs', runWasm(r.wasmPath) === want,
                   `expected ${JSON.stringify(want)}`);
}

fs.rmSync(TMP, { recursive: true, force: true });

if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('all string-literal dedup/diagnostic tests passed');
