# 0041 — `__gcstr("...")`: GC string literals via importedStringConstants

- **Status**: DONE (2026-07-10). Landed in full — keyword builtin (parsed as
  an `EIntrinsic` GC_STR carrying the `EString`, not a new node class: three
  dispatch sites total), module-"#" immutable `(ref extern)` global imports
  deduped by content, defined-global index-space shift with a structural
  guard (`addGlobalImport` throws after the first defined global; a
  generateCode pre-scan registers every literal first), file-scope init for
  BOTH `__externref` and `__refextern` (the latter gained its one valid
  global initializer), `GCSTR()` macro in guc.h, importedStringConstants
  wired into the host.js/kernel.js MUST-MATCH compile-options pair. Tests:
  `tests/unit/gc/gcstr*` + three `err_gcstr_*` diags,
  `tests/host/test_gcstr_imports.js` (binary-shape: dedup, zero linear
  memory, "#"-Proxy loader polyfill). Unit 707/707, kernel 44/44, host
  suite, headless + browser boot, in-OS `cc` all green. Residue → follow-up
  **0097** (ss modules join the 0037 spawn module cache — the compile-option
  unification this item performed was the only blocker). Adjacent fix landed
  with it: `newestBakeInput` no longer counts `*.img.tmp-<pid>` bake temps
  as inputs (a killed bake made the image perpetually stale).
- **Design**: self-contained (Plan + Acceptance below). A main-compiler
  feature, independently useful to plain C.

## Goal

`__gcstr("...")` in the MAIN compiler: a string literal as an imported
externref constant instead of a data-segment address. Zero-copy, zero
linear memory, deduped by construction — and independently useful to
plain C (today's `__jsstr(const char *)` pays a runtime conversion
through linear memory on every call).

## Plan

- New expression node `GCStringLiteral`, typed `__refextern`
  (non-nullable — the js-string spec types imported constants
  `(ref extern)`); decays to `__externref` like other refs.
- Surface: `__gcstr("...")` keyword builtin (pattern-match `__new`);
  argument must be a string literal; adjacent-literal concatenation
  applies (parser already concatenates). `GCSTR(s)` friendly macro.
- Lowering: one imported immutable externref global per distinct
  literal — import module **`"#"`**, import NAME = the string content;
  use sites are `global.get`. Valid in wasm constant expressions, so
  `__externref g = __gcstr("hi");` works at file scope (today ref
  globals only init to null, compiler.js:17546).
- Emitter net-new: imported globals (import kind 0x03) + the
  defined-global index-space shift (same dance as function imports,
  :13630). Off-by-N bug class — wants a targeted test with mixed
  imported + defined + mutable globals.
- host.js: add `importedStringConstants: "#"` to the existing
  compileOptions (host.js:8210; verified benign for existing binaries,
  and verified working in Node v25.8.2 by direct probe). Loaders that
  can't pass compile options get the one-line polyfill:
  `imports["#"] = new Proxy({}, {get: (_, name) => name})`.

## Acceptance

- A C program passing `__gcstr("hello")` through `wasm:js-string`
  ops (`length`, `concat`, `equals`) runs under the node host; same
  literal used twice = one import (dedup observable in the binary).
- File-scope `__externref g = __gcstr("...")` initializes correctly.
- Global index-shift test green (mixed imported/defined globals).
- Full unit + kernel suites green; browser smoke unaffected.
