# #686 — elvis codegen: cover the RUNTIME arm conversions

**Ticket:** #686 (quality-gap, test coverage — no defect demonstrated, and none
found). **Change:** `tests/unit/conformance/gnu_elvis_single_eval` only;
`compiler.js` untouched.

## The gap, re-measured at `1762bff5`

#681's elvis codegen (`compiler.js:20678-20692`) bypasses the parser's cast
wrapper on the shared condition node and hand-rolls both arm conversions behind
identity guards (`expr.condition.type !== expr.type` at 20686,
`expr.elseExpr.type !== expr.type` at 20689). The fold claim from the ticket is
confirmed: `foldExpr`'s `ETernary` case (`compiler.js:6124-6137`) returns the
folded live branch whenever the condition const-evaluates (line 6131), so every
mixed-type case in the pre-existing test (`1 ?: 2LL`, `0 ?: 1.5`, `0u ?: -1`,
`0 ?: 1.0f`, the static initializers) folds before codegen — and every
non-constant-condition case had matching arm/result types. Neither hand-rolled
conversion was exercised with differing types.

## What landed

New `rt`/`rte`/`rtn` legs, clang-oracled (`clang -std=c11`, values asserted):

- **then arm** (the ticket's point): `int -> long long` widening, with the
  discriminating values — a negative int must SIGN-extend (`-3`, a zero-extend
  prints 4294967293) and an unsigned must ZERO-extend (`4294967295`, a
  sign-extend prints -1) — plus `int -> double`.
- **else arm**: `int -> long long` and `int -> double` conversions executed at
  runtime, plus else-taken past an emitted-but-skipped then-conversion.
- **single evaluation across a conversion**: `f() ?: 6LL` still counts one call.

## Positive control (why the legs provably reach the path)

A temporary probe (appendFileSync at both conversion sites, reverted before
commit — `git status` clean on compiler.js) logged during a filtered unit run:
`THEN-conv` fired for all four `rt` legs + `ee` + `sc`; `ELSE-conv` fired for
the `ev` leg. No manufactured pass: the probe is the reach evidence, clang the
value oracle.

## Finding (not a defect): the else-arm hand-rolled site is nearly dead

The probe initially showed `ELSE-conv` firing NOWHERE: the parser wraps the
else operand in `maybeImplicitCast(elseExpr, resType)` (`compiler.js:12771`),
so by codegen the else node's type IS the result type and 20689's identity
guard is false — the value-changing else conversions run inside
`emitExpr(elseExpr)` through the `ECast` case (20663-20666). The ONE shape that
reaches 20689 is a qualifier-distinct operand: `maybeImplicitCast` compares
`removeQualifiers()`'d types (line 4979) and declines the wrap for e.g.
`volatile int` vs `int`, leaving distinct type objects. The new
`ev = x0 ?: v` leg pins exactly that shape (a representation no-op, but the
site executes). Values matched clang in every case — no `ECast`-path mismatch,
nothing to escalate.
