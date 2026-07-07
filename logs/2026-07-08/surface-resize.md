# 0019 — client resize: SURFACE_CONFIGURE buffer renegotiation

Landed todos/0019 — the deliberately-deferred fiddly part of the surface
protocol (WM.md's "Resize: not in v1" decision), on the opcode reserved for
exactly this. Windows in the OS are now resizable: kernel-chrome border
drags in the browser, `wmctl resize SID W H` from the shell, `wmResize`
from the agent channel — winbox (shm), gpubox (gpu transport in Chromium,
readback tail under Dawn), and any future SDL/webgpu.h app that handles
`SDL_EVENT_WINDOW_RESIZED`.

## The protocol shape (why it's tear-free by construction)

The classic resize hazards are buffer renegotiation and in-flight frames.
The design dodges both with one rule: **the kernel swaps buffers only at
the client's ack, and the ack's new SAB already contains the first frame
at the new size.**

- Request (kernel → client): a `WINDOW_RESIZED` (0x206, the SDL3 value —
  the ring carries SDL event types verbatim) record on the input ring,
  words [2]=w [3]=h. The ring is the *existing* kernel→process channel;
  RPCs only flow the other way, so no new transport was needed.
- Renegotiation (host.js): on seeing the record, `createSurfaceSDL`
  allocates the NEW fb SAB *before* pushing the event into the wasm, so
  the app's same-tick redraw at the new size finds it waiting. Presents
  are then routed by size: a present at the pending size lands in the new
  SAB (and triggers the ack); old-size in-flight presents keep landing in
  the OLD SAB — which is still the one on screen — so a slow adopter's
  animation stays live mid-negotiation. An app that never handles the
  event simply keeps its old geometry forever (graceful degradation for
  pre-0019 binaries).
- Ack (client → kernel): `SURFACE_CONFIGURE` (0x1005), the new SAB riding
  `{type:'wm-sabs'}` — the create handshake verbatim. The kernel validates
  (owner, pending, magic, dims), swaps `sab/i32/u8/w/h` atomically, emits
  `EV_CONFIGURED`. Flips on the abandoned old SAB are never looked at
  again — "in-flight old-size frames are legal and ignored" falls out of
  mailbox semantics rather than needing code.

**Latest wins.** A second request while one is pending replaces it. A
stale ack (client acked a size that was superseded mid-negotiation) is
*accepted* — the acked buffer is strictly newer than what's on screen —
and the kernel immediately re-issues the configure for the still-pending
size. This is the one-in-flight coalescing pattern without needing the
host to track anything. A request that can't reach the client (dead
process, full ring) leaves no pending state: nothing would ever ack it.

## Chrome: the frame border + outline drags (decision)

Non-borderless windows grew a 4px (`WM_BORDER`) Win95-ish frame around
title+client — the same numbers drive hit-testing, the browser compositor,
and the headless composite, per the chrome rule. Zones: right edge → E,
bottom edge → S, within `WM_GRIP` (16px) of the SE corner → SE. Left/top
edges are focus-only: moving-edge resizes change x/y *and* size at ack
time, a coordination problem deliberately deferred. Drags preview as a
dashed rubber-band outline (compositor reads `wmScene().resizeDrag`) and
send ONE configure at release — authentic Win95 outline-resize, and it
avoids allocating a fresh multi-MB SAB per mousemove. Floor `WM_MIN_SIZE`
32px per axis, ceiling 8192 (same as create).

## Client side

- **SDL layer (compiler.js)**: the 0x202–0x207 window-event block,
  `SDL_WindowEvent`, `SDL_GetWindowSize`, and `__sdl_push_window_event`,
  which re-derives the window surface IN PLACE before queueing the event.
  The pixel allocation is **high-water** (only ever grows): a program that
  keeps drawing with stale dimensions (compile-time W/H macros — winbox
  before this change) writes inside the allocation instead of corrupting
  the heap. Re-fetching `SDL_GetWindowSurface` after the event is the SDL3
  contract; here it returns the same pointer with current fields.
- **gpu transport (browser)**: the resize handler re-sizes the worker-local
  OffscreenCanvas (mirroring `__sdl_create_window`); a webgpu.h app's own
  `wgpuSurfaceConfigure` sizes it again idempotently. The ack is gated on
  the first ImageBitmap at the pending size and sent BEFORE the bitmap, so
  the kernel geometry is already new when the frame lands (no one-frame
  scaled draw).
- **Dawn tier**: `wgpuSurfaceConfigure` re-creation of the readback
  texture/buffer already existed; the ack rides the shm present tail's
  size gate. gpubox.c now does the canonical resize dance (reconfigure
  surface + rebuild depth) — same C in all three environments.

## Gotchas found

- **Compositor ImageData cache**: keyed by frameSeq alone, it would
  collide across the SAB swap (fresh SAB restarts seq) and serve a
  stale-size image — the cache check now also compares dimensions.
- **os-wm.mjs sampled 3px outside the window** to assert WM placement;
  that pixel is now inside the frame border. Moved to 7px.
- **os-gpubox.mjs is environmentally flaky** (WebGPU adapter availability
  in headless Chromium): during this landing the *pre-change* tree failed
  3/3 in one window and passed in another; the failure mode is "cube never
  composited", upstream of anything 0019 touches. When an adapter is
  available the full test including the new resize leg passes. Known
  manual-tier noise, not a regression.

## Verification

unit 697✓ (3 pre-existing skips), host✓, blockfs✓, kernel suite✓ —
including new: test_wm renegotiation section (bad acks, in-flight old-size
frame, superseded/stale-ack re-ask, E/SE border drags, clamps, composite
border), test_wm_policy RESIZE/EV_CONFIGURED, test_wm_e2e real-C resize leg
(compiled app handles the event, ack swaps, pixels at the new size),
test_gpubox_dawn_e2e 320x200 resize leg (re-rendered, not scaled; depth
matches color). Browser: os-boots✓, os-wm✓ (drag-resize 240x160→300x200
through real mouse events), os-doom✓, os-gpubox✓ (wmctl resize leg; see
flake note). image.json v13 (winbox/gpubox/wmctl/wm_proto.h reseed).
