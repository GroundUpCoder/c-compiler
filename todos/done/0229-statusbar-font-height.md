# 0229 — statusbar font height

- **Status**: done (2026-07-17) — comctl32 c946385, tests af3d902; bar 20px→font-derived 28px, red→green pins in test_notepad_e2e.js; image v104
- **Design**: —

## Goal

Notepad's status bar (os/win32/comctl32.c, msctls_statusbar32) draws its text
3px too low, clips descenders entirely, and paints glyphs over the well's
bottom BTNHIGHLIGHT border. Root cause: `SB_H 20` + `ExtTextOut(…, y=3, …)`
are cargo-culted from Win95's 13px MS Sans Serif cell, but gucOS's stock font
(Roboto Mono @14px) has a 19px cell — the glyph cell spans bar rows 3–21 in a
20px bar, the baseline lands on the border row, and ETO_CLIPPED cuts the
descenders. `"Ln 1, Col 1"`'s comma renders as a period-stub; parens lose
their tails.

## Plan

Font-derived, not a magic-number nudge (Wine `STATUSBAR_ComputeHeight`):

1. Compute the bar height on demand from the DC's font metrics —
   `tmHeight + max(tmInternalLeading, 2) + 2·SM_CYBORDER + vertical border` —
   cache it in SbarState, use it in sb_park + WM_PAINT (replaces `SB_H`).
   Zeroing the cache is the WM_SETFONT recompute seam for later.
2. Replace the hardcoded `ExtTextOut(…, left+6, 3, …)` with
   `DrawText(DT_SINGLELINE|DT_VCENTER|DT_LEFT|DT_NOPREFIX)` into the part's
   sunken rect inset past the 1px edge (+3px left pad) — gdi32's DrawText
   already implements DT_VCENTER and clips to the rect, so the part-overflow
   clip regression stays covered.
3. Wells inset 2 from top/bottom (Win95 vertical border) instead of 1.

Notepad needs no change — it WM_SIZEs the bar and reads the height back
(vendor/notepad/main.c WM_SIZE), so the font-derived height propagates.

## Acceptance

- Red→green legs in tests/kernel/test_notepad_e2e.js, all reading the
  existing sbar.ppm shot with the bar rect located from the `==tree1` dump
  (never `sp.h−20`):
  1. bar height is font-derived (`H >= 23`; stock font gives 28),
  2. zero ink on the well's bottom border row over part 1's columns,
  3. descenders survive: `maxInkRow(EOLN part) − maxInkRow(UTF-8 part) >= 3`.
- The existing bleed/clip checks, h-scrollbar strip constants and scrollbar
  driving coordinates switch to the tree-derived bar rect in the same change.
- Full kernel suite + browser sweep green; image version bumped.
