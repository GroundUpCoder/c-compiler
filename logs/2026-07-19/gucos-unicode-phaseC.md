# gucOS Unicode Phase C — wm chrome freetype cutover (STAGE 1, tuning gate)

Branch `unicode-phaseC` off main @ 43bcfc5 (Phases A+B, v131). Kills W4 per
the D1 ruling: FULL freetype cutover for ALL wm.c chrome, fixed-ASCII
furniture included; the Win95 look preserved by rendering choice, not
codepath. **STAGE 1 stops at the human look sign-off**: the 5×7 table is
retained (unused) and no golden browser baselines were re-baked — both are
STAGE 2, after jku approves the side-by-side.

## The facility (approach (i) — the `__gdi_dc_wrap` seam)

ONE glyph path: wm.c's chrome text renders through the same gdi32/freetype
stack its menus (menucore, 0259) already use, via `__gdi_dc_wrap` over the
surface span (the child-control precedent). No second glyph cache, no
`wm_text.h`. The chrome font is one lazily-created HFONT:

    CreateFont(-10, …, NONANTIALIASED_QUALITY, FIXED_PITCH, "mono")

- `draw_text_s` → wrap DC, select chrome font, `SetBkMode(TRANSPARENT)`,
  `TextOut`, unwrap. `(x, y)` keeps its 5×7 meaning (y = top of the 7px cap
  cell): the baseline is pinned at `y + 7`, so every `(H - 7) / 2` centering
  in the chrome carries over byte-identical. Descenders extend below the old
  cell (every surface has room; the icon-label selection strip grew 11→12px
  and the rename box 13→14px to cover them).
- Measurement moved from byte-count×6 to real codepoint-aware widths:
  `text_w` (GetTextExtentPoint32 over a persistent 1×1 measure DC — the
  user32 g_scratchPx precedent), `text_fit` (prefix that fits, never splits
  a UTF-8 sequence), `text_tail` (input fields keep the line end visible).
  Converted call sites: taskbar button truncation, search box, RUN dialog,
  desktop rename editor, icon labels.
- The two specials are transforms of a rendered ink MASK (`text_mask`:
  TextOut into a scratch span, trim to the ink bbox): `draw_text_vert_s`
  rotates it 90° CCW for the gucOS band (now takes the band CENTER — the
  bbox varies with the string, unlike the fixed 7px strip), and
  `draw_text_zoom` blits z×z blocks for the marquee (`text_zoom_size` feeds
  the wrap/centering math that used `strlen*6*z` / `7*z`).
- Bonus (completes the story the rendering opens): the wm's own text fields
  (RUN, Start-menu search, icon rename) now accept non-ASCII keysyms —
  `u8_enc` insert + codepoint-wise Backspace (`__u8_prev`), gate
  `32 ≤ sym < 0x40000000, ≠127` replacing the old `< 127` ASCII gate.

## Tuning knobs (the heart of the gate)

- **ppem 10** (`CHROME_PPEM`). Roboto Mono's 0.6em advance lands at exactly
  **6px** — the 5×7 table's pitch — and caps stand ~7px, so all chrome
  geometry (CLOCK_W, row centering, cell math) holds without relayout.
  ppem 9 measured scrappy; 11–12 render well but break the 6px pitch.
- **Mono rendering** = `NONANTIALIASED_QUALITY` honored in gdi32's
  CreateFont (new, the real GDI semantic; windows.h grew the =3 define).
  Implementation: the vendored freetype build registers ONLY the smooth
  renderer and no hinter (`vendor/freetype/demo/myftmodule.h` /
  `myftoption.h` — no raster1 module, TT bytecode interpreter compiled
  out), so `FT_RENDER_MODE_MONO` fails outright. 1-bit output is produced
  by **thresholding the smooth coverage at ≥96** (`FT_MONO_THRESHOLD`,
  gdi32.c) — over the same unhinted outlines raster1 would give equivalent
  pixels anyway. 96, not 128: ≥128 measurably drops Roboto Mono's 1px 'T'
  stem at ppem 10 (ASCII-art harness, /tmp experiment; re-runnable).
  Escalation path if jku wants crisper: vendor `src/autofit` (real
  small-ppem hinting) — recorded, not needed on current evidence.

## The pre-existing gdi32 blend bug the gate exposed

