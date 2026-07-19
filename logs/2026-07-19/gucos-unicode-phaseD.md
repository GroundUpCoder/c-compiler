# gucOS Unicode Phase D — coverage: Noto face swap, fallback chain, font packages, wcwidth (FINAL phase of ITEM B)

Branch `unicode-phaseD` off main @ 7559b53 (Phases A+B+C, v132). Kills W7 and
closes the CJK-glyph gap Phase C deliberately kept open; image **v133**.
Rulings honored: D2-REVISED (ONE baked face = Noto Sans Mono; Roboto Mono
retired, DejaVu never shipped), D3 (color emoji deferred — monochrome
tofu stays honest), D5 (combining marks = own spacing cell → cell width 1).

## 1. The face swap (D2) — vendor/fonts/

All fonts must be TrueType-flavored: the vendored freetype registers ONLY
`tt_driver` (demo/myftmodule.h — no CFF), so `.otf`/CFF files cannot load.
That constraint picked every artifact (provenance + sha256 in
`vendor/fonts/README.md`, licenses committed alongside per OFL terms):

- **NotoSansMono-Regular.ttf** (596 KB, OFL 1.1) — the baked
  `/usr/share/fonts/mono.ttf`. notofonts.github.io hinted build.
  Coverage VERIFIED by cmap parse before retiring Roboto: box drawing
  U+2500-257F **128/128**, block elements U+2580-259F **32/32**, full
  Cyrillic 256/256, Latin Ext-A/B complete, Greek complete (U+03A2 is
  unassigned by Unicode), 3490 mapped cps vs Roboto's 876 (Roboto had
  ZERO box-drawing/blocks — the swap is a strict coverage win).
- **unifont-15.0.06.ttf** (12.4 MB, dual OFL 1.1 / GPLv2+ with font
  exception) — `font-unifont` package. 15.0.06 is the LAST TrueType
  Unifont build (15.1+ ships only CFF .otf). Full BMP: 57087 cps.
- **NotoSansMonoCJKjp-VF.ttf** (35.4 MB, OFL 1.1) — `font-noto-cjk-mono`
  package. The variable TTF is the only TrueType-flavored official Noto
  CJK build (static OTF/OTC are CFF) — hence 35 MB, not the ~16 MB
  static estimate; freetype renders the default (Regular) instance.
  44810 cps, JP region.

All three load + render in the wasm freetype (smoke-tested via a
build/ftsmoke probe before any integration).

## 2. Chrome re-tune (the jku-approved look): NOTHING to re-tune

