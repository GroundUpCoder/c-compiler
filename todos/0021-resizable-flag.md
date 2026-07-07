# 0021 — honor SDL_WINDOW_RESIZABLE (fixed-res apps corrupt on resize)

- **Status**: open
- **Depends**: 0019 (SURFACE_CONFIGURE — the mechanism this gates)
- **Design**: `todos/WM.md` ("Implementation status — client resize");
  SDL3 semantics: a window is non-resizable unless created with
  `SDL_WINDOW_RESIZABLE`

## Bug

Drag-resizing a fixed-resolution app corrupts its image. doom and quake
cache `SDL_GetWindowSurface()` once and blit every frame with a
compile-time stride (`vendor/doom/src/main.c` `DG_DrawFrame`,
`vendor/quake/src/vid_sdl.c` `VID_Update`); they never handle
`SDL_EVENT_WINDOW_RESIZED`. After a SURFACE_CONFIGURE the present path
interprets the pixel buffer at the NEW width while the app keeps writing
at the OLD stride → sheared garbage (heap-safe per 0019's high-water
rule; visually wrong). Repro: run `doom` or `quake` in the browser, drag
the SE grip.

Root cause: `SDL_WINDOW_RESIZABLE` is not implemented anywhere (grep: no
matches), and the WM offers resize drags on every window. In real SDL3,
`flags=0` windows — what doom/quake/gameboy pass — are non-resizable and
never see a resize.

## Goal

Honor SDL3's resizable semantics end to end: `flags=0` windows must be
un-resizable; apps that can renegotiate opt in.

- SDL layer: define `SDL_WINDOW_RESIZABLE`, plumb it from window create
  to the kernel surface (create flags or SURFACE_SET_FLAGS).
- Kernel/WM policy: hit-testing skips E/S/SE resize zones on
  non-resizable surfaces; `wmResize` / WMP `RESIZE` / `wmctl resize`
  reject them with an error (no pending configure left behind).
- winbox/gpubox pass the flag (they already handle `WINDOW_RESIZED`);
  vendor apps need zero source changes — their `flags=0` is already
  correct.

Related but separate (note, not in scope): doom's window is
640×400×`WINDOW_SCALE 2` = 1280×800 on an 800×500 screen, so it
overflows regardless — that's a screen-size/placement question
(`os/os.html`'s fixed canvas), tracked with the desktop/terminal layout
design discussion, not a resize-protocol bug.

## Acceptance

- Browser: doom/quake windows expose no resize behavior on edges/grip;
  winbox/gpubox drag-resize still works (0019 suites stay green).
- Headless: `wmctl resize` against a non-resizable surface errors;
  kernel test covers the flag through create → hit-test → RESIZE reject.
