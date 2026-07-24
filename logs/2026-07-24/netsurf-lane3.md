# NetSurf Lane 3 — the app shell: real seeds, openwith, history, status line

Lane 3 of the NetSurf stream (Lanes 1+2 merged @3d21fa01) turns the
working-but-test-shimmed frontend into a first-class installed gucOS app.
Lane 2's e2e installed the binary + resources into `/var/local` (an explicit
test-only shim); that shim is gone — everything now comes from baked
`os/image.json` seeds (v159).

## Package vs bake — DECIDED: bake into the base image

The browser is a flagship capability, the openwith + menu + font seed model
is image.json-native, and the measured costs are small: the app builds in
~30 s at bake time (3.0 MB wasm), and the four sans faces add ~2.5 MB.
Control-vs-lane bake grew 98.1 MB → 104.0 MB (~6%). A gucman package would
buy back that 6% at the cost of the default image shipping a browser that
can't open `.html` out of the box. Baked. (The `font-*` CJK packages stay
packages — they're 12–35 MB each; different trade.)

## What's seeded (image.json v159, all additive — file-level imgdiff verified)

- `/usr/bin/netsurf` ← `vendor/netsurf/gucos/bin.json` (the Lane 2 app).
- `/usr/share/netsurf/`: `Messages` (← the vendored `resources/Messages.en`,
  upstream's en split of FatMessages), `default.css` / `quirks.css` /
  `internal.css` / `adblock.css`, `netsurf.png` + `favicon.png`, and a
  `mime.types` seed (monkey filetype resolver format; adds `txt`/`md`/etc —
  the builtin hash already covers html/css/images; `/etc/mime.types`
  overrides). The frontend's `GUCOS_RESPATH` was already
  `/usr/local/share/netsurf/:/usr/share/netsurf/` — user overlay territory
  stays first, no code change needed.
- **Proportional sans family**: `/usr/share/fonts/sans.ttf`, `sans_bold.ttf`,
  `sans_italic.ttf`, `sans_italic_bold.ttf` ← Noto Sans hinted TTFs
  (`vendor/fonts/NotoSans-*.ttf`, notofonts.github.io, fetched 2026-07-24,
  sha256 in `vendor/fonts/README.md`, SIL OFL 1.1). TrueType-flavored
  (`glyf`) — the vendored freetype registers only the TrueType driver, the
  constraint that picked every vendor/fonts file. The frontend probes
  `/etc/fonts` > `/usr/share/fonts` per generic family and falls back to
  sans for serif/cursive/fantasy (and previously fell back to MONO for
  everything) — so this one family upgrades every non-mono CSS family from
  mono fallback to real proportional rendering. Serif stays a deliberate
  sans-fallback (a Noto Serif family is another ~2.5 MB; add it if/when a
  page corpus argues for it).
- **openwith**: `html` + `htm` → `/bin/netsurf` in the baked
  `/usr/share/openwith` (the per-key overlay means user/admin layers keep
  winning; `default.gui` untouched). This is the one resolver shared by
  wm.c (desktop double-click), fileman and `open(1)` — the e2e drives it
  through `open`.
- **Start menu**: `/usr/share/menu/Accessories/netsurf` link (no-arg run
  opens `about:blank`). No Desktop icon seeded — the `user` section only
  seeds virgin root volumes; deferred with the rest of the L4 polish.

## Frontend surface added (vendor/netsurf/gucos)

- **Status line** (`gui_window_set_status`): the bottom `STATUS_H` = 18 rows
  of the window are a silver strip (Win95 language: `0xC0C0C0` ground,
  `0x808080` hairline) with the status text at 11pt sans — loading
  progress, then "Done (…)", then the hovered link URL. Monkey-shaped
  minimal: no toolbar/URL bar/scrollbars (explicitly deferred). The content
  viewport is now window-minus-strip: `get_dimensions`/reformat/scroll
  clamp/PageUp/Down all use `gucos_content_h()`; content redraw clips to
  the viewport, the strip redraws when the damage box reaches it; presses
  on the strip are chrome (ignored), motion/wheel clamp to the viewport
  (releases still flow so in-content drags can end anywhere). Status text
  renders through the frontend's own plot path (`gucos_plotters.text` +
  the glyph cache) — no second text stack.
- **History keys**: Alt+Left / Alt+Right → `browser_window_history_back/
  forward` (availability-checked); unclaimed Backspace (outside a text
  input — the core claims it first) also goes back, the classic chord.
  NetSurf's local history was already compiled in (`desktop/
  browser_history.c` in netsurf-core.json) — this is pure key wiring.

## e2e rework (tests/kernel/test_netsurf_e2e.js)

No build step, no `/var/local` — the test only plants the three test PAGES
on the root volume and drives the BAKED app. New legs on top of Lane 2's
story: (a) the hello window is opened via `open /root/hello.html` — the
baked association resolving through the shared openwith.h path; (b) status:
`wmctl hover` over the link block → strip shows dark text pixels AND
differs from the settled pre-hover shot; (c) history: Alt+Left after the
link-nav returns to Squares (title barrier + restored float bands),
Alt+Right re-renders Two. Injection detail: `wmctl key SID SCANCODE KEYSYM
MOD` already carries a mod word (256 = LALT) end-to-end, no new plumbing.
New sync helper `pollStable` (shot until two consecutive frames match)
settles the post-title-barrier window before shots that later serve as
change-references — the late "Done" status repaint lands just after the
`<title>` barrier and would otherwise race `pollChange`. All waits succeed
or fail loud (no expected-timeout waits).

Geometry note: viewport heights in the assertions are content rows
(600→582, 400→382); the strip rows are asserted silver, and the
mostly-red two.html sampler samples the content area only.

## Verification

- Reworked e2e: PASS (36/36 checks) against the baked fixture.
- Visual check (PNG of the hello shot): real proportional Noto Sans (bold
  h1 + regular body — unmistakably not mono), status bar "Done (0.1s)".
- Additive-bake gate: control (@3d21fa01, main tree) vs lane, both
  `--packages=all`, file-level walk: onlyA=0, onlyB=14 (exactly the new
  seeds), differing = quake `__TIME__` noise (6 bytes, the known profile),
  `/usr/share/openwith` (+35 bytes = the two keys), `os-release` (version
  digit). Zero unrelated files touched.

## Deferred to L4 / later

- Desktop icon + a `data:`-URL demo page / welcome page seed.
- Noto Serif family (serif renders as sans meanwhile).
- Browser-sweep goldens + broader page corpus (Lane 4's lane).
- mono_bold.ttf (bold monospace renders as regular mono).