Measured at CHROME_PPEM 10: Noto advance **6px** (same 0.6 em design as
Roboto), caps 8px at top=8, ascent **11** — identical to Roboto's chrome
numbers. The Phase C knobs carry over UNCHANGED: ppem 10, threshold 96
(Noto's thin stems survive: 'T' 20 lit px, '1' 14 at ≥96), baseline
`y + 7 - ascent`. `text_mask` is ink-trimmed so the +1 tmHeight doesn't
shift the band/marquee. Only glyph SHAPES differ (Noto slightly denser —
'M' 32 lit px vs 20). Before/after screenshots (taskbar, Start menu,
icons, RUN, marquee) shipped to S3 for the jku look-confirm gating deploy.

What DID move (14px stock metrics, the win32 side):
- term cell 8×18 → **8×19** (Noto height 19) — `term &` = 640×**456**;
  term-geometry goldens re-baked (test_term_e2e, os-term.mjs TH).
- gdi32 stock cell 19 → **20px** (ascent 15 + descent 5; Roboto had
  descent 4) and descender ink reaches baseline+3 (Roboto +2). In a
  Win95-sized 18px STATIC the DT_VCENTER arithmetic now necessarily puts
  descender bottoms ON the control's last row — the 0236 test's
  ">=1 clear row" clause was a Roboto-cell property; re-baked to
  "full descender extent (dj === ref.dj) AND within the control".
- **draw_label_mn underline moved to baseline+2** (the real-GDI position,
  crossing descender tails) — the old cell-bottom row fell OUTSIDE short
  controls under the 20px cell and clipped away entirely. Test re-baked:
  underline below the baseline glyphs, unclipped.
- gdi32 `maxAdv` is no longer the tofu geometry: Noto carries wide forms
  (max_advance 25 @14px vs Roboto's 8), so tofu keys on the new
  `monoAdv` ('M' advance — the term rule), ×2 for wcwidth-2 cps.

## 3. Fallback chain (W7) — os/fontchain.h at BOTH glyph chokes

`os/fontchain.h` (header-only, the cfgstore/openwith precedent): loads
`/etc/fonts/fallback` + `/usr/share/fonts/fallback` (one absolute face
path per line, '#' comments). Layers CONCATENATE — /etc lines probe
first, the baked list follows — because a list file has no per-key
overlay; an /etc file extends rather than shadows. Consumers:

- gdi32 `font_glyph` → `font_face_for`: face 0 (the baked/user mono
  pair) probes first; on a miss (cp > 126) the chain faces open LAZILY
  at the HFONT's pixel size and probe in order; NO face → the
  synthesized tofu (now 2 cells wide for wcwidth-2 cps) + the
  once-per-process WIN32_UNSUPPORTED report.
- term `cp_glyph` → `face_for`: same shape, FONT_SIZE-sized.

The rendered bitmap lands in the existing cp caches, so the chain is
probed once per cp per process — "the cache remembers the face" for
free. Config reads once per process at first glyph init (install reaches
newly started apps — the openwith read-at-use discipline). With no
config the chain is [face 0] and behavior is byte-identical single-face.

## 4. gucman font packages (fonts = a 4th declarative surface)

`packages/font-unifont.json` + `packages/font-noto-cjk-mono.json`: plain
`bin`-blob files + the new `"fonts": ["<rel>"]` list. mkpkg validates +
passes `fonts` through control.json; gucman grew `gm_fontline_set`
(line-granular add/remove in /etc/fonts/fallback, atomic rewrite,
creates /etc/fonts, unlinks the file when the last line goes) wired into
install (undo-safe, recorded as DB `font_faces`), remove (replayed
first, reverse order), and `info`. font-dejavu: never created (D2).

**Fonts deliberately do NOT fold into the `--packages=all` fat bake**
(foldPackages validates them, plants nothing): they never lived in the
baked /usr (nothing to restore), they'd add ~48 MB to every dev/test
image fetch, and — /usr being read-only while /etc CONCATS ahead —
a folded face could never be removed, making the no-package tofu state
(a real deploy state) untestable on the fat fixture. Install/remove
stays fully exercisable on ANY image via the /etc delta. This is a
reasoned per-surface rule, not a demo shortcut.

## 5. wcwidth + double-width cells + the 2-cell erase echo

**Placement: NOT compiler.js.** `os/wcwidth.h` (header-only, OS-side) +
a kernel.js twin `wcwidthCp` — the only consumers are term's cell layout
and the tty's erase echo; a libc wcwidth would touch every binary for
zero additional customers (busybox is compiled non-unicode). Both tables
carry MUST-MATCH cross-references; promote to libc when a real consumer
appears. → compiler.js untouched, no SameBoy mandate.

Table: condensed Unicode 15.0 EAW W/F blocks (returns 2), everything
else 1 — INCLUDING combining marks (D5: own spacing cell ⇒ cell width 1;
a deliberate divergence from POSIX wcwidth's 0, documented in-header).
Emoji blocks report 2 (the tofu box honestly occupies both cells, D3).

term.c: `Cell` grows the CP_WIDE_CONT contract (cp 0 = continuation
half; renders bg-only; orphaned halves degrade to blanks — put_char
blanks the partner when overwriting either half). Wide chars never split
across rows (wrap first; no-autowrap clips to 1 cell), cursor advances
2, selection copy skips continuations, tofu spans 2 cells. **render()
split into per-row bg pass + glyph pass** — the fused loop painted the
continuation cell's bg OVER the lead's glyph spill (found by the wide
e2e's continuation-cell ink probe).

kernel.js: `_popChar` now decodes the popped sequence and returns its
display width; ERASE/KILL echo one `[8 32 8]` triple per cell — the
Phase B "deferred wide-char erase echo" closed. Red→green verified by
stash-swap: the two new test_tty legs FAIL on HEAD's kernel.js, pass on
Phase D's.

## 6. Tests (all red→green or re-baked with cause)

- `test_tty.js`: +2 legs — wide erase echoes 2×[BS SP BS], mixed-line
  KILL echoes width-true (1+2) triples. RED on pre-D kernel.js.
- `test_term_e2e.js`: +sessionWide — 2-cell tofu spans cells 0+1, X
  advances to cell 2, typed-CJK echo fills the continuation cell, ONE
  Backspace wipes it. Geometry goldens 432→456.
- `test_fontpkg_e2e.js` (NEW, registered in run.js): the W7 acceptance —
  minimal image renders 日本語 as ONE byte-identical tofu box ×3;
  `gucman install font-unifont` plants the /etc line and a fresh term
  renders three DISTINCT real glyphs; gdi32 proven via the notepad
  stderr tofu report (exactly 1 = pre-install process only); second
  package appends in order; removes keep the other line, last remove
  unlinks the file; tofu returns byte-identical.
- `test_user32_e2e.js` / os-shell.mjs / os-term.mjs: metric re-bakes
  (§2).
- `test_software_e2e.js`: the storefront now lists 11 packages — punes
  fell below the 5-card fold (wait-label needs vis=1); the test scrolls
  it into view with VK_DOWN before waiting.

## 7. The payoff

After `gucman install font-unifont`: the 日本語.txt that showed tofu in
v132 renders REAL glyphs — terminal (double-width cells), notepad/EDIT,
desktop icon labels + wm chrome (the gdi32 chain feeds wm.c's freetype
chrome from Phase C). Captured before/after → s3://groundupcoder/gucos/phaseD-cjk/.

---

# FONT-20px RETUNE (folded into Phase D, 2026-07-20)

jku switched sequencing b→a: the "chrome font 20px + AA + unify + full
layout re-tune" work (spec `~/git/meta/gucos/notes/font-bigger-aa-retune-
kickoff.md`, RCA `ui-polish-font-blur-rca-2026-07-19.md`) folds ONTO the
Noto commit in the SAME `unicode-phaseD` branch → ONE combined Noto+20px
increment, ONE user look-confirm. Image stays **v133** (no double bump).

## The one-line goal + why

ONE font, 20px, antialiased, EVERYWHERE — kill the 10px/14px size split
AND the 1-bit/AA split. Root cause of the blur/grain (RCA): the vendored
freetype has NO hinter, so unhinted outlines at ppem ≤12 smear; the 10px
chrome ALSO thresholded to 1-bit which amplified it. At 20px grayscale AA
is clean without a hinter (same reason the 14px nested menus already read
well). So: bigger + AA on, no hinter work.

## The change (chrome_font is now THE system font)

- **`wm.c` chrome_font**: `CHROME_PPEM` 10→**20**, `NONANTIALIASED_QUALITY`
  →**`DEFAULT_QUALITY`** (grayscale AA). Baseline math generalized: the
  bitmap-era `y+7-ascent` "7px cap cell" contract → `y+CHROME_CAP(14)`
  from real Noto@20 metrics (advance 12, cap 14, ascent 22, descent 6);
  every `(H-7)/2` centering → `(H-CHROME_CAP)/2`.
- **Unify — the anti-shortcut core** (RCA's three other text paths onto
  the SAME 20px-AA face):
  - `gdi32 STOCK_FONT_PX` 14→**20** — SYSTEM_FONT (user32 controls, the
    software center's default) now equals chrome_font.
  - `wm.c wmmc_win_begin` **selects chrome_font into the menucore DC** —
    nested Start-menu flyouts + ctx menus draw with the exact chrome
    font object, no fall-through (RCA Q6: the two-size/two-AA menu seam).
  - `software.c` font trio 20/15/12 → **-26/-20/-16** (body = the 20px
    em; RCA Q1 "software center grainy").
  - `compositor.js LABEL_FONT` bold 11px→**18px** + `LABEL_H` 16→26,
    coordinated with **`kernel.js WM_TITLE_H` 24→28 + WM_CLOSE_W 16→20**
    (the shared window-chrome rule — BOTH sides, plus the [min][max] box
    glyph interiors scaled identically in kernel.js headless composite
    AND compositor.js).
- **`menucore.h`**: MENU_BAR_H 20→30, MENU_ITEM_H 18→30, MENU_SEP_H 8→10,
  MENU_GUTTER 16→20 (menus fit the 20px rows).

## Full layout re-tune (every constant keyed to the old 6px/7px glyph)

wm.c: `BAR_H` 28→36, `START_W` 50→80, `BTN_W` 104→160, `CLOCK_W` 45→75,
`SHOWDESK_W`/`DATE_W`/`DATE_H`, `SM_SIDE_W` 22→30, `SM_COL_W` 170→260,
`SM_ROW_H` 20→28, `SM_SEARCH_H` 22→30, `RUN_W` 240→340, `RUN_H` 70→78,
desktop icon cell `CELL_W` 84→116 / `CELL_H` 64→96 / `ICON_W` 24→32 (all
seven procedural glyphs re-scaled inside the #82 center-pixel contract:
navy=program/dir/full-bin, white=data/empty-bin), label truncation
`text_fit(…,78)`→`CELL_W-8`, the RUN/rename/search field + caret heights,
the All-Programs cascade arrow, `saver_zoom` range halved (the 20px mask
is ~3× the 7px cell). paint.c sizes its window with
`GetSystemMetrics(SM_CYMENU)` instead of a hardcoded +20.

## Goldens re-baked (root cause on each, not blessed regressions)

Kernel (95/95): test_wm (80px test windows so the 20px title boxes fit;
box-glyph pixel probes), test_snap (BAR_H 36 → work-area 704, halves/
quarters/fixbox letterbox), test_wm_service (SM_*/BAR/CLOCK/RUN/DATE/peek/
datepop/taskbar-button/desktop-icon geometry — derived from the header
constants, one edit), test_ctxmenu + test_recycle + test_fileman_ops
(30px menu rows, 116×96 desktop cells, icon glyph pixels), test_desk_icons
(deskCell 116×96 in drive.js + 32px tile probes), test_calc (507×478 /
948×570 dialogs), test_winmine (BAR 30), test_notepad (30px menu shifts
the EDIT + status strip; probe/arrow/thumb clicks), test_paint (BAR 30 +
SM_CYMENU sizing), test_user32 (0236 statics regrown for the 28px cell +
12px-advance columns), test_sameboy/test_gpubox_menu (30px bar strip),
test_software (640×460 window, scrollbar at x=632). The fileman-family
`sel()` focus-click moved off the (100,100) row (29px rows made it a real
row that could double-click-open a file) to empty listbox space; row
clicks compute from the font-derived 29px pitch.

## Gate

compiler.js UNTOUCHED (no SameBoy). Kernel 95/95, browser sweep 33/33,
win32 ports 7/7. Image v133 (combined Noto + 20px). Before/after at 10px
(grainy) vs 20px (AA) + a 16px reference: s3://groundupcoder/gucos/font20-
retune/ (per-surface `-10px/-16px/-20px` + labeled `pairs/` side-by-sides).
