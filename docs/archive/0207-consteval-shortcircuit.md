# 0207 — const-eval ignores &&/|| short-circuit; enum falls back silently

- **Status**: done (2026-07-16) — LAND/LOR short-circuit in constEvalItem + enumerator non-const diagnostic (no silent counter fallback); tests consteval_shortcircuit + diag_enum_nonconst; full gate green
- **Design**: compiler.js constEvalItem, CLAUDE.md "Conformance tests" (ConstEval single-implementation rule)

## Goal

`enum { C1 = 1 || 1/0 }` silently evaluated to 0: constEvalItem's EBinary
case evaluated BOTH operands (no &&/|| short-circuit — the ternary case
IS lazy), the 1/0 failed the eval, and the enum path fell back to the
running counter with NO diagnostic. Same root rejected valid
`case (1 || 1/0)+1:` and `int a[1 || 1/0];`.

## Plan

Short-circuit LAND/LOR in constEvalItem (evaluate left; a decided result
never touches the right operand — C11 6.6p3 via 6.5.13/14). And a failed
const-eval of an enumerator now diagnoses (recoverable error) instead of
silently taking the counter. Tests: conformance `consteval_shortcircuit`
(enum/case/array-size legs) + `diag_enum_nonconst`.

## Acceptance

- New tests fail before, pass after.
- Full estate green.
