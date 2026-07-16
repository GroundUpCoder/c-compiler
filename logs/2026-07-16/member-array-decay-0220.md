# 0220 — member-array decay as a static-init address constant (G15)

Confirmed finding G15 from the 2026-07-16 read-only bug hunt: at file
scope, `struct { int a; int b[4]; } s; int *pb = s.b + 2;` was rejected
("initializer element is not a compile-time constant") while the identical
address constant spelled `&s.b[2]` was accepted. clang is the oracle —
C11 6.6p9 lets an address constant be formed from an array lvalue via
array-to-pointer conversion and modified by integer +/-, so the two
spellings are the SAME constant. Every case below was pinned against clang
before the fix.

## The shape of the bug

Two holes, one root cause — the shared const-eval (`constEvalExpr`) had no
path from an ARRAY-TYPED MEMBER LVALUE to its decayed address, even though
`constEvalAddr` already resolves exactly those lvalue chains for the
`&s.b[k]` spelling:

- `constEvalExpr`'s `AST.EDecay` case just recursed into the operand.
  That only resolves a bare `EIdent` (whose case returns the global's
  address) — which is why plain top-level `arr + 1` worked. A decayed
  member (`s.b`), nested member (`t.inner.m`), or subscripted row
  (`r.rows[1]`) hit the missing-`EMember`/`ESubscript` default → null →
  rejected. This killed the scalar-global path (`int *pb = s.b + 2;`),
  zero-offset (`int *p = s.b;`), and static locals.
- Init-list elements carry NO `EDecay` wrapper at all (`normalizeInitList`
  doesn't insert casts/decays — only the scalar-init path calls
  `maybeDecay`), so `int *ps[2] = { s.b + 1, s.b };` reached the
  data-section emitter (`populateInitListStatic`) with a RAW array-typed
  `EMember` as the second element. Fixing EDecay alone left that one
  failing — the repro's aggregate leg caught it.

## The fix (shared const-eval only — compiler.js, two cases)

- `EDecay`: try the operand as a value first (bare idents, functions,
  strings — byte-identical to the old behavior), then fall back to
  `constEvalAddr(operand)`: an array lvalue's decay IS the address of its
  first element (base symbol + member offset). Both spellings now fold
  through the one existing addr-arithmetic path, so `s.b + 2` and
  `&s.b[2]` produce the identical address by construction.
- New `EMember`/`EArrow`/`ESubscript` case: an ARRAY-typed lvalue used as
  a value is an implicit decay → `constEvalAddr(expr)`. Gated on
  `expr.type.isArray()` — non-array lvalues stay non-constant (a global's
  STORED value is runtime state; clang rejects `int x = s.a;` at file
  scope and so do we, unchanged).

Both backends share the evaluator; the GUC backend's null policy makes the
new paths return null there, same as every other address leaf.

## Tests

Conformance `static_init_member_array_decay` (committed failing first,
test-first per the repo discipline): decay-vs-`&[]` twin identity for
member / zero-offset / nested-member / subscripted-row / plain-array
shapes, a net `s.b + 3 - 2` offset, the aggregate (data-section) init
path, a static local, and the runtime block-scope expression as a
no-regress guard — execution-checked (each pointer dereferences to the
value stored at runtime). Before the fix: 8 rejections across the file;
after: output matches clang exactly.

## Gate

- `node tests/run.js unit ast` green (739 passed — 738 + the new test —
  0 failed, 8 xfailed unchanged, no xpass, 3 skipped; conformance rides
  the unit suite).
- SameBoy interlock, strongest form: the emitted wasm is BYTE-IDENTICAL
  (`cmp` clean, 237095 B) between the pre-change compiler (HEAD build)
  and the fixed one over the full 15-file SameBoy core build, and
  framebuffer checksums equal clang's at N=200/600/1000 (70866000 /
  bd26bb7b / 42d967fd — identical to the 0219-era numbers).
- **No mkimage/kernel/browser sweep run — decision per the gating
  policy**: front-end const-eval only; the new paths only trigger on
  initializers that previously FAILED to compile (no vendor code
  exercises them — it all builds under clang/gcc upstream), and the
  interlock is byte-identical, so the fast gate + interlock is the
  sufficient gate for this layer (the 0217/0218/0219 precedent).
