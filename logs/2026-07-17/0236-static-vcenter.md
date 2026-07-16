# 0236 — user32 STATIC vcenter: the descender-clip disease at its root

The 0229 (notepad status strip) and 0230 (fileman strip) fixes were symptom
patches on the same underlying disease: `static_proc`'s WM_PAINT drew label
text with horizontal-only DrawText flags, so single-line text TOP-ALIGNED in
the control and any STATIC shorter than the 19px stock glyph cell clipped
descenders (`g/y/p/q/j`, parens, the mnemonic underline) at its bottom edge.
0230 moved fileman's strip onto comctl32's STATUSBAR (which vcenters); this
item cures the shared STATIC control itself.

## What landed

**Both draw branches** of `static_proc` vcenter single-line text now:

- **Plain branch**: `DrawText(..., fmt | DT_SINGLELINE | DT_VCENTER)` when
  the text has no `'\n'`. Multiline text keeps the exact pre-fix call
  (byte-identical — DT_SINGLELINE would collapse its newlines).
- **Mnemonic branch** (left-aligned text containing `'&'`, drawn via
  `draw_label_mn`): the y is now the centered cell top,
  `r.top + ((h->h - tmHeight) >> 1)` via GetTextMetrics (the same metric
  source as 0229's comctl32 fix), so the underline moves with the text.
  Multiline keeps `r.top`.

**DrawText's DT_VCENTER now FLOORS its centering division** (gdi32.c).
This is the load-bearing subtlety: the stock cell is 19px and the canonical
Win95 label is 18px, so the spare space is −1 — C truncation gives 0, i.e.
plain DT_VCENTER would not have moved the text at all and the descender row
would have stayed on the clip edge. Flooring biases the loss to the cell's
BLANK leading row at the top (caps start ~4 rows down) instead of the inked
descender row at the bottom. Truncation and floor agree for all non-negative
space, so every existing DT_VCENTER consumer (statusbar, ctlpanel, gdidemo —
all rects taller than the cell) renders byte-identically. The same floor is
used in the mnemonic branch — no `>= r.top` clamp, deliberately: the child
DC clips at both control edges (no parent bleed), and clamping would re-clip
the descender in sub-cell controls, i.e. reintroduce the disease.

## Measured geometry (14px stock font, mono.ttf)

ascent 15 / descent 4 → 19px cell; `o` bottom at cell row 14, `g/y/p`
bottoms at row 17, mnemonic underline at row 18. In an 18px control,
top-aligned: descender bottoms sat ON the last control row (the 0230 razor
edge) and the underline was clipped off entirely. Vcentered (floor → y−1):
descenders get a clear row, the underline lands on the last row, the blank
cell-top row is the only loss.

## Red→green

ctldemo grew three acceptance STATICs ("No gyp" 18px plain, "&No gyp" 18px
mnemonic, "No gyp" 30px unclipped reference) and test_user32_e2e.js grew
shot legs measuring descender extent (`dj = maxInk(gyp) − maxInk(o)`,
placement-invariant) + clearance + underline survival. Pre-fix: all three
FAIL (plain g=61 = clip edge, mn g=87 = clip edge, underline mnUl=84 — no
underline ink at all). Post-fix: all green.

## Corpus audit (every STATIC consumer)

- All runtime-created STATICs (ctldemo, ctlpanel, fileman, comdlg32) are
  single-line, 16–18px → shift up 1–2px, descenders recovered. Nothing
  positions adjacent painting off the text's top edge.
- Dialog-template statics at 8du (winmine rows, notepad Size/Tray/etc.)
  convert to exactly the 19px cell → offset 0, unmoved.
- calc's displays are `SS_CENTERIMAGE` CTEXT/RTEXT (24–36px): they always
  WANTED vcenter (static_proc used to ignore it) — the single-line rule
  centers them without needing the style bit. Intended improvement.
- Taller labels (notepad Header/Footer 35px mnemonics, print-progress
  CTEXTs, MessageBox body) center visibly — cosmetically correct, nothing
  couples to the old top position.
- The one multiline-capable STATIC is MessageBox body text with `'\n'` —
  stays top-aligned byte-identical under the guard. No consumer needed a
  special case.

Gate: image v110; kernel suite 75/0 (incl. winmine/notepad/fileman/ctlpanel
e2es); browser sweep 27/27.
