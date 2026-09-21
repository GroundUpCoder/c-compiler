# 0187 — volatile accesses must not be linearity-UNRESTRICTED (inliner duplicates/drops volatile reads)

- **Status**: done (2026-07-15; volatile accesses classify LINEAR at EIdent/OP_DEREF/ESubscript/EMember/EArrow — inliner refuses, reads back to exactly-once (was 2 dup / 0 drop); bench code section byte-identical; log: logs/2026-07-15/volatile-linearity-0187.md)
- **Design**: —

## Goal

P0 miscompile (C11 5.1.2.3 — volatile access count/order is observable
behavior), documented in `todos/CONFORMANCE-REMAINING.md` §compiler.js:
the substructural linearity system classifies ALL memory-access
expressions as UNRESTRICTED (pure, duplicable, droppable) with an
explicit "no volatile model" comment. Consequences:

- `int twice(int x){ return x + x; }` then `twice(*vp)` (vp a pointer to
  volatile) inlines to `*vp + *vp` — TWO volatile reads where C requires
  the argument be evaluated exactly once.
- `void ignore(int x){}` (single-return form `{ return; }` aside, any
  inlineable shape) with `ignore(*vp)` substitutes the unused arg away —
  ZERO reads where C requires exactly one.

Matters for tinyemu-class MMIO code; must land BEFORE the planned
inlining-aggressiveness increase (0186's Stage A) that would amplify it.

## Plan

When the accessed lvalue's type is volatile-qualified, classify the
access LINEAR (must evaluate exactly once, in order) instead of
UNRESTRICTED, at each memory-access constructor:

- `EIdent` — a volatile-qualified decl (`volatile int g; g`).
- `EUnary OP_DEREF` — deref whose result type is volatile (`*vp`,
  `*(volatile int *)ADDR`).
- `ESubscript` — volatile element type; `makeSubscript` also propagates
  a volatile qualifier from a volatile-qualified array TYPE (typedef'd
  array under `volatile`, C11 6.7.3p9) onto the element type.
- `EMember` / `EArrow` — the member's own type volatile, OR the base
  aggregate volatile (`s.f` with `volatile struct S s` — covered by the
  EIdent join, checked locally too) / base pointee volatile
  (`p->f` with `volatile struct S *p` — member types do NOT inherit the
  base's qualifiers in makeArrow, so the constructor must look at the
  base).

Strictly scoped to the VOLATILE qualifier — non-volatile memory reads
stay UNRESTRICTED (blanket-downgrading would kill legitimate inlining).
tryInline then refuses these calls naturally (its args-UNRESTRICTED
guard); the call stays a real call and the access happens exactly once.

## Acceptance

- Failing-first tests in `tests/ast/test_ast.js` (the linearity +
  INLINER home): linearity tagging for every volatile access shape,
  non-volatile counterparts stay UNRESTRICTED, `twice(*vp)` /
  `ignore(*vp)`-class calls not inlined, non-volatile twins still
  inline.
- Full estate green: unit corpus (conformance included), ast suite,
  image bake, kernel spot checks per `tests/run.js --diff`.
- `tests/bench` SameBoy bench does not meaningfully regress vs the
  0186 baseline (cc 5.697 ms/frame) — volatile helpers are rare, but
  confirm, don't assume.
- CONFORMANCE-REMAINING.md item struck.
