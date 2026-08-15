# #687 — offsetof nested/anonymous/subscript designators fold to an ICE

## The measurement (re-derived on this lane, base `d05d487f`)

Probes: `offsetof` as an array bound, which forces the integer-constant-
expression fold. Positive control included so a broken instrument can't
report a spurious absence.

| probe | designator | before | after |
|---|---|---|---|
| plain (control) | `offsetof(struct S, b)` | ✅ compiles | ✅ |
| nested named | `offsetof(struct S, inner.m)` | ❌ "variable-length arrays are not supported" | ✅ |
| anonymous union | `offsetof(struct S, m)` | ❌ same | ✅ |
| anonymous struct | `offsetof(struct S, m)` | ❌ same | ✅ |

Anonymity was never the discriminator — any designator beyond a single
plain member failed. clang `-std=c11` (the repo oracle) accepts all four;
governing contract C11 §7.19p3 (`offsetof` expands to an integer constant
expression) — a `contract-violation` per `todos/PRINCIPLES.md`.

## The mechanism (cited at `d05d487f`)

`offsetof` is one macro (`compiler.js:25675`):
`((size_t)&((type *)0)->member)`. There is no builtin; the defect was in
the typed ICE evaluator. `constEvalItem`'s `OP_ADDR` case
(`compiler.js:5926-5935`) peeled exactly ONE `EArrow`/`EMember` level by
const-evaluating `inner.base` as a *value*. But `makeArrow`/`makeMember`
(`compiler.js:5637`/`5605`) build nested and anonymous designators as
CHAINS of member nodes — `lookupMemberChain` emits one link per anonymous
hop — and a member access has no constant value, only a constant
*address*, so `constEvalItem(inner.base)` returned null for every chain
deeper than one link. The bound didn't fold; the parser
(`compiler.js:14014`) then blamed VLAs — a misleading diagnostic that sent
readers to `__STDC_NO_VLA__` instead of the fold.

Key asymmetry that shaped the fix: the repo has TWO constant evaluators,
and only one was broken. The static-initializer address-constant evaluator
(`constEvalAddr`, `compiler.js:17383`) already walked full
`EDecay`/`EArrow`/`EMember`/`ESubscript` chains — which is why
`offsetof(T, data[3])` worked in a static initializer
(`tests/unit/core/offsetof_static_init/`) while the same expression as an
array bound was rejected.

## The fix

New `constEvalAddrInt(e)` beside `constEvalItem`: the BigInt
address-constant view of an lvalue (C11 6.6p9), deliberately mirroring
`constEvalAddr`'s proven shape — `EDecay` unwraps, `EArrow` = base value +
offset, `EMember` = base address + offset (recursive), `ESubscript` = base
address + index × `sizeofResult()`, with a general fallback to a constant
pointer *value* (the `(T *)0` cast at the bottom of every offsetof chain —
this also subsumes the old one-level behavior exactly). `OP_ADDR` in
`constEvalItem` now delegates to it. Subscripted designators
(`arr[2].m`) fold in ICE contexts too — C11 §7.19's designator grammar
includes them, and the static path already supported them, so the ICE path
matching it is parity, not gold-plating.

No diagnostic rewording was needed: all designator forms now fold, and a
bound that still doesn't fold (e.g. a non-constant subscript in the
designator) genuinely IS non-constant, so the VLA message is accurate
there.

## Lock

`tests/unit/core/offsetof_designators/` — nested named, anon union, anon
struct, double-anonymous, subscripted chain, and the exact SameBoy
GB_SECTION offsetof-difference shape; each as an array bound, a static
initializer, a case label, and a runtime value, all cross-agreeing
(pins the two evaluators to each other). Test-first: committed red
(`b1215073`), fix followed (`1df9bb48`). One shape note: upstream's
zero-length `[0]` end marker needs `--allow-zero-length-arrays` (SameBoy's
build passes it; the unit runner doesn't), so the lock uses a plain end
marker — the anonymous-member walk under test is identical.

## SameBoy two-sided edit (`dd2c4290`)

The rtc-section patch was the sole survivor of #684's retirement pass and
existed only because of this bug. Retired: upstream v1.0.3 text restored
verbatim in `core/gb.c` (fetched from the pinned commit 208ba4a to be
faithful), README row moved to a "#687 retired" section. Full
`vendor/sameboy/bin.json` build verified. No image.json bump, per the
#681/#684 precedent (compiler.js + vendor-source restores shipped without
one; Node-side bakes are mtime-gated, the browser-persistent bump rides
the next deploy).
