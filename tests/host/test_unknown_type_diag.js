'use strict';
// #708: an unknown type name is THE most common C compile error, and the
// declaration path used to report it as an anonymous "type specifier missing
// (implicit int is not allowed in C99)" — naming neither the identifier nor
// which of the line's identifiers it meant (#502 Pass A round 2 measured a
// hand-bisect of the line). The specifier loop breaks on the unresolved
// identifier WITHOUT consuming it, so the diagnostic now names it whenever it
// reads as a type name followed by a declarator; the genuinely-bare implicit
// int shape keeps the old wording, and the bare block-scope statement shape
// keeps its expression-path "Undeclared identifier".
//
// Driven through createCcDriver — the in-OS /bin/cc surface the finding was
// measured on, the test_gcode_orientation.js harness shape.
//
//   node tests/host/test_unknown_type_diag.js
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const HOST = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

const ccHarness = (() => {
  const store = new HOST.BLOCK_FS.MemoryByteStore(64 * 1024 * 1024);
  const kfs = HOST.BLOCK_FS.create(store);
  const compile = COMMON.createCcDriver(CompilerJS, kfs);
  const enc = new TextEncoder();
  let n = 0;
  return (src) => {
    const p = '/utd' + (n++) + '.c';
    const fd = kfs.open(p, 0x1 | 0x40 | 0x200, 0o644);
    const b = enc.encode(src);
    kfs.write(fd, b, b.length);
    kfs.close(fd);
    return compile(['cc', p, '-o', '/utd.out'], '/');
  };
})();

// The ticket's case table: every declaration-path shape names the identifier.
const NAMED = [
  ['B: block-scope static', 'int main(void){ static Zzz x; (void)x; return 0; }'],
  ['C: file-scope static', 'static Zzz x;\nint main(void){ return 0; }'],
  ['D: file-scope bare', 'Zzz x;\nint main(void){ return 0; }'],
  ['E: qualified local', 'int main(void){ const Zzz x = 0; (void)x; return 0; }'],
  ['pointer declarator', 'static Zzz *p;\nint main(void){ (void)p; return 0; }'],
  ['function declaration', 'Zzz f(void);\nint main(void){ return 0; }'],
];
for (const [label, src] of NAMED) {
  check('case ' + label + " reports unknown type name 'Zzz'", () => {
    const r = ccHarness(src);
    assert(r.exitCode !== 0, 'unexpectedly compiled');
    assert((r.stderr || '').includes("unknown type name 'Zzz'"),
      'diagnostic does not name the type: ' + r.stderr);
  });
}

check("case A (bare block-scope statement) keeps its expression-path 'Undeclared identifier'", () => {
  const r = ccHarness('int main(void){ Zzz x; (void)x; return 0; }');
  assert(r.exitCode !== 0, 'unexpectedly compiled');
  assert((r.stderr || '').includes("Undeclared identifier 'Zzz'"),
    'the expression path drifted: ' + r.stderr);
});

check('a genuinely bare declarator keeps the implicit-int wording', () => {
  const r = ccHarness('static x;\nint main(void){ return 0; }');
  assert(r.exitCode !== 0, 'unexpectedly compiled');
  assert((r.stderr || '').includes('type specifier missing (implicit int is not allowed in C99)'),
    'the implicit-int shape lost its wording: ' + r.stderr);
  assert(!(r.stderr || '').includes('unknown type name'),
    "the bare shape misreported as an unknown type: " + r.stderr);
});

check('positive control: a real typedef name still compiles (the branch is not overzealous)', () => {
  const r = ccHarness('typedef int Zzz;\nstatic Zzz x;\nint main(void){ return (int)x; }');
  assert(r.exitCode === 0, 'a known typedef stopped compiling: ' + r.stderr);
});

console.log(failures ? '\n' + failures + ' unknown-type-diag check(s) FAILED' : '\nAll unknown-type-diag checks passed');
process.exit(failures ? 1 : 0);
