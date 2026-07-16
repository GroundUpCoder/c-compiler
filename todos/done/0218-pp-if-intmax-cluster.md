# 0218 — PP #if intmax cluster: ternary UAC + comparison result width

- **Status**: done (2026-07-16) — one commit (`asIntmax` retype of
  comparison/logical-`!` results + ternary common-type conversion in the PP
  evaluator; ConstEval untouched); two conformance tests added; fast gate
  green (735/0/8 xfail unchanged), SameBoy checksum interlock byte-identical
  (sum OK), no bake/kernel/sweep needed (pure preprocessor front-end). Dev
  log: `logs/2026-07-16/pp-if-intmax-0218.md`
- **Design**: CLAUDE.md "Conformance tests"; found in the 2026-07-16
  read-only bug hunt (findings G13/G14, both confirmed against clang)

## Goal

Two confirmed `#if`/`#elif` controlling-expression bugs, batched because
they're one cause: the PP evaluator didn't carry EVERY value at
intmax_t/uintmax_t width per C11 6.10.1p4.

1. **G13 — the `#if` ternary skips the usual arithmetic conversions.**
   `#if (1 ? -1 : 0u) >= 0` is TRUE per clang (the arms' common type is
   uintmax_t, so `-1` converts to a huge unsigned value); this compiler
   returned the chosen arm VERBATIM, keeping `-1` signed → FALSE.
2. **G14 — comparison / logical-`!` results are 32-bit int, not intmax_t.**
   `ConstEval.binary`/`unary` type `<`,`==`,`!` results as TINT (correct
   for expression sema, wrong in the PP): `#if ((1<2) << 31) == 2147483648`
   wrapped negative and took the wrong branch, and `#if (1<2) << 35`
   errored with "invalid operands to '<<'" (count ≥ the 32-bit width) —
   clang accepts both.

## Plan

PP-evaluator-only fix in `evaluateExpression` — ConstEval keeps int-typed
comparison results (sema/codegen correctly want C expression semantics;
6.10.1p4 is a preprocessor-only rule):

- `asIntmax(item)`: retype any non-intmax Item (always a 0/1 comparison or
  `!` result — exact retype) to TLLONG; applied to every `ConstEval.binary`
  and unary-`!` result.
- Ternary: compute the arms' common type in intmax space (either arm
  TULLONG → TULLONG, else TLLONG) and re-truncate the chosen arm's value
  into it (the Item ctor converts a negative signed arm to its unsigned
  value).

## Acceptance

- Conformance `pp_if_ternary_uac` (mixed-sign arms both directions, both
  arms signed stays signed, unsigned result type carries into a following
  `>>`) and `pp_if_cmp_intmax` (`(1<2)<<31 == 2147483648`, shift-by-35 and
  `!0 << 32` accepted and nonzero, `==`/`&&` results shift without
  wrapping) — all branches clang-pinned.
- Existing `pp_if_*` conformance corpus (intmax constants, shift promo,
  ternary associativity, short-circuit div-zero) stays green; xfail counts
  unchanged.
- SameBoy framebuffer checksum interlock byte-identical (no codegen
  change — cheap insurance only).
