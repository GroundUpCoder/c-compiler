# 0220 — static-init address constant: member-array decay + offset (G15)

- **Status**: open
- **Design**: CLAUDE.md "Conformance tests"; found in the 2026-07-16
  read-only bug hunt (finding G15, confirmed against clang)

## Goal

`struct { int a; int b[4]; } s; int *pb = s.b + 2;` at file scope is
rejected ("initializer element is not a compile-time constant") while the
identical address constant spelled `&s.b[2]` is accepted. clang accepts
both — C11 6.6p9 lets an address constant be formed from an array lvalue
via array-to-pointer conversion and modified by integer +/-, so `s.b + k`
and `&s.b[k]` are the SAME constant. Zero-offset `int *p = s.b;`, nested
members (`t.inner.m + 3`), subscripted rows (`r.rows[1] + 1`), aggregate
element positions (`int *ps[2] = { s.b + 1, s.b };`), and static locals all
fail the same way; plain top-level decay (`arr + 1`) already works.

Cause: `constEvalExpr`'s `AST.EDecay` case just recurses into the operand,
which only resolves for a bare `EIdent` (the ident case returns the
global's address). There is no `EMember`/`ESubscript` case in
`constEvalExpr`, so a decayed member-array lvalue evaluates to null — even
though `constEvalAddr` already resolves exactly those lvalue chains for the
`&s.b[k]` spelling.

## Plan

In the shared const-eval (`constEvalExpr`, the EDecay case): when the
operand doesn't const-eval as a value, fall back to `constEvalAddr` on it —
an array lvalue decays to the address of its first element, i.e. `s.b` IS
`&s.b[0]` (base symbol + member offset). Strictly additive: everything that
resolved before still takes the value path first, so `arr + 1`, function
decay, and string decay are byte-identical. Both spellings then fold
through the one existing addr-arithmetic path, so `s.b + 2` and `&s.b[2]`
produce the identical address/offset by construction.

## Acceptance

- Conformance `static_init_member_array_decay` (clang-pinned): decay-vs-&[]
  twins for member / zero-offset / nested / subscripted-row / plain-array
  shapes, net +/- offsets, the aggregate (data-section) init path, a static
  local, and the runtime block-scope expression as a no-regress guard —
  execution-checked (pointers dereference to values stored at runtime).
- `node tests/run.js unit ast` green, xfail counts unchanged; SameBoy
  interlock byte-identical (front-end const-eval only — no
  bake/kernel/sweep).
