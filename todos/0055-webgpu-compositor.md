# 0055 — WebGPU compositor (no Canvas2D fallback)

- **Status**: open
- **Depends**: — (0016 proved worker WebGPU + the `gpu` transport; the
  harness already runs `webgpu-*` on headless Chromium/SwiftShader)
- **Design**: `WM.md` "Compositor" (the WebGPU pass was the designed
  architecture all along; Canvas2D was a documented v1 shortcut) +
  decision log `logs/2026-07-09/webgpu-mvu-direction.md`

## Goal

Replace the Canvas2D scene assembly in `os/compositor.js` with the
WebGPU render pass WM.md specifies: the platform's compositor IS
WebGPU. **No Canvas2D fallback** (decision 2026-07-09): a fallback
means two compositors, one a permanently undertested zombie. WebGPU
unavailable in the kernel worker → a LOUD boot guard, not quiet
degradation.

## Plan

- One render pass per rAF in the kernel worker, z-ordered textured
  quads over the scene list (`kernel.wmScene()` stays the single source
  of truth — this item touches only the browser drawing half):
  - **shm surfaces**: per-surface `GPUTexture` cache, `writeTexture`
    upload gated on frameSeq (same seq/size discipline as today's
    scratch-canvas cache — idle surfaces upload nothing).
  - **gpu surfaces**: `copyExternalImageToTexture` from the arriving
    ImageBitmap (import-then-close lifetime discipline unchanged).
    gpubox frames then never touch a CPU pixel path end-to-end.
  - **Sampling**: nearest-neighbor, same dst-viewport mapping as the
    headless composite (todos/0024) — pixel asserts must not move.
- Chrome (border, title bar, boxes, rubber band) as flat-color quads
  from the same `WM_*` metrics/colors that drive hit-testing and the
  headless composite. Title text via small cached label textures
  (rasterize with a throwaway 2D canvas, upload once per title string —
  a texture *source*, not scene assembly).
- Canvas context `configure({alphaMode: 'opaque'})`; reconfigure on
  `screen-resize` (the canonical dance gpubox already does).
- **Boot guard**: probe `navigator.gpu` + requestAdapter in
  kernel-worker.js at boot (alongside the 0045 web-lock, before mounts);
  failure → `{type:'boot-nogpu'}` → os.html guard screen naming the
  requirement (the 0045 `boot-locked` pattern). A tty-only (VT1)
  maintenance boot was considered and REJECTED — same zombie-mode
  reasoning as the fallback.
- **Delete** the Canvas2D draw path outright. `routeInput` and the
  scene accessors are untouched.
- Out of scope (follow-ups ride this pass later): per-pixel alpha
  surfaces, blur/shadows/animation (the Aero wave), damage rects
  (deliberately deferred per WM.md's cost envelope).

## Non-goals / invariants

- The headless deterministic CPU composite (`wmctl shot`, kernel.js) is
  UNTOUCHED — bit-exact goldens stay the headless contract. boot.js and
  the kernel suite never construct a compositor; zero headless impact.
- No app-facing or protocol change: transports, SURFACE_* opcodes, and
  the WMP are exactly as before.

## Acceptance

- All existing browser pixel suites green unmodified (os-boots, os-wm,
  os-doom, os-gpubox, os-quake, os-term, os-vt, os-screen, os-scale,
  os-shell) — any tolerance loosening is a red flag, not a fix.
- gpubox composites via texture import (no ImageBitmap→drawImage hop);
  doom/term (shm) composite via seq-gated writeTexture.
- A WebGPU-unavailable boot (flag-disabled Chromium run) shows the
  guard screen; `__osState` exposes it for the probe.
