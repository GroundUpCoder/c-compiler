# 0024 — scaling fixed-size clients (per-surface dst rect)

- **Status**: done (2026-07-08; dev log
  `logs/2026-07-08/viewport-scaling.md`). Decided in-item: SET_DST on a
  resizable surface is REFUSED (exclusive modes; SET_FLAGS bit2 grant
  snaps dst back to the buffer); integer-snap lives in wm.c policy.
- **Depends**: — (no hard dependency; ordered after 0023 — DOOM filling
  the screen is the payoff and wants a full-viewport screen)
- **Design**: `todos/WM.md` ("Screen, VTs, and scaling fixed-size
  clients" → scaling block). Precedent: Wayland `wp_viewport` (buffer
  size ≠ surface size, compositor maps src→dst), DWM DPI virtualization
  (bitmap-stretch, app never knows), SDL3 logical presentation.

## Goal

Decouple buffer size from on-screen size: a per-surface **dst w×h** in
the scene list, buffer untouched, app oblivious. Non-resizable windows
(doom, quake, gameboy) become scalable-not-configurable — resize drags
and fit gestures adjust the dst rect; `SURFACE_CONFIGURE` is never
sent. DOOM then fits the screen with zero source changes (its
`WINDOW_SCALE 2` CPU pre-scale becomes redundant — present 640×400 raw).

## Plan

- **kernel.js scene**: per-surface `dstW/dstH` (default = w/h). New op
  exposed as `wmSetDst` / WMP `SET_DST` / `wmctl scale SID W H` (one op
  set, exposed everywhere). Dst dims ride the WMP LIST record.
- **Geometry switches from w/h to dst dims**: hit-testing, chrome
  (browser compositor + headless composite + hit-test metrics stay one
  set of numbers), move-clamp. Must be exhaustive — what you click is
  what you see.
- **Input inverse-map** (the real work): client-bound pointer records
  map `lx = (x − s.x) · w/dstW` (motion, buttons; wheel position).
  Decision: `wmInjectPointer`/WMP INJECT stay in **buffer coords**
  (post-hit-test, resolution-independent headless tests).
- **Browser compositor**: shm cache becomes a per-surface scratch
  OffscreenCanvas (paint ImageData on seq change), then
  `drawImage(cache, x, y, dstW, dstH)` with
  `imageSmoothingEnabled=false` (nearest — pixel-art correct).
  gpu-transport surfaces already drawImage → scale for free.
- **Headless composite**: nearest-neighbor row loop in
  `wmScreenshotScreen`; integer-scale snapping as the gameboy nicety.
- **Drag semantics** (mechanism/policy split): kernel re-enables the
  rubber band on non-resizable surfaces and at release emits the
  request to the WM (reuse the resize-request path); **wm.c** answers
  with an aspect-preserving letterboxed SET_DST. No-WM fallback: kernel
  applies the raw dst. Resizable surfaces keep 0021 semantics
  (configure, never scale) — one dispatch on flag bit4.
- Seeded wm.c/wmctl.c changes → image version bump.

## Acceptance

- Browser: drag a doom/gameboy frame edge → window scales (aspect
  letterboxed), input lands correctly inside the scaled client; winbox
  drag-resize still renegotiates (0019/0021 suites green).
- Headless: scaled hit-test + inverse-mapped injection kernel tests;
  `wmctl scale` + scaled `wmctl shot`-screen goldens (integer scale =
  exact nearest-neighbor expectation).
- `wmctl list` shows dst dims; SET_DST on a resizable surface refused
  (or defined + tested, if we choose to allow it — decide in-item).
