# 0192 — out-of-range decimal integer constant silently typed signed (wrong arithmetic)

- **Status**: open (P1)
- **Design**: this file; found in the 2026-07-15 codegen bug hunt (/tmp/cchunt-codegen/FINDINGS.md Finding 1)
- **Regression test**: `tests/unit/conformance/decimal_oor_const_unsigned/` (pinned xfail, `config.json` `"knownBug":"0192"`)

## Goal

A DECIMAL integer constant whose value exceeds `LLONG_MAX` (9223372036854775807)
but fits in `unsigned long long` is given SIGNED `long long` type by compiler.js
(the value wraps to negative), with no diagnostic. This silently changes the
signedness of any surrounding usual-arithmetic-conversion, so arithmetic and
comparisons on the literal compute the wrong answer — "compiles and links but
computes the wrong result".

Repro:
```c
printf("cmp=%d\n",   18446744073709551615 > 0);    // clang 1  | cjs 0
printf("mod=%llu\n", 18446744073709551615 % 10);   // clang 5  | cjs 18446744073709551615
printf("sel=%llu\n", 18446744073709551615 / 2);    // clang 9223372036854775807 | cjs 0
```
- Expected (clang): `cmp=1`, `mod=5`
- Actual (compiler.js): `cmp=0`, `mod` wraps

compiler.js emits no warning or error (rc=0, empty stderr).

Well-behaved neighbors (verified, NOT bugs): HEX out-of-range constants are
handled correctly (`0xFFFFFFFFFFFFFFFF` → `unsigned long long`, because hex's
candidate list includes unsigned types). The same signed-wrap also happens for
an out-of-range decimal `LL`-suffixed literal (same class).

Severity: P1 — the input is technically ill-formed (out-of-range decimal
constant; clang accepts with `-Wimplicitly-unsigned-literal`), but real code
writes bare 64-bit sentinels/masks in decimal, and the divergence is silent +
wrong-arithmetic.

## Plan

Root-cause hypothesis: the integer-constant typing path picks `long long`
(signed) for any decimal literal that overflows `int`/`long`, without the C11
6.4.4.1p5 handling. Two acceptable fixes: (a) diagnose (the standard-required
constraint diagnostic for a value that fits no signed candidate type), or
(b) match gcc/clang and extend to `unsigned long long` with a warning. Either
removes the silent wrong answer; (b) is what the regression test encodes.

## Acceptance

- `tests/unit/conformance/decimal_oor_const_unsigned/` flips from xfail to a hard
  pass; remove its `"knownBug"` tag. (If fix (a) is chosen instead, the test
  becomes a `diag_*`-style required-diagnostic test — update it accordingly.)
- Hex out-of-range and in-range decimal literal typing unchanged.
