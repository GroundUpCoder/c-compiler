# 0230 — fileman status strip clip

- **Status**: open
- **Design**: —

## Goal

Same disease family as 0229 (19px stock-font cell vs Win95-sized furniture),
different control and site: fileman's status strip is a STATIC control
(os/fileman.c, `STATUS_H 18`), and user32's STATIC paint top-aligns its text
with no vertical centering (user32.c static proc, plain DT_LEFT) — a 19px
glyph cell in an 18px strip loses its descender row, so `g/y/p/q/j` and
parens clip at the strip's bottom edge.

Deliberately NOT fixed by 0229, which is comctl32.c-local (msctls_statusbar32
has exactly one consumer, notepad). This needs its own fix at a different
layer.

## Plan

Two candidate levers (pick when starting):

- Add DT_VCENTER|DT_SINGLELINE to user32's STATIC paint — but that changes
  every STATIC in the corpus (winmine/calc/ctldemo labels), so audit those
  first; top-aligned multiline STATICs must keep working (DT_VCENTER only
  when the control is single-line-sized?).
- Or keep STATIC as-is and make fileman derive its strip height from
  GetTextMetrics (the 0229 formula) so the 19px cell fits — fileman-local,
  zero corpus blast radius.

## Acceptance

- fileman's status strip renders descenders un-clipped (pixel leg in
  tests/kernel/test_fileman_ops_e2e.js or a small new shot leg).
- No visual regression in winmine/calc/ctldemo STATIC labels if the STATIC
  path is touched.
