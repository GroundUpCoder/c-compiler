# 0029 — desktop icons: a folder-backed desktop layer

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/desktop-icons.md`)
- **Depends**: 0028 (shares the wm.c multi-window + spawn plumbing; also
  its dismiss story completes with this layer)
- **Design**: `todos/WM.md` "The desktop shell" (desktop-icons block).
  Note the free side effect: desktop clicks — invisible to the WM today
  (kernel hit-test returns `'desktop'` to the embedder only) — become
  ordinary client clicks on this layer. No protocol addition.

## Goal

`/root/Desktop` rendered as an icon grid on a fullscreen wm surface at
the bottom of z-order; double-click launches. The teal void becomes a
real desktop.

## Plan

- wm.c: fullscreen borderless surface, `WMP_RESTACK place=1` (bottom) at
  create, never raised; teal fill + icon grid (5×7-font labels, flat-rect
  glyph icons) from `readdir("/root/Desktop")`.
- Double-click via SDL event timestamps (threaded since 0025): symlink →
  spawn target (0028's spawn path); other regular file → `term vi <file>`.
- Recreate on EV_SCREEN (the taskbar's destroy+recreate pattern); re-read
  the folder on a coarse frame-tick timer (~1s).
- Seed `/root/Desktop` in image.json (symlinks: doom, quake, gameboy,
  term); bump image version. Post-0026 note: /root lands on the user
  volume — seeding semantics unchanged at seed time.

## Acceptance

- Headless (`test_wm_service_e2e.js` legs): layer sits at the bottom of
  `wmctl list` z; icons render (shot histogram over an icon cell);
  injected double-click on an icon spawns its target; EV_SCREEN
  recreates at the new size; windows and taskbar composite above it.
- Browser (`os-shell.mjs`): icons visible, double-click launches term,
  minimize reveals the desktop.