`text_run`'s AA blend computed `a * (unsigned)(fr - br) / 255`: a negative
delta wraps as unsigned and the division no longer matches two's-complement,
so **full-coverage dark-on-light text has always landed at fr+1 per channel**
— "black" menu text was (1,1,1), the search ghost (129,129,129). Invisible
until the chrome e2e's exact-color histograms counted zero. Fixed with
signed math (`br + (int)a * (fr - br) / 255`); menus everywhere get 1-unit
truer colors as a side effect.

## Verification (Stage-1 light gate)

- v132-CANDIDATE bakes clean (`--packages=all`), headless boot OK.
- Kernel suites: wm.js, wm_policy, saver, snap, ctxmenu, user32, gdi32,
  winmine, fileman_ops, kernel32 e2es all green. `test_wm_service_e2e` has
  exactly ONE red leg — "search box is a sunken white field" samples a
  pixel the freetype "Search" ghost now covers (exact 128,128,128 ghost
  gray: proof the mono+blend path is pixel-exact). That's a chrome-pixel
  assert legitimately moved by the look change → Stage-2 golden territory,
  left red by design. Browser golden legs not run/re-baked (gate rule).
- Side-by-side booted-OS pairs at s3://groundupcoder/gucos/phaseC-tuning/
  (taskbar, startmenu, desktop-icons, run-dialog, marquee, desktop-full ×
  {before,after}; driver preserved the same viewport/geometry per pair).

## STAGE 2 — sign-off received, finalized

jku approved the D1 tuning gate (layout/metrics pixel-identical, mono keeps
the crisp bitmap character, caps→true-case reads MORE Win95-authentic).

- **5×7 table DELETED** (F_AZ/F_09/F_DASH/F_DOT + `glyph()`): grep-clean —
  zero references remain anywhere in the tree. The surviving "5x7" mentions
  are wm.c comments documenting the metric heritage (why ppem 10 / the y+7
  baseline) and `tests/kernel/fixtures/menubox/main.c`, an app-side test
  fixture with its OWN independent mini-glyph table (app-rendered test
  pixels, deliberately not wm chrome).
- **Golden re-bake — the swap moved exactly TWO asserts**, both the same
  class: a search-field "is white" sample point at (SM_SIDE+18,
  SM_SEARCH_Y+8) that the freetype "Search" ghost now covers with exact
  128,128,128 ink (the approved mono render — pixel-exact ghost gray is
  itself proof the mono+blend path works). Re-baked by moving the sample
  to SM_SIDE+150 (inside the field, clear of the ~45px ghost run):
  - `tests/kernel/test_wm_service_e2e.js` "search box is a sunken white
    field" (the Stage-1 known-red leg — resolved as the legitimate look
    change, not a bug).
  - `tests/browser/os-shell.mjs` "search box is a white field at the foot
    of the column" (the browser twin).
  Every other chrome pixel leg (clock histograms, taskbar face, band
  gradient, icon glyphs, aero blends, ctxmenu/wm/saver/snap legs) is
  threshold- or histogram-based and absorbed the font swap unchanged — the
  gdi32 signed-blend fix actually moved "black" text ONTO the exact-0
  values those histograms count.
- **Gate**: kernel suite **94 passed / 0 failed** (full run, 421.7s);
  browser sweep **33/33 green** (32/33 full run + os-shell green after the
  re-bake). Image v132 final, bakes sealed, boots headless and in-browser.
  compiler.js untouched (no SameBoy run needed).
- **CJK stays OPEN**: 日本語.txt rendering as visible tofu boxes is the
  honest partial (strictly better than the old invisible-blank), NOT "CJK
  fixed" — real coverage lands with Phase D (Noto face + fallback chain +
  font packages). No CJK todo/ticket closed on this stage.

## Honest look-delta vs 5×7

- Weight/pitch/height match closely: 6px pitch, ~7px caps, hard 1-bit
  edges. The marquee's chunky zoomed-pixel character survives intact.
- **The biggest visible change is case**: the 5×7 table was CAPS-ONLY
  (glyph() case-folded), so old chrome shouted "SETTINGS / RUN… /
  WINBOX / CAF .TXT". Freetype renders true mixed case ("Settings",
  "winbox", "café.txt") — closer to real Win95, but a real change.
- Glyph shapes are typographic (Roboto Mono) rather than HD44780-blocky:
  slightly rounder bowls, real lowercase with descenders. At 1× it reads
  crisp, not mushy; unevenness from the missing hinter is minor at ppem 10.
- Unicode wins visible in the pairs: é renders on icon labels; CJK shows
  honest tofu boxes (vs blank) until Phase D coverage.
