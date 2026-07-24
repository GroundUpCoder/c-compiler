# Minesweeper T4-redo: the SDL 2D renderer is WebGPU-accelerated (software demoted to fallback)

T4 shipped the SDL 2D renderer (`SDL_Render*`) as a CPU software rasterizer in
BOTH `createSurfaceSDL` branches. jku rejected that as the shippable design:
GPU is first-class in this OS — the browser/desktop path must ride the existing
WebGPU renderer (`createBrowserSDL`'s `rdrEnsure`/`rdrFlush` pipelines), with
software kept only as a genuine no-WebGPU fallback. This entry lands the redo.

## Root cause — why the GPU renderer "didn't work" in process workers

T4's diagnosis ("the nested worker never drives createBrowserSDL's device")
was a symptom, not a cause. The real gap, confirmed via the gpubox diff: the
WebGPU device acquisition is an event-loop promise chain (requestAdapter →
requestDevice → configure) that was kicked LAZILY at the app's first
`SDL_CreateRenderer` — but OS SDL apps may legally BLOCK in their main loop
(`sdlDelay` is a real `Atomics.wait`, todos/0224), so once main() starts the
worker's event loop never turns again and the chain can neither resolve nor
reject. `rdrPipelines` stayed null and every present hit the drop-pre-device
branch (verified: a setTimeout queued at create_renderer never fires).
webgpu.h apps (gpubox) never hit this because their main() RETURNS (callback
model) — device + present path were always healthy on this same nested
worker/cgpu device. Purely a scheduling gap, not a capability gap.

## The fix (host.js)

- `runModule` awaits `sdl.gpuRendererReady()` BEFORE main() for any module
  that imports `__sdl_create_renderer` (tree-shaken imports make that a
  precise "uses SDL_Render*" signal — hush/ls/doom/webgpu.h apps pay nothing),
  so pipelines exist from frame one.
- The browser branch keeps createBrowserSDL's renderer env entries as the
  GPU tier and dispatches `SDL_Render*` through a two-tier `rdrBackend`
  switch: GPU when the device landed; `makeSoftwareRenderer` (shm flip — the
  tier headless always uses) ONLY if acquisition genuinely failed. Browser
  boot already hard-requires worker WebGPU (boot-nogpu), so the fallback is
  an escape hatch, never the shipping path.
- `createCanvasGPU` now fires its waiters on device-acquisition FAILURE too
  (`cg.failed`; callbacks guard on a null device), so a backend picker can
  fall back instead of hanging forever.
- Frames present through `rdrFlush` → `transferToImageBitmap` →
  `hooks.surfaceFrame` — the same gpu transport webgpu.h apps use. This also
  fixed the T4-era known limitation: size keys (Q/W/E/R/T) now REALLY resize
  (onConfigure re-sizes the canvas; the next matching-size bitmap acks).

## Review findings folded (from the pre-commit Fable review)

1. **ADD/MOD blend (must)**: the GPU tier renders them via real pipelines
   (`SDL_BLEND_DESC` modes 0/1/2/4); the software fallback's `put()` grew
   exact ADD (`dst + src*srcA`, clamped) and MOD (`src*dst`) arms mirroring
   those descriptors — no more accept-and-misrender as src-over.
2. **LINEAR scale (must)**: the GPU tier honors it via sampler swap; the
   fallback's textured `quad()` grew real bilinear (texel centers at
   integer+0.5, clamp-to-edge — the GPU sampler's semantics; 1:1 blits land
   frac 0, no blur).
3. **Coverage (must)**: new `tests/kernel/test_sdl_render_e2e.js` — in-OS
   `cc` builds a scene app (clear + one fill quad per blend mode + scaled +
   blended textures), `wmctl shot` pixel-asserts every arm exactly.
   Registered in the kernel run.js FILES registry; flake-gated stable 3/3
   under `--under-load` ×10. Headless it pins the software tier — which is
   itself the reason the fallback stays.
4. **Resize-ack contract**: verified NO inversion — `present()` acks only
   once a FULL frame rendered at the pending dims lands in the new SAB
   (exactly `shmPresent`'s gate), and `pendingCfg` can only exist once
   drainInput delivered RESIZED (same drain iteration that re-derives the
   C-side surface in place — the veneer's documented SDL3 semantics). A
   never-pumping binary never drains → keeps old geometry, same as the shm
   path. Contract now documented at `ensureFb`.
5. **Validation consistency**: `__sdl_set_draw_blend_mode` now validates
   {0,1,2,4} in the software AND null backends (GPU already did via
   `sdlBlendValidate`) — every backend rejects the same set identically.
6. **test_cc_libpng_e2e PACKAGES regex**: added the `m` flag (+`^`) so `$`
   is end-of-line, not end-of-stdout — no false fail if libpng sorts last.

## Proof the browser path is the GPU path (not the fallback)

`notes/run-minesweeper-demo.mjs` (real Chromium, serve.js, in-OS curl + tar +
`cc *.c` + run): the discriminator is that a gpu-transport surface has NO CPU
pixels — `wmctl shot` copies the never-written shm SAB. The demo asserts
NONZ=0 (byte-blank shot) for the SAME surface whose composited client area is
live on screen ⇒ every frame is an ImageBitmap out of `rdrFlush`. The software
fallback would have filled that SAB with the exact pixels being sampled.
Playability legs all pass: flood-uncover w/ colored numbers, right-click flag,
theme key, difficulty key, and the size-key W resize (328x414 → 552x638, live
frames after). Fresh screenshots: `tests/browser/shots-minesweeper/`.
Gotcha re-learned: a `echo PROBE-END` wait marker is satisfied by its own
typed echo (0171) — the probe waits on `/NONZ=\d/`, which the typed text
(`NONZ=$(`) cannot match.

## Gate (all green, this tree)

unit 774/0 · projects 29/0 · kernel 111/0 (incl. the new e2e) ·
browser regression os-doom (shm) / os-gpubox (webgpu.h) / os-wm ·
flake gate: test_sdl_render_e2e 3/3 stable under load ×10.
