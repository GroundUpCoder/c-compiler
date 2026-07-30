# C1 — multi-face proportional CreateFont in gdi32 (#281)

Head item of the win32 desktop consolidation stream (Arc 1 item 1, jku's
2026-07-30 typography directive). CreateFont stops ignoring `faceName` and
stops fail-louding on bold/italic/underline/strikeout: the 8 baked Noto
faces (os/image.json) are now reachable through the veneer, retiring the
"only NetSurf's private FT layer reaches sans/serif" state.

## What landed

- **Face table + Win32-shaped mapper** (`gdi32.c`): three families
  (mono/sans/serif) × bold × italic over the 8 baked files, every face read
  through its own `/etc/fonts/NAME.ttf` > `/usr/share/fonts/NAME.ttf` pair
  (the old FONT_PATH/FONT_FALLBACK rule, generalized per face). Known
  family names map directly (Courier/Consolas/Fixedsys/Lucida Console →
  mono; MS Shell Dlg/MS Sans Serif/Arial/Tahoma/Segoe UI → sans; Times New
  Roman/Georgia/MS Serif → serif); unknown names fall back to family
  keywords in the name ("mono"/"courier"/"fixed" > "sans" > "serif" — the
  order makes "Comic Sans MS" and "sans-serif" resolve sans), then the
  `lfPitchAndFamily` bits (FF_ROMAN → serif, FF_SWISS/SCRIPT/DECORATIVE →
  sans, FF_MODERN → mono, VARIABLE_PITCH → sans). NULL/empty + nothing
  resolvable = mono — **the C1 default is unchanged**; C2 (#282) is the
  flag day.
- **Real files preferred, synthesis only where none is baked**: sans has
  real italic + bold-italic files; mono and serif don't, so their italic
  synthesizes via a new fontcore `italic_shear` render knob
  (`FC_ITALIC_SHEAR` = ftsynth's 0x0366A ≈ 12°, `FT_Outline_Transform`,
  advance untouched — exactly `FT_GlyphSlot_Oblique`'s contract). Every
  family bakes a real bold, so bold synthesis (`GDI_BOLD_XDELTA` = ksvc's
  0x0555 through the existing fontcore embolden) lives only on the
  load-failure degrade ladder: exact variant file pair → family regular +
  full synthesis → the mono pair → fail. Synthetic styles apply to
  fallback-chain glyphs too (a bold font's CJK glyph renders bold).
- **Underline/strikeout are drawn rules** in `text_run` (real GDI
  behavior): underline geometry from the face's own
  `underline_position/thickness` (defaults where absent), strikeout at
  0.3 em above baseline (the vendored FT_Face doesn't surface OS/2
  yStrikeoutPosition; documented choice). Rules span the run, honor
  clip + ETO_CLIPPED, and ride dx-override runs correctly (rule ends at
  the final pen position).
- **Per-face metrics**: cell-height (positive lfHeight) refinement moved
  from a CreateFont-time mono-file probe to ensure time against the
  RESOLVED face (same integer formula — mono callers byte-identical).
  GetTextMetrics reports tmWeight/tmItalic/tmUnderlined/tmStruckOut from
  the request and TMPF_FIXED_PITCH|FF_* for proportional faces; mono keeps
  the exact pre-C1 `tmPitchAndFamily = 0`. Glyph caches were already
  per-HFONT, which is per-(face,size,style) by construction.
- **Fail-loud narrowed, not dropped**: lfEscapement/lfOrientation stay
  WIN32_UNSUPPORTED, and lfWidth (condense/expand) — silently ignored
  pre-C1 — now reports too.
- **`/bin/fontramp`** (os/win32/fontramp.c, seeded + Demos menu): windowed
  per-face size ramp (12–34px pangram + style row) for screenshot
  evidence, headless `probe` mode printing tm/adv/ext lines + an FNV ink
  hash over a memory-DC render — the e2e's raw material.
- **Headers**: windows.h grew FF_ROMAN/FF_SWISS/FF_SCRIPT/FF_DECORATIVE +
  the TMPF_* bits. image.json v199 → v200 (fontramp + gdi32 rebake).

## Test (tests/kernel/test_multiface_font_e2e.js, registered in the kernel suite)

57 checks, all relationship-based (no absolute pixel constants):

- **No-flag-day**: the NULL-face probe output is BYTE-IDENTICAL to the
  mono probe (metrics AND render hash) — plus the existing gdi32 e2e's
  bit-exact scene shots ride the same default path.
- **Real-vs-synthetic discriminator**: sans italic's advances DIFFER from
  upright (a shear can't move advances → must be the real file); mono and
  serif italic advances are IDENTICAL to upright with a moved render hash
  (the synthetic signature).
- **The-file-not-embolden proof**: `cp serif.ttf /etc/fonts/sans_bold.ttf`
  makes a sans-bold probe render serif's exact hash (the per-face /etc
  override reaches the variant), `rm` restores the baked hash.
- Name-mapper legs (Courier New/Lucida Console → mono, MS Shell Dlg →
  sans, Times New Roman → serif, Comic Sans MS → sans by keyword, unknown
  → mono), bold ink-weight legs, drawn-rule legs, 10 windowed ramp shots
  (640×420, inked, pairwise distinct) saved as PNGs.

Evidence: `logs/2026-07-31/c1-fontramp/fontramp-*.png` (10 shots — the 8
baked faces + the two synthetic italics).

## Decisions / deferrals (reported to the stream owner at decision time)

- ChooseFontW keeps its single "mono" row: expanding the list is a
  dialog-visible change in the ports → rides C2 (#282). Register entry
  L65.
- Synthetic-BOLD's degrade ladder has no e2e trigger on a stock image
  (every baked family carries a real bold) — the italic branch is fully
  e2e'd; embolden mechanics stay pinned by ksvc's daily use of the same
  `fc_render_face` seam. Coverage boundary, not a cut.
- GetObject on an HFONT still returns 0 (no LOGFONT read-back; nothing in
  the port corpus demands it).
- Strikeout position is arithmetic (0.3 em), not OS/2-table-derived — the
  vendored freetype build doesn't expose FT_Get_Sfnt_Table through our
  include set, and the classic GDI position is what apps expect visually.
