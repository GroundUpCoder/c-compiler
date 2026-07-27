# 0189 — enum bitfield with all-non-negative enumerators is read signed (wrong value)

- **Status**: done (P1)
- **Design**: this file; found in the 2026-07-15 frontend bug hunt (/tmp/cchunt-frontend/FINDINGS.md F1)
- **Regression test**: `tests/unit/conformance/bitfield_enum_signedness/` (pinned xfail, `config.json` `"knownBug":"0189"`)

## Goal

An `enum` bit-field whose enum has only non-negative enumerators is read back
SIGNED (sign-extended) by compiler.js, yielding a wrong observed value. clang
gives the enum bit-field an unsigned underlying type and zero-extends it. This
is a wrong observed VALUE, not just a layout difference.

Repro:
```c
enum NN { A0, A1, A2, A3 };            // all >= 0
struct S { enum NN x:2; } s; s.x = A3; // 3 == binary 11
printf("%d\n", s.x);
```
- Expected (clang): `3`
- Actual (compiler.js): `-1`

Cross-checks: an enum with a negative enumerator (`enum{B=-1,...}`) is signed in
both; a wide-enough field (`:3`) reads 3 in both — so the divergence is exactly
the signedness of the bit-field underlying type for all-non-negative enums.

Severity: this is implementation-defined per ISO (6.7.2.2p4 — the enum's
compatible type is impl-defined; clang/gcc pick `unsigned int` when every
enumerator is >= 0), so filed P1 rather than P0 — but it silently corrupts the
value for any packed enum-bitfield struct (protocol headers, flag words) and
diverges from the clang wasm32 ABI compiler.js otherwise tracks (same class as
[[0190-mixed-type-bitfield-packing]]).

## Plan

Root-cause hypothesis: the bit-field read path always sign-extends non-`unsigned`
declared field types; enum fields should follow the enum's compatible type,
which clang makes `unsigned int` when every enumerator is >= 0. Pick the read
extension (sign vs zero) from the enum's chosen compatible-type signedness, not
from "declared type is not literally `unsigned`".

## Acceptance

- `tests/unit/conformance/bitfield_enum_signedness/` flips from xfail to a hard
  pass; remove its `"knownBug"` tag so it becomes a permanent regression guard.
- Negative-enumerator and wide-field cases still read correctly.
