# 0193 — commutative subscript N[arr] rejected (valid C11 6.5.2.1p2)

- **Status**: done (P2)
- **Design**: this file; found in the 2026-07-15 frontend bug hunt (/tmp/cchunt-frontend/FINDINGS.md F4)
- **Regression test**: `tests/unit/conformance/subscript_commutative/` (pinned xfail, `config.json` `"knownBug":"0193"`)

## Goal

`E1[E2]` ≡ `*(E1+E2)`; addition is commutative, so `1[arr]` is standard C equal
to `arr[1]`. compiler.js rejects it deliberately (compiler.js ~line 4937,
"Commutative subscript ... is not supported; write arr[0] instead").

Repro:
```c
int arr[3] = {1,2,3};
printf("%d\n", 1[arr]);   // clang: 2 ; compiler.js: parse error
```
- Expected (clang): `2`
- Actual (compiler.js): parse error (rejects-valid; three cascading errors)

Severity: P2 — rejects-valid, rare idiom, but appears in obfuscated/portable
code. Cleanly diagnosed, not a crash.

## Plan

Root-cause hypothesis: the array-subscript parse/sema at ~compiler.js:4937
requires the base operand to be the array/pointer and rejects the
integer-first form. Fix: in the subscript sema, if the left operand is integer
and the right is array/pointer, swap them (subscript is defined as
`*(E1+(E2))`, symmetric) before the pointer-arithmetic lowering — mirroring how
`arr[1]` is handled.

## Acceptance

- `tests/unit/conformance/subscript_commutative/` flips from xfail to a hard
  pass; remove its `"knownBug"` tag.
- Normal `arr[i]` and pointer-form `(arr+1)[1]` unchanged.
