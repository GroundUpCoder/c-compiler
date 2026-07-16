# Status bar goes font-derived — text vertically centered (todos/0229)

## The bug

Notepad's status bar (`os/win32/comctl32.c`, the one real comctl32 control)
hardcoded `SB_H 20` and drew its text at `ExtTextOut(…, y=3, …)` — arithmetic
cargo-culted from Win95's 8pt MS Sans Serif (13px cell: Wine's 13+3+2+2=20,
y=3≈(20−13)/2). gucOS's stock font is Roboto Mono @14px with a **19px** cell
(ascent 15 + descent 4), so in a 20px bar the glyph cell spanned rows 3–21:

- caps sat bottom-flush, ~3px too low;
- the baseline (row 18) landed exactly ON the well's BTNHIGHLIGHT bottom
  border row, so glyphs painted over the border;
- descender rows 19–21 were cut by ETO_CLIPPED against `part.bottom=19` —
  `"Ln 1, Col 1"`'s comma rendered as a period-stub, parens/`gypqj` lost
  their tails.

## The fix (general, not a nudge)

Wine's `STATUSBAR_ComputeHeight`, so it's right for ANY stock font:

- `sb_height()` computes `tmHeight + max(tmInternalLeading,2) + 2·SM_CYBORDER
  + SB_VBORDER(2)` from GetDC+GetTextMetrics, cached in SbarState and used by
  both `sb_park` and WM_PAINT (SB_H is gone). Stock font: 19+5+2+2 = **28px**.
  Zeroing the cache is the WM_SETFONT recompute seam for later.
- Text now goes through `DrawText(DT_SINGLELINE|DT_VCENTER|DT_LEFT|
  DT_NOPREFIX)` into the part's rect inset past the 1px sunken edge (left pad
  kept at 6px so the horizontal layout is unchanged). gdi32's DrawText
  already vertically centers and clips to its rect, so the 0211 part-overflow
  clip ("Windows (CR + LF)" must not bleed into the UTF-8 pane) stays
  covered.
- Wells inset 2 from top/bottom (the Win95 vertical border) instead of 1.

Notepad needed ZERO change: it WM_SIZEs the bar and reads the height back via
GetWindowRect (vendor/notepad/main.c WM_SIZE), so the 28px height propagates
into its EDIT layout automatically. `msctls_statusbar32` has exactly one
consumer in the corpus (notepad — winmine/calc/ctldemo don't create one), so
the blast radius is comctl32.c-local.

Recorded caveat: the correct 28px bar is chunkier than the old 20px — that's
RIGHT for a 14px font. If proportions offend, the lever is the stock font
size, never the bar constants.

## Red→green pins (tests/kernel/test_notepad_e2e.js)

Three new checks read the EXISTING sbar.ppm shot, with the bar rect located
from the `==tree1` dump (`class=msctls_statusbar32 … rect=X,Y WxH`) — never
`sp.h−20` — so they survive any future height change:

1. `H >= 23` — height is font-derived (was 20 → RED; now 28).
2. zero text ink on the well's bottom border row over part 1's columns
   (the comma painted it → RED; now clean).
3. descenders survive: `maxInkRow(EOLN part) − maxInkRow(UTF-8 part) >= 3`
   (both clipped at the same row → diff ~1 → RED; now the EOLN `(` descends
   past the UTF-8 caps).

In the same change, everything that assumed the 20px bar switched to the
derived rect: the existing bleed/UTF-8-ink checks (`by = sp.h − sbH`), the
sbGray/hbGray scrollbar strips (`EB = sbp.h − sbH`), and — importantly — the
SHELL DRIVING coordinates (down-arrow / channel / thumb-drag clicks), which
now hang off `SBY=$((300-SBH))` with SBH sed-extracted from `wmctl tree`
in-script; hardcoded y=254/238/244 would have sheared onto the wrong
furniture once the bar grew and burned wait timeouts.

RED confirmed before the fix — exactly the 3 new legs failed (H=20; ink=1 on
the border row; descender diff 1) with everything else green, including the
SBY-derived driving at the old height. GREEN after: ALL OK, live tree shows
`rect=0,232 400x28`.

## Gating (HEAVY gucOS change — comctl32.c bakes into the image)

- image.json version 103 → **104** (browser OPFS re-fetch gate).
- mkimage bake: PASS (after unblocking the cold-bake break — see below).
- kernel suite (`node tests/kernel/run.js`): **75 passed, 0 failed** (544s).
- browser sweep (`node tests/browser/os-sweep.mjs`): 26/27, the one failure
  being os-touch's pan census whose band bottom (`np.h − 26`) had silently
  encoded the 20px bar — under the 28px bar the WS_HSCROLL strip moved up
  into the band and its dark edge row (exactly the band's 90px x-span)
  never cleared. Fixed by bounding the census to the M block's own three
  19px rows (bar-height-independent, the honest region for what it
  asserts); os-touch re-run PASS.

## Collateral discovery — cold bakes at HEAD were broken (todos/0231)

The v104 rebake was the first COLD busybox rebuild since the 0227/G22
negative-array-size diagnostic landed, and it refused to bake — two
busybox compile-asserts have been legitimately firing forever, silently
accepted by the old compiler. Root causes and fixes in
`logs/2026-07-17/busybox-attributes-0231.md`; landed here because this
gate is what exposed it and the 0229 image can't bake without it.

## Follow-up filed

**todos/0230** — fileman's status strip has the same disease at a different
site: it's a STATIC control (`STATUS_H 18`) and user32's STATIC paint
top-aligns with no vertical centering, so the 19px cell loses its descender
row there too. Needs its own fix (DT_VCENTER in the STATIC paint — with a
corpus audit — or a font-derived strip height in fileman); deliberately not
part of this comctl32-local change.
