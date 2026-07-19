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
