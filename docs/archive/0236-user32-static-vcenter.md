# 0236 — user32 STATIC vcenter (corpus-wide label descender clip)

- **Status**: done (2026-07-17 — image v110; kernel 75/0, browser sweep 27/27;
  red→green descender legs in test_user32_e2e.js over ctldemo's three
  acceptance STATICs; dev log: logs/2026-07-17/0236-static-vcenter.md)
- **Design**: —

## Goal

The general fix for the latent STATIC descender clip (the 0229/0230 disease
family, at its root this time): user32's `static_proc` WM_PAINT draws its
text with horizontal-only DrawText flags (os/win32/user32.c ~3393-3403, no
DT_VCENTER), so single-line text TOP-ALIGNS in the control — any STATIC
label shorter than the 19px stock glyph cell latently clips `g/y/p/q/j`
and parens at its bottom edge. That's every template- or Win95-arithmetic-
sized label in the corpus (winmine counters, calc display, ctldemo,
ctlpanel applets…), not one app's strip.

0230 hit this disease at fileman's strip and was redone onto comctl32's
STATUSBAR (which vcenters and derives its own height) — the strip is fixed
at the shared-control layer. This item is the remaining root: the STATIC
control itself.

## Plan

- Add DT_VCENTER|DT_SINGLELINE to static_proc's paint, GUARDED so
  multiline/top-aligned STATICs keep working — vcenter only when the text
  has no '\n' (and honor SS_* styles if any corpus consumer sets them).
  Audit the corpus's STATIC consumers (winmine/calc/notepad/ctldemo/
  ctlpanel/fileman dialogs) for anything relying on top-alignment.
- The 0229/0230 pixel-leg pattern is the test template: a shot leg proving
  a descender glyph renders un-clipped in a Win95-sized (18px) STATIC.

## Acceptance

- A single-line STATIC shorter than the stock glyph cell renders
  descenders un-clipped (pixel red→green leg).
- Multiline STATICs are byte-identical (top-aligned, unchanged).
- No visual regression across the win32 corpus apps' labels
  (winmine/calc/ctldemo/ctlpanel legs stay green).
