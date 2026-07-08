# 0029 — desktop icons (the folder-backed desktop layer)

Landed `todos/0029`: `/root/Desktop` rendered as an icon grid on a
fullscreen borderless wm surface at the bottom of z. The teal void is a
real desktop now — and, the designed side effect, every "desktop" click
is an ordinary client click on this layer (it dismisses the Start menu;
no protocol addition).

## Decisions / findings

- **Third window, same dispatch**: taskbar / startmenu / desktop all live
  in the one wm process, told apart by `windowID` per event and by TITLE
  in their own EV_CREATED echoes (park-by-title: bar → bottom edge, menu →
  above the bar, desktop → (0,0) + `RESTACK place=1`).
- **Create-focus give-back**: creating furniture steals focus (kernel
  create-focus is mechanism). The desktop's EV_CREATED handler re-FOCUSes
  the model's focused window — this matters on wm respawn and EV_SCREEN
  recreate, where real windows exist. (Echo ordering makes this safe: the
  snapshot precedes our create echoes on the socket, so `wins[]` is
  populated by then.)
- **Own double-click detection, not `e.button.clicks`**: the SDL layer's
  click counter accumulates across WINDOWS (500ms + 32px in window-LOCAL
  coords), so a taskbar click could bleed a click-count into the desktop.
  wm.c tracks (icon idx, `e.button.timestamp`) itself — same icon within
  500ms launches. Single click = selection highlight.
- **`wmctl dblclick`** added (down/up/down/up on ONE connection): two
  separate `wmctl click` invocations are wasm-spawn-seconds apart, far
  outside any sane double-click window. Zero new protocol ops — it's four
  INJECT_POINTERs.
- **Launch semantics**: symlink → spawn via its `/root/Desktop/<name>`
  path (0028's spawn path); any other regular file → `term vi <file>`.
- **Dirty-flag drawing**: the desktop is fullscreen (~3MB/frame if
  redrawn per tick like the 28px taskbar); it redraws only when contents/
  selection/screen change. `/root/Desktop` is re-read every 60 frame
  ticks (~1s) and compared — `menu_ent` entries are memset-padded so
  memcmp change-detection is exact.
- **The desktop teal is the compositor background teal** — pixel asserts
  for "the layer exists" must use ICON pixels (or `wmctl list` z/geometry),
  never the fill.
- Headless icon-pixel assertion: the e2e writes `wmctl shot` to
  `/root/d.ppm` and the Node test reads it back out of the USER image
  (0026 split — `BLOCK_FS.createV4` over the raw `os-user.img` bytes,
  path `/d.ppm` after the mount-prefix strip) and histograms icon cell 0.
- Seeded `/root/Desktop`: doom, quake, gameboy, term symlinks.
  **Image version is v23.**

## Tests

- `tests/kernel/test_wm_service_e2e.js` desktop legs: fullscreen
  borderless at z 0 (windows + taskbar above), icon-cell histogram from
  the shot read back out of the user volume, single click does NOT
  launch, `wmctl dblclick` on the term icon spawns term.
- `tests/browser/os-shell.mjs` grew the 0029 legs: icon tile/glyph
  pixels, single-click navy selection, double-click launches term
  (waitNotPixel — freetype startup), desktop recreated at the LIVE
  screen size on the VT2-entry EV_SCREEN (asserted via `wmctl list`
  geometry), bottom-of-z, taskbar-minimize reveals the desktop.
