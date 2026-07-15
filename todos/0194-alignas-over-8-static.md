# 0194 — _Alignas(N>8) rejected for statics; statement-position __attribute__((aligned)) not parsed

- **Status**: open (P2)
- **Design**: this file; found in the 2026-07-15 frontend bug hunt (/tmp/cchunt-frontend/FINDINGS.md F5)
- **Regression test**: `tests/unit/conformance/alignas_over8_static/` (pinned xfail, `config.json` `"knownBug":"0194"`)

## Goal

Two related alignment gaps:

1. **Primary (the pinned test):** `_Alignas(N)` with N > 8 is rejected even for
   STATIC storage, where an over-aligned object in the data section is trivially
   representable. compiler.js caps `_Alignas` at 8 regardless of storage class
   ("exceeds maximum supported alignment of 8"); clang accepts it.
   ```c
   _Alignas(32) char g[4];   // global/static
   // compiler.js: compile error; clang: fine, g is 32-byte aligned
   ```
   - Expected (clang): compiles, `(uintptr_t)&g % 32 == 0` → `1`
   - Actual (compiler.js): compile error (rejects-valid)

2. **Companion (documented, not separately pinned):** statement-position
   `__attribute__((aligned(16)))` written before a *local* declaration fails to
   parse ("Unexpected token ... KEYWORD '__attribute__'"), though the attribute
   is accepted in other positions.

Severity: P2 — both are diagnosed (not silent). The 8-byte cap is defensible for
*automatic* storage (max wasm stack alignment), but a static's alignment is a
link-time data-section property.

## Plan

Root-cause hypothesis: the `_Alignas` handler enforces a global max-alignment
cap of 8 without distinguishing storage class. Fix: allow larger alignments for
static/global storage (place the datum in the data section at the requested
alignment); keep (or relax as feasible) the cap for automatic storage. Separately
accept `__attribute__((aligned(...)))` in statement/declaration-leading position
for locals.

## Acceptance

- `tests/unit/conformance/alignas_over8_static/` flips from xfail to a hard pass;
  remove its `"knownBug"` tag.
- Automatic-storage `_Alignas` behavior unchanged (or documented if relaxed);
  the companion statement-position attribute parse is a follow-up sub-task.
