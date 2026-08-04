# #435 — bake Noto Sans Symbols 2 (jku ruled Option A)

The Mac modifier symbols (U+2318 ⌘, U+2325 ⌥, U+21E7 ⇧, U+2303 ⌃, U+232B ⌫,
U+23CE ⏎) were in none of the 8 baked faces, so menu/chrome accelerators using
them rendered the deliberate loud tofu box on a stock image (#96 worked around
it with `Cmd+V`). jku ruled Option A: bake Noto Sans Symbols 2, not unifont.

## What landed

- `vendor/fonts/NotoSansSymbols2-Regular.ttf` (671,568 B, `glyf` outlines,
  2660 glyphs, upem 1000) from `notofonts.github.io`
  `fonts/NotoSansSymbols2/hinted/ttf/`, OFL 1.1 vendored alongside
  (`OFL-NotoSansSymbols2.txt`; body byte-identical to the sans/mono OFL text).
  sha256 `c4a0a80f0041…` recorded in `vendor/fonts/README.md`.
- `os/image.json`: `/usr/share/fonts/symbols2.ttf` + a **baked**
  `/usr/share/fonts/fallback` list naming it — the first baked chain entry.
  fontchain.h's `/etc` layer CONCATENATES ahead of the baked list, so gucman
  font-package install/remove deltas are untouched (test_fontpkg_e2e agrees:
  it checks the `/etc` file only, and CJK stays honest tofu on the base image).
- `os/os-common.js` fonts-fold comment rescoped to PACKAGED faces — the old
  sentence "they never lived in the baked /usr" is now false by design.

## The finding the ticket's premise missed

**Noto Sans Symbols 2 does not map U+2303 (⌃ control).** Measured directly
from the cmap (format-12 subtable): 2318→1012, 2325→1011, 21E7→104,
232B→1007, 23CE→1013, **2303→0**. U+2303 lives in Noto Sans Symbols (1)
(glyph 265 there), a separate family the ticket's option A conflated with
Symbols 2. So this change fixes 5 of the 6 glyphs; ⌃ stays tofu until someone
rules on vendoring Symbols (1) too (~226,980 B hinted). Recorded in the README
row, the baked list's comment, and the test header — not silently patched
around, because expanding a jku ruling is not a lane's call.

## Red-then-green (the #97 standard)

`tests/kernel/test_symbolfont_e2e.js` (red control committed first,
test-files-only, `896ef753`): on the base tree it fails 19 checks with the
exact predicted signature — no baked list, all five symbol cells the identical
tofu box, notepad's once-per-process gdi32 report naming U+2318. On the fix
(`e89ac71f`) all 27 checks pass. Permanent in-run vacuity controls: U+0378 and
U+0379 are unassigned in Unicode (glyph 0 in every vendored face, verified),
so they render the identical tofu box forever — proving the pixel instrument
still sees tofu and (as the report's named cp) that the stderr instrument is
alive in the very process under test.

## Bytes

Minimal image: 15,861,888 → 16,477,296 B (**+615,408**; the image absorbed
part of the 671 KB in existing slack). Live v237 deploy artifact measured at
15,861,520 B, so the projected shipped artifact is ≈16,476,928 B — headroom
**≈9,737,104 B** under the 26,214,400 B Cloudflare cap.
