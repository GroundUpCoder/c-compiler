# 0322 — Accept an empty translation unit instead of 'No tokens to parse'

- **Status**: open
- **Priority**: P1
- **Difficulty**: light
- **Design**: —
- **Provenance**: found by the `todos/0313` CPython M0 probe.

🟢 **RE-MEASURED ON MAIN `c0995358` (master cont-124, 2026-07-28) — STILL OPEN,
NOT discharged by the landed `0340`.** Direct probe with a **positive control**:
a non-empty TU compiles clean (exit 0, no diagnostics), while
`#ifdef NOPE / int x; / #endif` still errors `null:0: error: No tokens to parse`.
⚠️ **`0340` cannot have discharged this**: `0340` vendored CPython + the
**clang** binary, so CPython no longer compiles through `compiler.js` at all.
That removes this ticket's *original motivation* (the CPython critical path); it
does **not** remove the defect. Accepting an empty translation unit is required
by C and is an ordinary shape in any `#ifdef`-configurable codebase. **Re-rank if
you like, but do not close.**


## The bug

A `.c` file whose entire contents are preprocessed away errors out:

```
null:0: error: No tokens to parse
```

This is a real and ordinary shape in configurable codebases: a source file whose
body sits behind a feature `#ifdef` that is off for this target. CPython 3.13.5
has four in the core build — `Python/jit.c`, `Python/optimizer.c`,
`Python/optimizer_analysis.c`, `Python/optimizer_symbols.c` (all Tier-2 JIT,
compiled unconditionally by the Makefile and empty unless `_Py_TIER2` is set).
numpy has one (`numpy/_core/src/npymath/arm64_exports.c`).

Verified with a positive control that these really are empty rather than
mis-configured — under clang for the same target:

```
Python/optimizer.o           280 bytes, 0 defined syms
Python/jit.o                 280 bytes, 0 defined syms
Python/optimizer_analysis.o  280 bytes, 0 defined syms
Python/optimizer_symbols.o   280 bytes, 0 defined syms
Python/ceval.o (control)     176 defined syms
```

So clang emits a valid, empty object and the link is unaffected. Our compiler
makes the build fail.

Strictly, C11 6.9p1 requires a translation unit to contain at least one external
declaration, so this is a constraint violation — but every production toolchain
accepts it, and rejecting it means a port cannot use the upstream source list.

## Plan

Accept an empty token stream as an empty translation unit (contributing nothing
to the link). If the strict reading is worth preserving, make it a warning
rather than an error.

## Acceptance

- A `.c` file consisting only of `#if 0 … #endif` compiles and contributes
  nothing.
- The four CPython Tier-2 files can be left in a source list without special
  casing.
