# #681 — GNU elvis operator `x ?: y`

Feature-gap promoted from the #12 triage (0087 gap 3): the GNU conditional
with omitted middle operand was a parse error, and 12 sites across SameBoy
(5) and busybox `vi.c` (6) / `time.c` (1) paid for the absence as vendored
patches. Absence re-measured at `30f12ece` through the real cc driver
(probe with a positive control: plain ternary compiled, `a ?: b` errored
`Unexpected token in expression: PUNCT ':'`).

## Design: shared node + flag, single lowering authority

The load-bearing semantic is **the first operand evaluates exactly once**
(`f() ?: default` must not call `f()` twice) — the whole reason the
extension exists, and the exact shape #680 just paid for when
`__builtin_bswap*` shipped as substituting macros.

The lowering keeps ONE authority for types and constants: the parser fills
`ETernary.thenExpr` with the SAME already-`_validateCond`-decayed condition
node under the ordinary `maybeDecay`/`maybeImplicitCast` wrappers, so
`computeTernaryType` (usual arithmetic conversions, pointer/null-pointer
cases, u20 bit-field promotion per 0367), `constEvalItem` (ICE: enum
values, array bounds, case labels), `constEvalExpr` (static initializers),
and `foldExpr` all run the ternary's verbatim code — the #680 two-evaluator
trap (AST-side vs codegen-side constant eval disagreeing) is structurally
impossible because neither evaluator grew an elvis case at all; both walk
the filled-in tree, and evaluating a shared *constant* twice is harmless.

`ETernary` carries an `elvis` flag — preserved by `_withChildren` and the
`foldExpr` rebuild (the two places a rebuilt node could silently drop it).
Codegen keys on the flag: emit the condition ONCE, `local.tee` a temp of
the condition's wasm type, test the temp, and in the then arm
`local.get` + `emitConversion(cond.type, result type)` — literally the
same conversion call the `ECast` wrapper around the condition would run,
so values match the desugared ternary exactly. `thenExpr` is deliberately
NOT emitted for elvis (emitting it would evaluate the condition a second
time). The WAST inliner runs post-codegen, so single-eval is already baked
into the wasm it sees.

`printC` prints the `?:` form back out — printing the filled-in then arm
would DUPLICATE the condition's side effects in reparsed C.

## Finding: clang rejects `?:` inside `#if`

I first extended the PP `#if` evaluator too ("same positions as a normal
conditional") — and clang, the repo's conformance oracle, rejects it there:
`invalid token at start of a preprocessor expression`. The extension is a
C-expression extension, not a cpp one. Reverted; the PP ternary now carries
a note saying the omission is deliberate. Absence is honest
(todos/PRINCIPLES.md) — accepting what the oracle refuses would be an
unverifiable divergence.

## Test

`tests/unit/conformance/gnu_elvis_single_eval/` (clang-verified, committed
red-first at `0f25035c`): single evaluation asserted via an observable
counter on BOTH arms, else-arm-untouched on a truthy condition, value
correctness under `i++` operands (#680: duplication corrupts values, not
only counts), a RED CONTROL (the textual desugaring `f() ? f() : y` reads
the counter at 2 — the instrument can fail), ICE contexts, right
associativity, UAC parity with the ternary, pointer/null arms, ordinary
ternary unaffected, and `a ?: ;` / `a ? : ;` still erroring.

Out of scope by kickoff: retiring the 12 vendored patch sites (@master's
bookkeeping, collides with #684).
