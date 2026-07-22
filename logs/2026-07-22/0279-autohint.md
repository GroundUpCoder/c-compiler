# 0279 — light autohinting for small ppem (fontcore fc_load_flags)

The vendored freetype had NO hinter at all: myftmodule.h registered only
TT driver + sfnt + psnames + smooth, and myftoption.h #undefs the TT
bytecode interpreter — every glyph rendered unhinted, which is why 16px
UI text (software-center card summaries) reads muddy and ≤13px has no
solid features. Fix: vendor upstream 2.14.1 `src/autofit/` (harfbuzz
paths compile out cleanly — FT_CONFIG_OPTION_USE_HARFBUZZ undefined),
register `autofit_module_class`, add `autofit.c` to the freetype
lib.json. autofit.c compiled under our compiler first try — no compiler
bugs surfaced.

## The load-flag rule (ONE place: fontcore.h `fc_load_flags`)

- ppem != 20 → `FT_LOAD_TARGET_LIGHT | FT_LOAD_FORCE_AUTOHINT`
- ppem == 20 → `FT_LOAD_DEFAULT | FT_LOAD_NO_AUTOHINT`

Two non-obvious facts drove the shape:

1. **Registering a hinter changes what FT_LOAD_DEFAULT means.** With
   autofit present and no native TT hinter (bytecode interpreter
   compiled out), ftobjs.c autohints EVERY load that doesn't opt out
   (`!FT_DRIVER_HAS_HINTER(driver) → autohint = TRUE`). So the 20px
   exemption must say `FT_LOAD_NO_AUTOHINT` explicitly — plain DEFAULT
   would have silently FULL-autohinted the tuned system size and broken
   the ksvc/fontpkg same-bytes e2es. Same reason sent/drw.c and
   mgp/tfont.c now pin `FT_LOAD_NO_AUTOHINT`: module registration must
   not re-render vendor apps that didn't ask.

2. **Full autohint breaks the mono grid; light does not.** Measured on
   Noto Sans Mono: TARGET_NORMAL|FORCE_AUTOHINT rounds per-glyph
   advances NON-uniformly (31-char line at 14px: 248px unhinted → 255px
   full-hinted; 16px: 310 → 298) — cell-grid consumers (term, gdi32
   monoAdv) would shear. TARGET_LIGHT advances were identical to
   unhinted at every probed ppem (8..24), so layout is byte-stable. The
   'M'-advance metric probes (gdi32 font_ensure, term load_glyphs, ksvc
   slot_for) still use fc_load_flags so measure and render agree by
   construction if that ever changes.

## Measured effect (fontramp probe, Noto Sans Mono)

Light hinting re-renders ~90/94 ASCII glyphs at every size (y-snap to
blue zones) but changes bitmap GEOMETRY for only 4–8/94 (±1px,
punctuation) — advances identical, so no golden anywhere moved: kernel
102/102, sweep 36/36, flake 8/8 stable, ksvc/fontpkg same-bytes green
(20px bit-identity held through the real fc_render_face path,
FNV-verified in the probe too). In-OS before/after (software center over
a live repo): 16px card summaries crisper on baseline/x-height edges,
identical layout; 26px title picks up subtle AA refinement; everything
else byte-identical except the taskbar clock.

Honest scope note: light = vertical-only. Horizontal stem positioning is
untouched (that's what keeps advances stable), so the improvement at
12–16px is real but modest — crisp horizontals, stems still
antialiased. Truly solid stems would need full hinting, which the mono
grid rules out (above). If small-size text still reads soft on retina
displays, the remaining cause is the DPR-2 canvas upscale (os.html, 1
CSS px = 1 screen px) — separately tracked, out of 0279's scope.
