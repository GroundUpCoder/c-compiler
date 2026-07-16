# 0217 — ICE cluster: compound-literal lvalues, non-lvalue diagnostics, irreducible catch-all

Three confirmed internal-compiler-error throws from the 2026-07-16 read-only
bug hunt (G9/G10/G11), batched because G9 and G10 shared one throw site —
`emitLValue`'s residual `unsupported expression` throw. Two commits:
G9+G10 (`compiler: compound-literal lvalues + sema lvalue checks`), G11
(`compiler: catch-all __catch under the irreducible dispatch loop`).

## G9 — compound literals ARE lvalues (valid code must compile)

`++(int){8}`, `(int){5} = 6` died in the raw throw; `&(int){77}` already
worked because `emitAddressOf` had the case. The fix mirrors it in
`emitLValue`: materialize the initializer into the literal's existing
backing slot (every `ECompoundLiteral` in a body already has one — the
frame-layout pass walks `referencedCompoundLiterals`; file-scope literals
get static storage) and return the slot's address as an `LV_MEMORY`
lvalue. From there `&`, assignment and ++/-- flow through the normal
lvalue machinery unchanged. Execution test clang-verified
(`core/compound_literal_lvalue`).

## G10 — non-lvalues must diagnose, not crash

Sema (this compiler types expressions at construction time, in
`makeBinary`/`makeUnary`) never checked lvalue-ness, so `5 = 3`, `++1`,
`f() = 3`, `(int)x = 5`, `RED = 5`, whole-array `a = b`, `&(x+1)` all fell
through to codegen crashes (three different throw sites: `emitLValue`,
`emitStore`, `emitAddressOf`). Now a structural `isLvalueExpr` — exactly
the shapes `emitLValue` can address (EIdent-of-DVar, member chains with
lvalue or GC-struct base, subscript, deref, compound literal, string
literal) — gates:

- assignment targets (`expression is not assignable`; array/function
  types rejected as never-modifiable, C11 6.5.16p2),
- ++/-- operands (`lvalue required as increment operand`, 6.5.3.1p1),
- unary `&` (function designators allowed, 6.5.3.2p1).

All `reportError` (collected, exit 1), not fatal — multiple errors report
per run. The residual `emitLValue` throw is now an internal-invariant
assert. Deliberately NOT added: const-qualified assignment enforcement —
that's a semantic tightening with real vendor-corpus regression risk,
separate from the ICE class this item closes.

## G11 — catch-all in the dispatch-loop lowering

The irreducible try-lowering keyed catch clauses by `cc.tag.name` — null
for a tag-less clause → TypeError. The design question was propagation:
the physical try_table wraps the WHOLE state-machine switch, so a
catch_all clause would intercept exceptions thrown in segments whose
region chain has NO catch-all (e.g. unprotected code calling a throwing
callee) — and plain wasm `catch_all` loses the exception, making rethrow
impossible.

Answer: `catch_all_ref` + `throw_ref` (same wasm EH proposal as
try_table, so engine support is a given — first use of exnref in this
compiler). The wrapper appends ONE catch-all dispatcher clause LAST
(try_table matches in order, so tagged clauses win and only unknown tags
reach it); codegen lowers it as `catch_all_ref`, captures the in-flight
exception in an `exnref` local, and the dispatcher's no-region-matches
else arm (`SThrow` with null tag) re-raises via `throw_ref` — tag and
payload propagate intact. `findDispatchEntry` treats a tag-less catch as
matching any tag (specific catches win within a region by clause order;
catch-all is last by existing constraint), which also routes KNOWN tags
into a region's catch-all through their own tagged clauses. Encoder
surface: `WT_EXNREF` (0x69), `throw_ref` (0x0A) in both body builders +
WAST serialize + the inliner's eh-scan; catch kind 0x03 already passed
through both try_table encoders untouched.

The 0216-era G4/G5 fixes (emitAggregateInitAssigns) sit in the same
lowering area — `try_catch_irreducible` and the whole exception corpus
stay green.

## Gate

- `node tests/run.js unit ast` green after each commit (conformance rides
  the unit suite; xfail counts unchanged).
- SameBoy interlock: `sum OK` — framebuffer checksums byte-identical to
  `baselines.json` AND the clang leg at N=200/600/1000
  (6.36 ms/frame cc vs 1.13 clang, 5.61x — noise-range vs the 0214
  baseline, not a perf item).
- **No mkimage/kernel/browser sweep run — decision per the gating
  policy**: only compiler.js + tests/unit moved (no os/, kernel.js,
  host.js), and the checksum interlock is byte-identical, so the fast
  gate + interlock is the sufficient gate for this layer.

## Tests added

- `tests/unit/core/compound_literal_lvalue` — clang-verified execution:
  `&`/assign/pre-post-inc-dec on scalar literals, struct literal member
  write, file-scope static literal.
- `tests/unit/conformance/diag_{assign,incdec,addr}_not_lvalue` — exit-1
  pins for every previously-crashing invalid shape.
- `tests/unit/exception/catch_all_multi` + `catch_all_irreducible` — the
  same corpus under both lowerings: known-tag-to-catch-all,
  specific-wins, nested regions both orders, and propagation through a
  frame whose regions don't handle the tag (the throw_ref path).
