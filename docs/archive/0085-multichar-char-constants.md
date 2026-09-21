# 0085 — Multi-character char constants: GCC packing semantics

- **Status**: done (2026-07-10) — narrow multi-char constants now pack
  GCC-style (big-endian, int32 wrap, last 4 kept) in both the lexer CHAR→INT
  resolution and the preprocessor `#if` evaluator via one shared
  `narrowCharConstValue` helper; single-char behavior (incl. signed-char
  0x80..0xFF) unchanged; wide constants untouched. Clang-verified
  conformance test `multichar_char_const`; full unit suite green.
- **Design**: this file. Found during the `0075` SameBoy compile probe;
  slotted ahead of it because SameBoy live code depends on the values.

## Goal

`'SAME'`, `'GBS\x01'`, `'TPP1'` currently evaluate to the FIRST character
only (0x53, 0x47, 0x54) — silently, no diagnostic. GCC/clang pack the
characters big-endian into an `int`: `'SAME'` == 0x53414D45. C11 6.4.4.4p10
makes the value implementation-defined, but every real compiler agrees on
the packing, and real-world code (SameBoy save-state/GBS/ISX/TPP1 magics,
FourCC-style constants generally) relies on it. Silently producing a
different value is a miscompile in practice.

## Plan

- Both char-constant evaluation sites (the lexer CHAR→INT resolution and
  the preprocessor `#if` evaluator) accumulate `v = (v << 8) | (c & 0xFF)`
  over all characters of a narrow constant, wrapping in int32 (GCC keeps
  the last 4 on overflow). Single-character behavior is unchanged,
  including the signed-char 0x80..0xFF adjustment (which must NOT apply to
  multi-char constants — GCC doesn't).
- Wide constants (`L'..'`/`u'..'`/`U'..'`) keep single-codepoint semantics.
- Conformance test with clang-verified golden, incl. `#if` use.

## Acceptance

- `tests/unit/conformance/multichar_char_const` passes (clang-verified).
- Full unit suite stays green.
