# 0216 — struct/union layout ABI cluster: bitfield tail packing, tag-level aligned, union member alignment

- **Status**: done (2026-07-16) — all three layout passes fixed in one commit; four
  conformance tests pin the clang wasm32 numbers (differentially verified against
  native clang execution too); full core gate green, 0190/0189 stay xfail
- **Design**: CLAUDE.md "Conformance tests"; found in the 2026-07-16 read-only bug
  hunt (findings G8/G16/G17, all confirmed silent-wrong-layout on valid code)

## Goal

Three confirmed layout/ABI divergences from clang wasm32 — all silent wrong
sizeof/_Alignof/offsetof on valid code, all in the layout passes:

1. **G8 — bitfield storage unit's unused tail bytes never packed.** Closing a
   bit-field unit did `size += bfUnitSize` (the whole declared unit) instead of
   advancing past the used bits, so a following member never packed into the
   unit's tail. `struct {unsigned a:3; char c;}` → was sizeof 8 / offsetof(c) 4;
   clang: 4 / 1. (Distinct from the still-open 0190 mixed-type-unit bug, whose
   pinned numbers don't move.)
2. **G16 — struct/union-level `__attribute__((aligned(N)))` ignored** (both the
   after-keyword and after-brace positions): it landed only on the declaration's
   `requestedAlignment`, never on the tag TYPE. `struct __attribute__((aligned(8)))
   S {char c;}` → was 1/1; clang: 8/8.
3. **G17 — `_Alignas`/`aligned` on UNION members ignored.** `computeUnionLayout`
   never consulted `m.requestedAlignment` (the struct path did). `union {char c
   __attribute__((aligned(16)));}` → was 1/1; clang: 16/16.

Plus two zero-width-bitfield subtleties exposed by fixing G8 (same close path,
clang-verified): `:0` must keep its force-to-boundary effect inside a packed
struct, and it contributes NOTHING to the struct's alignment
(`struct {char a:3; int :0; char c;}` is 5/1, not 8/4).

## Plan

- `computeStructLayout`: close bit-field units by advancing `ceil(usedBits/8)`,
  not the declared unit width. Give every bit-field a narrowed RMW access window
  (`bfAccessBytes`: smallest power-of-2 bytes from the unit start covering its
  bits; 8-byte units never narrow) so packed structs — where the declared unit
  would overhang the struct — RMW only bytes the run owns; packed runs advance
  past the widest named-member window. `emitBitFieldLoad/Store` and the
  static-initializer RMW use the window.
- `parseTagSpecifier`: `max(tagAttrs.aligned, postTagAttrs.aligned)` raises
  `tagType.align` and pads `tagType.size` up to it (GCC semantics: aligned only
  increases; reduction needs packed).
- `computeUnionLayout`: mirror the struct path's
  `max(naturalAlign, m.requestedAlignment)`.

## Acceptance

- Conformance tests `bitfield_tail_packing`, `bitfield_zero_width_align`,
  `tag_aligned_attr`, `union_member_alignment` pin the clang-wasm32 numbers
  (`--target=wasm32 -Xclang -fdump-record-layouts`) + value round-trips proving
  the narrowed RMW preserves tail-packed neighbours; all four also byte-match
  native-clang execution of the same programs.
- Full core gate green (unit + conformance + ast); 0189/0190 pinned tests stay
  xfail (their numbers are unaffected); blockfs/kernel suites green; SameBoy
  checksum interlock re-run once at the end.

## Notes / conservative calls

- Packed structs whose bit-field run's used bytes are a non-power-of-2 count
  (e.g. `packed {unsigned a:17;}` — clang sizeof 3 via an i24-style access) stay
  at the power-of-2 window (sizeof 4, unchanged from before): single-load RMW
  can't do 3-byte units. Divergence documented, not a regression.
- Mixed-declared-type bit-field runs still split units — that's 0190, untouched.
- Locals of an aligned(N>16) struct type may be under-aligned on the stack (the
  over-aligned-frame machinery keys on the local's own requestedAlignment);
  statics honour any N. Same pre-existing story as over-aligned variables.
