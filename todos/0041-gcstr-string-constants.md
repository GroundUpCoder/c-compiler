# 0041 — `__gcstr("...")`: GC string literals via importedStringConstants

- **Status**: open
- **Depends**: — (deliberately lands BEFORE the 0042 wc fork so the fork
  inherits it; the one sanctioned main-compiler touch of the wc project)
- **Design**: `todos/WC.md` (W1; "GC string literals" decisions in
  `logs/2026-07-08/wc-round1-flags.md` still apply verbatim)

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
