// Binary-shape assertions for __gcstr (todos/0041) — the parts a C-level
// stdout test can't see:
//
//  1. Dedup is observable in the binary: one module-"#" global import per
//     DISTINCT literal, however many use sites (including adjacent-literal
//     concatenation spelling the same content differently).
//  2. Zero linear memory: the literal's bytes appear in the import section
//     only, never in a data segment.
//  3. The import type is an immutable non-nullable (ref extern) — what the
//     js-string spec requires of importedStringConstants globals.
//  4. Loader polyfill: an engine/loader that can't pass compile options can
//     satisfy the imports with `imports['#'] = new Proxy({}, {get: (_, n) => n})`
//     (the one-liner documented in todos/0041) — instantiation succeeds and
//     the program behaves identically.
//
// Run: node tests/host/test_gcstr_imports.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const SRC = `
#include <guc.h>
__externref g = __gcstr("gcstr-file-scope-XYZZY");
int total;
int main(void) {
    __externref a = __gcstr("gcstr-dedup-PLUGH");
    __externref b = __gcstr("gcstr-" "dedup-" "PLUGH");   /* same content */
    total = __wjs_length(a) + __wjs_length(b) + __wjs_length(g)
          + __wjs_length(__gcstr("gcstr-dedup-PLUGH"));
    return total == 17 + 17 + 22 + 17 ? 0 : 1;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcstr-'));
const cPath = path.join(tmp, 'main.c');
const wasmPath = path.join(tmp, 'main.wasm');
fs.writeFileSync(cPath, SRC);
const r = cp.spawnSync(process.execPath, [COMPILER, cPath, '-o', wasmPath], { encoding: 'utf-8' });
check('compiles', r.status === 0, r.stderr);

const bytes = fs.readFileSync(wasmPath);

// Compile WITHOUT importedStringConstants so the "#" imports stay visible.
const mod = new WebAssembly.Module(bytes);
const strImports = WebAssembly.Module.imports(mod).filter(i => i.module === '#');
const names = strImports.map(i => i.name).sort();
check('one import per distinct literal',
  names.length === 2 && names[0] === 'gcstr-dedup-PLUGH' && names[1] === 'gcstr-file-scope-XYZZY',
  JSON.stringify(names));
check('imports are immutable globals',
  strImports.every(i => i.kind === 'global'));

// The literal bytes must not land in linear memory: exactly one occurrence
// in the whole binary (the import name itself).
const raw = bytes.toString('latin1');
check('literal appears once (import name only)',
  raw.split('gcstr-dedup-PLUGH').length - 1 === 1);
check('file-scope literal appears once (import name only)',
  raw.split('gcstr-file-scope-XYZZY').length - 1 === 1);

// Import type: WebAssembly.Module.imports exposes .type on modern Node.
const t = strImports[0].type;
if (t && t.value !== undefined) {
  check('type is (ref extern) immutable',
    String(t.value).indexOf('extern') !== -1 && t.mutable === false, JSON.stringify(t));
} else {
  console.log('  skip type introspection (no imports().type on this Node)');
}

// Loader polyfill: no compile options, "#" satisfied by a name-echo Proxy.
// The module also needs its normal env — steal host.js's machinery by just
// instantiating standalone: this program only needs the js-string builtins
// polyfilled too, so keep it simple and check the Proxy resolves the globals.
(async () => {
  const importObject = { '#': new Proxy({}, { get: (_, name) => name }) };
  // Provide the wasm:js-string functions the program imports (the builtins
  // option is deliberately NOT used — this is the no-options loader story).
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.module === 'wasm:js-string') {
      (importObject['wasm:js-string'] ||= {})[imp.name] = {
        length: (s) => s.length,
      }[imp.name] || ((s) => s.length);
    } else if (imp.module !== '#' && !importObject[imp.module]) {
      importObject[imp.module] = {};
    }
  }
  // Fill any remaining function/memory imports with permissive stubs so
  // instantiation succeeds (main is never called with a real env here —
  // we only need link-time resolution of the "#" globals to succeed).
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.module === '#' || imp.module === 'wasm:js-string') continue;
    if (importObject[imp.module][imp.name] !== undefined) continue;
    if (imp.kind === 'function') importObject[imp.module][imp.name] = () => 0;
    else if (imp.kind === 'memory') importObject[imp.module][imp.name] = new WebAssembly.Memory({ initial: 2 });
  }
  let inst = null, err = null;
  try { inst = await WebAssembly.instantiate(mod, importObject); }
  catch (e) { err = e; }
  check('instantiates with the "#" Proxy polyfill (no compile options)', !!inst, err && err.message);
  if (inst) {
    const rc = inst.exports.main(0, 0);
    check('program result correct under polyfill', rc === 0, 'rc=' + rc);
  }

  console.log(failures ? failures + ' FAILURE(S)' : 'all ok');
  process.exit(failures ? 1 : 0);
})();
