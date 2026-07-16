# 0218 — PP #if intmax cluster: ternary UAC + comparison result width

Two confirmed `#if` evaluator bugs from the 2026-07-16 read-only bug hunt
(G13/G14), batched because they're one root cause: C11 6.10.1p4 says ALL
`#if`/`#elif` arithmetic happens at intmax_t/uintmax_t width with the usual
arithmetic conversions, and the PP evaluator leaked 32-bit-int-typed values
into that space. clang is the oracle; every branch below was pinned against
it before the fix.

## The shape of the bug

The PP evaluator (`evaluateExpression`) already carries `ConstEval.Item`s —
BigInt value + TLLONG/TULLONG type — so constants were intmax from day one
(`itemFromPPNumber`). The leaks were the OPERATOR results:

- **G14**: `ConstEval.binary` types comparison results (`<` `>` `<=` `>=`
  `==` `!=`) as TINT, and `ConstEval.unary("!")` likewise. That's CORRECT
  for expression semantics (sema/codegen const-eval — a C comparison yields
  `int`), but in the PP a TINT-typed `(1<2)` made a following `<< 31` wrap
  in 32 bits (`#if ((1<2) << 31) == 2147483648` took the wrong branch) and
  made `<< 35` outright ERROR ("invalid operands to '<<'" — shift count ≥
  the 32-bit width is declined as UB). clang: true and accepted-nonzero.
- **G13**: the ternary returned the chosen arm VERBATIM. 6.5.15p5 (via
  6.10.1p4) requires the usual arithmetic conversions between the arms:
  `#if (1 ? -1 : 0u) >= 0` is TRUE per clang — the common type is
  uintmax_t, so the chosen `-1` converts to 2^64-1.

## The fix (PP evaluator only — ConstEval untouched)

6.10.1p4 is a preprocessor-only rule, so the fix lives entirely in
`evaluateExpression`; ConstEval's int-typed comparison results stay as-is
for sema/codegen (regressing those to 64-bit would be the opposite bug):

- `asIntmax(item)`: if an Item isn't TLLONG/TULLONG, retype it to TLLONG.
  Applied to every `ConstEval.binary` result and the unary-`!` result.
  Such items are always a 0/1 comparison/logical result, so the retype is
  exact. By induction every value in the evaluator is now intmax-typed
  (constants, char constants, IDENT→0, and the PP-local `&&`/`||` already
  were).
- Ternary: common type = TULLONG if either arm is TULLONG else TLLONG;
  the chosen arm's value is re-truncated into it via the Item ctor (which
  is what converts a negative signed arm to its huge unsigned value).

The G6 short-circuit semantics (`&&`/`||`/`?:` parse-but-don't-evaluate)
are untouched — the ternary conversion happens AFTER both arms parse, on
values only.

## Tests

- `tests/unit/conformance/pp_if_ternary_uac` — G13: mixed-sign arms in
  both directions (`1 ? -1 : 0u` and `0 ? 0u : -1` both ≥ 0), both-signed
  arms stay signed (`< 0`), and the unsigned RESULT TYPE carries into a
  following shift (`((0 ? 0u : -1) >> 63) == 1` — logical, not arithmetic).
- `tests/unit/conformance/pp_if_cmp_intmax` — G14: `((1<2) << 31) ==
  2147483648`, `(1<2) << 35` and `(!0) << 32` accepted and nonzero,
  `==`/`&&` results shift past bit 31 without going negative.

Both failed before the fix exactly as the bug hunt predicted (ternary
picked the signed branch everywhere; the two wide shifts were compile
errors), pass after; the pre-existing `pp_if_*` corpus (intmax constants,
shift promotion, ternary associativity, short-circuit div-zero) stays
green.

## Gate

- `node tests/run.js unit ast` green (735 passed, 0 failed, 8 xfailed —
  unchanged, no xpass — 3 skipped; conformance rides the unit suite).
- SameBoy interlock: `sum OK` — cc and clang framebuffer checksums
  identical at N=200/600/1000, size proxies unchanged (237095 B wasm,
  97486 instrs — identical to the 0217-era numbers; 6.36 ms/frame cc vs
  1.16 clang, noise-range).
- **No mkimage/kernel/browser sweep run — decision per the gating
  policy**: this is pure preprocessor arithmetic with NO codegen change
  (compiler.js PP evaluator + tests/unit only), and the checksum interlock
  is byte-identical, so the fast gate + interlock is the sufficient gate
  for this layer (the 0217 precedent).
