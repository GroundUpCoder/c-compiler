# 0217 — ICE cluster: compound-literal lvalues, non-lvalue diagnostics, irreducible catch-all

- **Status**: open
- **Design**: CLAUDE.md "Conformance tests"; found in the 2026-07-16 read-only
  bug hunt (findings G9/G10/G11, all confirmed raw internal-compiler-error
  throws — two on valid C11, one on invalid code that must diagnose)

## Goal

Three confirmed ICEs, batched because G9/G10 share one throw site
(`emitLValue`'s residual `unsupported expression` throw):

1. **G9 — compound literal as lvalue → raw ICE on LEGAL C11.** `++(int){8}`,
   `(int){5} = 6`, and assignment through a compound literal all died in
   `emitLValue: unsupported expression ECompoundLiteral`. C11 6.5.2.5p4: a
   compound literal IS an lvalue (modifiable if its type is); clang accepts
   all three. (`&(int){77}` already worked — `emitAddressOf` had the case.)
2. **G10 — invalid lvalues ICE instead of DIAGNOSING.** `5 = 3`, `++1`,
   `f() = 3`, `(int)x = 5`, `RED = 5` (enum constant), `a = b` (whole
   array), `&(x+1)` — sema never checked lvalue-ness of assignment /
   inc-dec / `&` targets, so they all fell through to the same raw throw
   (or `emitStore`/`emitAddressOf` crashes).
3. **G11 — catch-all `__catch` in an irreducible-lowered function →
   TypeError ICE.** The dispatch-loop try-lowering did
   `tryCtx.tags.set(cc.tag.name, …)` with `cc.tag === null` for a tag-less
   clause. Repro: `tests/unit/exception/catch_all` + `--force-dispatch-loop`.

## Plan

- **G9**: `emitLValue` grows the `ECompoundLiteral` case, mirroring
  `emitAddressOf`: materialize the initializer into the literal's existing
  backing slot (frame slot at block scope, static allocation at file scope)
  and yield the slot's address as an `LV_MEMORY` lvalue.
- **G10**: structural `isLvalueExpr` predicate in sema (EIdent-of-DVar,
  EMember with lvalue base or GC-struct base, EArrow, ESubscript, deref,
  compound literal, string literal — exactly the shapes `emitLValue` can
  address). `makeBinary` rejects non-lvalue / array / function assignment
  targets ("expression is not assignable"); `makeUnary` rejects non-lvalue
  ++/-- operands ("lvalue required as increment operand") and non-lvalue,
  non-function-designator `&` operands. `emitLValue`'s residual throw
  becomes an internal-invariant assert.
- **G11**: catch-all clauses stop being keyed into `tryCtx.tags` (they have
  no tag); `findDispatchEntry` treats a tag-less catch as matching any tag
  (specific catches win within a region by clause order — catch-all is
  last by constraint). The wrapper appends one physical `catch_all_ref`
  dispatcher clause (last, so tagged clauses win) which captures the
  in-flight exception as an `exnref` local; its no-region-handles else arm
  rethrows via `throw_ref`, so unknown-tag exceptions from callees still
  propagate with payload intact. New encoder surface: `WT_EXNREF`,
  `throw_ref` (0x0A) in both body builders + WAST serialize, catch kind
  0x03 (both encoders already pass it through).

## Acceptance

- `tests/unit/core/compound_literal_lvalue` (clang-verified execution:
  `&`/assign/++/--, struct literal, file-scope static literal) green.
- Conformance `diag_assign_not_lvalue` / `diag_incdec_not_lvalue` /
  `diag_addr_not_lvalue` pin exit-1 diagnostics.
- `tests/unit/exception/catch_all_irreducible` runs the catch-all corpus
  under `--force-dispatch-loop`: known-tag caught by catch-all, catch-all
  alongside tagged catches, nested regions, and propagation THROUGH an
  irreducible frame whose regions don't handle the tag (the throw_ref
  path); plain `catch_all` stays green (G4/G5 fixes untouched).
- Full core gate green (unit + conformance + ast); SameBoy framebuffer
  checksum interlock byte-identical (compound-literal + try lowering are
  codegen-adjacent).
