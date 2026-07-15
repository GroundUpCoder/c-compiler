# 0203 — ++/-- on void* is a silent no-op (stride 0)

- **Status**: open
- **Design**: tests/unit/conformance/void_ptr_arith (the existing +/- clamp), CLAUDE.md "Conformance tests"

## Goal

`void *q = b; q++;` compiles to `q += 0` — the pointer doesn't move
(pre/post, ++/-- all affected). `p + 1` and `p += 1` already honour the
GNU stride-1 extension via `ptrArithElemSize`, so mixed code silently
walks wrong. clang/gcc move by 1 byte.

## Plan

`emitIncDec`'s pointer delta uses raw `sizeOf(baseType)` (0 for void)
instead of the `ptrArithElemSize` clamp that every other pointer-arith
site goes through. Route it through the clamp; pin a conformance test
(`void_ptr_incdec`) covering all four operators, differential vs clang.

## Acceptance

- New conformance test fails before, passes after.
- Full estate green.
