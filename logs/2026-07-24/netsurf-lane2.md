# NetSurf Lane 2 — the gucOS frontend: a real browser in a real window

Branch `netsurf-lane2` (off `671bea3e`, the Lane 1 merge). Lane 1 proved
the engine end-to-end under the headless monkey frontend; this lane
builds the **gucOS frontend** (`vendor/netsurf/gucos/`) — a Model B app
like DOOM/term — and proves a local `.html` document rendering into an
actual gucOS window with freetype AA text, working input, and
resize-reflow. `/bin` seeding, openwith, and the package/bake are Lane 3.

## Shape

- **Raster path: libnsfb plotters → RAM surface → SDL window surface
  blit.** libnsfb's 32bpp software plotters ARE NetSurf's 9-op plotter
  vocabulary, and its `NSFB_FMT_XBGR8888` byte layout (R,G,B,A) is
  exactly the SDL3 veneer's `SDL_PIXELFORMAT_RGBA32` window surface —
  so the frontend renders into a window-sized XBGR8888 RAM nsfb and
  presents by blitting the damaged rows with `| 0xFF000000` (netsurf
  colour values carry zero alpha) + `SDL_UpdateWindowSurface`. Chose
  the RAM-surface-plus-blit over rewriting libnsfb's SDL-1.2 surface
  backend: the vendored lib stays pristine (the SDL backend was already
  pruned at vendor time), resize is a plain `nsfb_set_geometry`, and
  the alpha-force pass needs a copy anyway. The blit is dirty-box
  scoped; the scroll-pan blit optimization (upstream fb's `fb_pan`)
  is a noted follow-up — scrolling full-redraws today.
- **Fonts: upstream `font_freetype.c` ported minus FTC.** The vendored
  freetype build carries no `src/cache/`, so the FTC manager/cmap/image
  caches became a frontend-owned rendered-glyph hash cache keyed
  (face, 26.6 size, codepoint), byte-bounded by the upstream
  `fb_font_cachesize` option (full flush on overflow — FTC's bounded+
  reclaimable contract). Face selection (`fb_fill_scalar`) and the
  3 layout ops (width/position/split) are upstream logic verbatim over
  the cached advances. Generic faces resolve option → /etc/fonts →
  /usr/share/fonts → respaths; sans falls back to the always-baked
  `mono.ttf` so a stock image renders real AA text (a seeded
  proportional face upgrades everything — Lane 3 candidate).
- **Scheduler + WAIT.** The fb frontend's `schedule.c` (timeval list)
  ported verbatim; the main loop is `schedule_run()` → drain SDL events
  → repaint damage → `SDL_WaitEventTimeout(NULL, next_deadline)`, which
  parks in the kernel's unified WAIT on the input ring (todos/0161
  seam) — an idle browser burns nothing, and every fetch/layout
  callback rides the scheduler so the timeout bound is exact.
- **Input.** SDL events → `browser_window_*`: press/drag-slop/click
  state machine per window (double/triple via the veneer's `clicks`),
  wheel → `browser_window_scroll_at_point` first (inner scrollables)
  then viewport scroll, keys → NS_KEY map (veneer keycodes are already
  modifier-applied unicode; Ctrl chords → SELECT_ALL/COPY/PASTE/CUT),
  unclaimed nav keys scroll. Caret drawn fb-style over the redraw.
- **Resize.** `SDL_WINDOW_RESIZABLE`; on RESIZED: re-fetch surface,
  resize the nsfb, and reformat **synchronously**
  (`browser_window_reformat`, term's apply_resize precedent) so the
  first present at the new geometry — the kernel's configure ack — is
  already the reflowed layout. First cut used
  `browser_window_schedule_reformat`; the e2e caught the stale-crop
  frame racing the ack (`wait dim` returned before the reflow paint).
- **Windows.** One SDL window per browsing context (created windows for
  every GW_CREATE flag — no tab strip); `<title>` → window title (the
  wmctl wait barrier in tests); kernel close → QUIT (last window) /
  CLOSE_REQUESTED (others) → `browser_window_destroy`, last destroy
  exits. Clipboard = the SDL veneer slot (cross-process). Thumbnail
  `bitmap_render` ported (urldb thumbnails work); `.corewindow`
  (history/cookie viewer windows) deliberately absent in v1.

## Patches (both verified byte-identical when re-applied to pristine)

- netsurf `utils/nsoption.{h,c}`: an `nsgucos` branch in the 3-site
  per-frontend options include chain → `gucos/options.h` (the fb font
  options + `url_file`). The frontend tree lives OUTSIDE the
  update.sh-managed components, so re-vendoring can't clobber it.
- libnsfb `src/surface.h` + `src/surface/surface.c` (new
  `patches/libnsfb.diff`, update.sh patch loop grew `libnsfb`):
  `NSFB_SURFACE_DEF`'s `__attribute__((constructor))` — unsupported by
  compiler.js — becomes an explicit registration entry under
  `__wasm__`, called lazily from the surface lookup paths.

## Proof

`tests/kernel/test_netsurf_e2e.js` (kernel suite, IMG row): builds the
~600-TU app (~30s), installs binary + engine resources onto the root
volume at `/var/local` (reachable through the baked `/usr/local`
symlink — Lane 3 owns real seeds), then in one boot: hello.html renders
(white page, glyph-core AND antialiased-gray pixel classes — real AA),
squares.html drives resize 800→500 (float squares re-wrap one band →
two: layout, not crop), wheel −3 (+300px, link block scrolls off),
PageDown (deep green marker scrolls in), Home + client click on the
`<a>` block → **navigates** to two.html (`wait win Two` = the title
barrier; red page pixels), `wmctl close` exits the process. Repaints
after scroll injections have no wmctl marker, so the driver polls
pixels (`cmp` against the prior shot — bounded condition poll, no fixed
sleeps). Also: `projects/netsurf-gucos` compile check (run.py explicit
entry — the vendor glob is one level), a `vendor/netsurf/` →
projects+kernel rule in tests/run.js, and the Lane 1 monkey smoke
still passes unchanged.

Visually verified (not just asserts): the desktop composite shows the
"Smoke" window with kernel chrome + taskbar button rendering the h1 +
paragraph in clean AA Noto Sans Mono.

## Gotchas for the next lane

- `wmctl wheel` positions the event at the LAST tracked motion; the
  wheel handler must not depend on event coords for the main-window
  scroll (scroll_at_point returns false for the root html anyway).
- The e2e installs to `/var/local/...` — when Lane 3 seeds
  `/usr/share/netsurf` + `/bin/netsurf`, the test can flip to the baked
  paths (or stay as-is; both are on the frontend's search path).
- Upstream's `plot_path` (bezier) is unimplemented in the fb frontend
  too; nothing emits paths in this handler configuration (no SVG).
- In-OS perf (risk 1): hello-class pages are instant; no big-page
  numbers yet. Image decode (risk 3) compiled + bitmap table is real
  (nsfb-backed), but no image-bearing page is exercised yet — worth a
  leg when Lane 3 seeds a demo page with a PNG.
