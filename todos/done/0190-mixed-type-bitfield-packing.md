# 0190 — adjacent bitfields of different declared types get separate storage units (ABI layout)

- **Status**: done (P1)
- **Design**: this file; found in the 2026-07-15 frontend bug hunt (/tmp/cchunt-frontend/FINDINGS.md F2)
- **Regression test**: `tests/unit/conformance/bitfield_mixed_type_unit/` (pinned xfail, `config.json` `"knownBug":"0190"`)

## Goal

compiler.js opens a new allocation unit whenever the declared type of an
adjacent bit-field changes, instead of packing them into one shared aligned unit
(Itanium/psABI, what clang does). Diverges on `sizeof` AND `offsetof` of
following members.

Repro:
```c
struct A { char a:4; int b:4; int tail; };
printf("%zu %zu\n", sizeof(struct A), offsetof(struct A, tail));
```
- Expected (clang): `8 4`
- Actual (compiler.js): `12 8`

Broad reproduction (every mixed-type pair diverges, same-type does not):
```c
struct A{char a:4; int b:4;};              // cjs 8  clang 4
struct B{short a:8; int b:8;};             // cjs 8  clang 4
struct C{unsigned char a:4; unsigned b:4;};// cjs 8  clang 4
struct D{int a:4; char b:4;};              // cjs 8  clang 4
struct E{unsigned a:4; unsigned b:4;};     // cjs 4  clang 4  (same type OK)
```
`_Bool` bit-fields are the same root cause (`_Bool a:1; unsigned c:6;` → cjs 8,
clang 4). Values read back correctly (self-consistent within cjs); only the
ABI-visible layout diverges.

Severity: implementation-defined per ISO (6.7.2.1p11), P1 — but wrong
sizeof/offsetof breaks arrays of such structs, memcpy/serialization, and
ABI-matching with clang-built code. Same class as
[[0189-enum-bitfield-signedness]].

## Plan

Root-cause hypothesis: the struct-layout bit-field allocator keys the "current
unit" on the field's declared type and starts a fresh unit on a type change,
rather than continuing to pack while the bits fit an aligned unit of the wider
type. Continue packing across a declared-type change as long as the running bit
offset + width fits an aligned unit; the unit's alignment/size follows the widest
contributing type (psABI).

## Acceptance

- `tests/unit/conformance/bitfield_mixed_type_unit/` flips from xfail to a hard
  pass; remove its `"knownBug"` tag. The broad `struct A..E` matrix above should
  match clang.
- Same-type packing and existing bit-field value reads unchanged.
