# 0024 — scaling fixed-size clients (per-surface dst rect)

Lands `todos/0024`. Design: WM.md "Screen, VTs, and scaling fixed-size
clients" (scaling block). Precedent shapes: Wayland `wp_viewport`, DWM
DPI virtualization, SDL3 logical presentation.

## What landed

A per-surface **dst viewport** (`dstW`/`dstH`, default = buffer dims) in
the kernel scene. The buffer never changes and the app never knows —
the compositor maps buffer → dst, input inverse-maps dst → buffer.
Fixed-size windows (doom, quake, gameboy) are now
**scalable-not-configurable**; resizable windows (0021 bit4) stay
**configurable-not-scalable**. One op set, exposed everywhere:
`wmSetDst` (kernel JS) / WMP `SET_DST 0x17` / `wmctl scale SID W H`.

- **Record grew 72 → 80 bytes**: `dst_w`, `dst_h` inserted after
  `frame_seq` (`reserved` stays last, title moves to offset 48). All
  three MUST-MATCH sides updated together (kernel.js WMP ↔ os/wm_proto.h
  ↔ test_wm_policy.js). `wmctl list` gained a DST column between
  GEOMETRY and Z (`-` when unscaled — greppable "is scaled" signal).
- **New events**: `EV_SCALED 0x88` (SET_DST echo, the EV_MOVED
  symmetry) and `EV_SCALE_REQ 0x89` (frame-drag release on a fixed-size
  surface; mechanism/policy split below).
- **Geometry switched to dst dims everywhere the screen is real**:
  hit-testing (title/client/frame bands, close box), title-drag clamp,
  wmSetScreen's one-shot clamp, wm.c's taskbar-aware re-clamp, both
  composites' chrome. What you click is what you see.
- **Input inverse-map**: client-bound pointer records compute
  `lx = (x − s.x) · w/dstW` (exact identity when unscaled). Agent
  injection (`wmInjectPointer`/WMP INJECT) deliberately stays in
  **buffer coords** — post-hit-test, resolution-independent tests.
- **Drag semantics** (the mechanism/policy split): the kernel now
  starts the 0019 rubber band on non-resizable frames too; at release
  it dispatches on the resizable bit — resizable → `wmResize`
  (configure, 0019/0021 unchanged); fixed → `EV_SCALE_REQ` to the WM,
  or raw `wmSetDst` with no subscriber (the no-WM fallback). **wm.c**
  answers with the largest aspect-correct dst fitting the box, snapping
  to an integer multiple when within 15% (the gameboy nicety; floors
  the SCALE, not the dims, so aspect survives the 32px kernel floor).
- **Browser compositor**: the per-surface ImageData cache became a
  scratch OffscreenCanvas (putImageData can't scale), drawn via
  `drawImage(cache, x, y, dstW, dstH)` with `imageSmoothingEnabled =
  false` — nearest, same mapping as headless. Set per frame: a canvas
  resize (0023 screen-resize) resets context state. gpu-transport
  bitmaps scale through the same drawImage call.
- **Headless composite**: NN row loop (`src = floor(dst · buf/dst)`) —
  integer scales are exact pixel replication, which the goldens assert.
- **winbox gained `winbox fixed`** (title "fixbox", no
  SDL_WINDOW_RESIZABLE): the light fixed-size acceptance app for the
  e2e + browser suites. image.json is **v18**.

## Decisions (don't re-litigate)

- **SET_DST on a resizable surface is refused** (R_ERR), and granting
  bit4 via SET_FLAGS snaps dst back to the buffer. Scaled and
  configurable are exclusive modes per surface — 0025's maximize
  dispatches on the same bit (configure vs scale-to-fit), and one mode
  per surface keeps hit-test/em geometry unambiguous.
- **Integer-snap lives in wm.c policy**, not the kernel or composite:
  the composite must honor the dst verbatim or hit-testing lies.
- **SURFACE_CONFIGURE ack resets dst to the new buffer dims** — the
  invariant "resizable ⇒ dst == buffer" holds at every mutation site
  (create, configure, set-flags).
- **`wmctl shot SID` stays buffer-res** (the app's real pixels; agents
  want those); only the screen composite scales.

## Gotchas hit

- `_wmDestroySurface` emits **EV_FOCUS before EV_DESTROYED** — the
  policy test initially asserted the reverse order.
- `test_os_apps_e2e` parsed `wmctl list` FLAGS positionally
  (`split('\t')[4]`); the DST column shifted it to `[5]`. The
  grep-title$ + leading-digit-sed parsers everywhere else survived
  unchanged (SID first, TITLE last was the right call in 0014).
- os-quake's "SE grip does nothing on fixed-res" leg inverted into the
  0024 acceptance: the same drag now scales quake to an aspect-fit
  400x250 (1.25x — outside the 15% snap window, deliberately).

## Verification

Unit 697✓ (3 pre-existing skips), host✓, blockfs✓, kernel suite✓ (incl.
the extended test_wm/test_wm_policy/test_wm_service_e2e legs: scaled
hit-test, inverse-map, EV_SCALE_REQ round trip, NN SHOT_SCREEN golden at
3x, wmctl scale/list on the real binaries). Browser (serial):
os-boots/os-wm/**os-scale (new)**/os-vt/os-doom/os-quake/os-gpubox/
os-term/os-screen.
