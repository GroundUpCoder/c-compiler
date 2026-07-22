# 0279 — small-ppem text is unhinted mush — add light autohinting to the font pipelines

- **Status**: open
- **Design**: vendor/freetype/demo/myftmodule.h + myftoption.h; gdi32/term/ksvc load sites; relates to 0277 (fontcore) — consider landing as its successor (fontcore now consolidates the load path)

## Goal
The vendored freetype registers no hinter (no autofit module; TT bytecode
#undef'd), so all text renders unhinted. 20px (the tuned system size) looks
fine; 16px — used by the software center's subtitle + card summaries — is
visibly muddy, and ≤13px has no solid stems at all (fontramp measurement:
95% of ink is half-tone at 8px, 62% at 16px, 56% at 20px). The
NONANTIALIASED threshold path additionally yields uneven per-glyph boldness
at 10–13px. This is jku's "aliasing feels weird at some sizes".

## Plan
- Add autofit to the vendored build (FT_USE_MODULE autofit_module_class +
  autofit.c in the freetype lib.json) and load glyphs with
  FT_LOAD_TARGET_LIGHT | FT_LOAD_FORCE_AUTOHINT (light = vertical-only
  snapping; advances unchanged, layout stable).
- Decide: hint all sizes, or gate to ppem != 20 to keep the tuned system
  size bit-identical (ksvc/fontpkg same-bytes e2es pin 20px).
- Raster-diff goldens will change where hinting applies — LOOK-CONFIRM
  before re-baking (the v133 lesson).
- 0277 fontcore consolidation has LANDED (merged to main 2026-07-22): the
  FT_Load/embolden/advance/Render sequence now lives once in
  `os/fontcore.h` `fc_render_face`, and gdi32/term/ksvc are thin adapters —
  so set the load flags in ONE place (fc_render_face) and all three
  pipelines inherit them.
- Separate question to jku: if the complaint is from a retina Mac, the
  DPR-2 canvas upscale (os.html, 1 CSS px = 1 screen px) is a second,
  independent cause — that fix is DPR-aware backing (vt2-zoom territory).

## Acceptance
fontramp-style ramp shows solid stems at 12–16px; software center subtitle
crisp; text e2e surface green (gdi32/user32/term/fontpkg/ksvc + sweeps).
