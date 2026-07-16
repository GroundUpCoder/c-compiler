# 0216 — struct/union layout ABI cluster (G8/G16/G17 from the bug hunt)

Fixed three confirmed silent-wrong-layout bugs (clang wasm32 is the ABI oracle,
verified shape-by-shape with `clang --target=wasm32 -Xclang
-fdump-record-layouts` — the frontend computes wasm32 record layout even
without the backend installed):

| bug | shape | before | clang/after |
|-----|-------|--------|-------------|
| G8  | `struct {unsigned a:3; char c;}` | 8/4, c@4 | 4/4, c@1 |
| G8  | `struct {unsigned a:3; char c; short s;}` | 8/4, s@6 | 4/4, c@1 s@2 |
| G8  | packed `{unsigned a:3; char c;}` | 5/1, c@4 | 2/1, c@1 |
| G16 | `struct __attribute__((aligned(8))) {char c;}` (both positions) | 1/1 | 8/8 |
| G17 | `union {char c __attribute__((aligned(16)));}` | 1/1 | 16/16 |

## The interesting part: G8's fix needs a codegen amendment

Advancing the unit close by `ceil(usedBits/8)` (instead of the whole declared
unit) is the layout fix, but bit-field access is a declared-type-width RMW at
the unit start. In a NON-packed struct that window is provably in-bounds (the
struct's final align-up covers it — every declared int type on wasm32 has
align == size). In a PACKED struct it isn't: packed `{unsigned a:3; char c;}`
is sizeof 2 and a 4-byte RMW would touch memory the struct doesn't own — in an
array, the neighbouring element (value-preserved by the RMW, but a data race
in principle and a trap risk at the end of linear memory); in static data, the
NEXT global's bytes at bake time.

So layout now assigns every bit-field a narrowed access window
(`bfAccessBytes`: the smallest power-of-2 byte count from the unit start
covering the member's bits — what clang's IRgen does with StorageSize;
8-byte units never narrow so the i64 access path keeps its type domain), and
packed runs advance past the widest named-member window.
`emitBitFieldLoad/Store` and the static-initializer RMW honour it. Unions
fall back to the declared width (windows unset there — always in-bounds since
the union is at least as big as the declared type).

Conservative call: packed runs with a non-power-of-2 used-byte count (packed
`{unsigned a:17;}` — clang does an i24-style 3-byte access, sizeof 3) keep the
power-of-2 window and stay sizeof 4, exactly as before this change. A 3-byte
RMW needs a two-load composite; no corpus consumer, not worth it.

## Zero-width bit-fields: two more clang rules, same close path

Probing `:0` shapes for the G8 test surfaced two adjacent divergences (fixed
in the same hunk, pinned in `bitfield_zero_width_align`):

- `:0` contributes NOTHING to the struct's alignment: clang says
  `struct {char a:3; int :0; char c;}` is **5/1** (we said 8/4 — the `:0`'s
  int leaked into maxAlign).
- packed does NOT neuter `:0`: clang keeps the force-to-boundary effect
  (packed `{unsigned a:3; int :0; char c;}` is 5/1, c@4). The OLD full-unit
  advance got this shape right by accident; the new close honours it
  explicitly by aligning to the `:0`'s natural (never packed-clamped) type
  alignment.

## G16/G17 were plumbing, not policy

- G16: `parseTagSpecifier` parsed `aligned` in both tag positions but only
  `packed` was consumed; the value now raises `tagType.align` and pads
  `tagType.size` (GCC semantics: aligned only increases). Statics honour any
  N (the data-section allocator aligns arbitrarily) — verified by address
  asserts in the test.
- G17: `computeUnionLayout` simply never read `m.requestedAlignment`;
  mirrored the struct path's `max(naturalAlign, requested)`. Also fixes the
  union's SIZE (rounds up to the raised alignment — `union {char c[6]
  __attribute__((aligned(4)));}` is 8/4, was 6/1).

## Verification

- Four conformance tests pin the clang numbers AND value round-trips (RMW
  must preserve a tail-packed neighbour in both directions, packed-array
  elements must not bleed into each other, static inits of shared units).
  All four programs also compile+run **byte-identical under native clang**.
- 0190 (mixed-type units) and 0189 (enum bit-field signedness) pinned xfails:
  numbers unaffected, still xfail — no accidental xpass, no re-litigation.
- Gates: unit (734: 723 pass / 8 xfail / 3 skip) + ast green; blockfs +
  kernel suites green; SameBoy image checksum byte-identical (pure front-end
  layout change; no vendored source uses the diverging shapes) — full bake +
  browser sweep skipped per the gating policy, decision recorded here.
