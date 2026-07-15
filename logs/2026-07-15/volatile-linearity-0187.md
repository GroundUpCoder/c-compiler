# 0187 — volatile accesses must not be linearity-UNRESTRICTED

P0 miscompile, fixed test-first. Had to land before the inlining-
aggressiveness increase (0186 Stage A) that would amplify it.

## The bug

The substructural linearity system (compiler.js ~3443) classified every
memory-access expression UNRESTRICTED — pure, duplicable, droppable —
with an explicit "no volatile model" comment. tryInline's two guards
(`returnExpr` UNRESTRICTED, every arg UNRESTRICTED) therefore let
volatile reads through:

- `static volatile int mmio; twice(mmio)` with `twice(x){return x+x;}`
  inlined to `mmio + mmio` — **2 volatile reads** where C11 5.1.2.3
  requires the argument be evaluated exactly once.
- `ignore(mmio)` with `ignore(x){return 0;}` folded to `EInt(0)` —
  **0 reads** where C requires exactly 1.

Both reproduced on main at HEAD before the fix (AST-level read counts
2 and 0 respectively). Matters for tinyemu-class MMIO code; invisible
to stdout goldens (duplicated reads of plain memory return the same
value), which is why the conformance corpus never caught it.

## The fix (494c802)

One helper, `_accessLinearity(type)`: volatile-qualified accessed type →
LINEAR, else UNRESTRICTED. Applied at each memory-access constructor,
keyed STRICTLY on the volatile qualifier so non-volatile reads keep
inlining:

- **EIdent** — volatile decl (`volatile int g`).
- **EUnary OP_DEREF** — the result type IS the accessed object's type
  (computeUnaryType returns the pointee), so `*vp` and the MMIO idiom
  `*(volatile int *)0x1000` both classify LINEAR.
- **ESubscript** — volatile element type; `makeSubscript` additionally
  pushes a volatile qualifier sitting on the array TYPE down onto the
  element (C11 6.7.3p9 — only reachable via `typedef int A[4];
  volatile A a;`, where parseDeclSpecifiers quals the ArrayType itself).
- **EMember / EArrow** — the member's own type, OR the base aggregate /
  base pointee volatile. Load-bearing: makeMember/makeArrow build the
  member expr with `m.type` verbatim — member types do NOT inherit the
  base's qualifiers — so `p->f` with `volatile struct S *p` is invisible
  from the member type alone. (`s.f` with volatile `s` is also covered
  by the EIdent join bubbling up, but the constructor checks locally
  too — belt and braces for synthesized trees.)

The inliner needed zero changes — its existing UNRESTRICTED guards now
refuse these calls, the call stays real, the access happens exactly
once, in order. Writes/incdec were already LINEAR via op metadata.

Consciously accepted pessimization: EIdent of a volatile AGGREGATE is
LINEAR even where the use is only an address-take (`f(&vs)`) — OP_ADDR
was already AFFINE (refused) so nothing regresses in practice, and
volatile aggregates are rare.

## Tests

`tests/ast/test_ast.js` (the linearity + INLINER home) grew a
volatile-linearity block, committed FAILING first (61c2091): linearity
tagging for all five access shapes + non-volatile twins, the dup/drop
inliner refusals with AST-level read counts (before: 2 and 0; after:
1 and 1), the body-side refusal (`getmmio()` never inlines), and the
no-blanket-downgrade control (`twice(g)` still inlines to `g + g`,
`id(*p)` still inlines). No conformance-corpus dir: the miscompile is
unobservable in stdout (needs real MMIO), so the AST tests where the
transform lives are the honest pin.

## Gates (all foreground, all green)

- unit (conformance corpus included): 715 passed, 0 failed, 3 skipped
- ast: 135 passed, 0 failed
- blockfs: 15 passed (fuzz included)
- kernel: 73 passed, 0 failed — includes the fresh image bake with the
  patched compiler (mtime gate re-baked; every vendor project compiled
  clean)
- **SameBoy bench** (`tests/bench/run.js`): cc 5.789 ms/frame vs the
  0186 baseline 5.697 (+1.6% wall = noise); static proxies BYTE-
  IDENTICAL to baseline — 281051 B wasm, 120084 instrs, code 234546 B —
  so the generated code did not change on this workload (SameBoy's
  volatile uses never hit the single-return inline shape); checksum
  interlock vs clang OK.
