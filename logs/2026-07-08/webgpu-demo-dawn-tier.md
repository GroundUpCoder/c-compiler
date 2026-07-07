# 0016 — GPU apps windowed in-OS + the Dawn tier-1 suite

**What landed:** `/bin/gpubox` (os/gpubox.c, seeded, image.json v12) — an SDL
window rendered with **direct webgpu.h calls**: lambert-shaded cube, one
distinct color per face, frame-indexed rotation, `-f N` to freeze a pose. It is
the first end-to-end consumer of the WM's `gpu` transport, and it runs in all
three environments with zero app changes (WM.md invariant 1 held):

| environment | device | present |
|---|---|---|
| browser os.html | per-process `navigator.gpu` device in the nested worker | `wgpuSurfacePresent` → `transferToImageBitmap` → kernel (`{type:'wm-frame'}`, the S1 path) |
| headless + `webgpu` pkg (Dawn) | per-process Dawn device (`require('webgpu').create([])`) | render into a plain `GPUTexture` → `copyTextureToBuffer` readback → shm SAB flip |
| stock Node | none | clean adapter-unavailable; gpubox exits 2 |

## The machinery

- **`wgpuSurfacePresent` is now a real host import** (`__wgpu_surface_present`).
  It was a C-side no-op ("implicit on web") — correct for a DOM canvas, but the
  OS needs an explicit present moment: the browser flavor hooks the ImageBitmap
  handoff there, the Dawn flavor the readback tail. Canvas/standalone pages
  keep the no-op semantics (import provided, does nothing).
- **`createBrowserWebGPU` grew three seams** (host.js): `resolveGpu` (async GPU
  acquisition — the lazy Dawn probe), `shmSurface` (canvas-less surface: the
  "swapchain" is one texture with RENDER_ATTACHMENT|COPY_SRC OR'd in; present
  readback lands in the SDL window's shm SAB via mailbox flip, so **kernel
  screenshots can't tell Dawn output from a CPU app**), and `onPresent` (the
  browser OS handoff). `createSurfaceSDL` exposes the right combination as
  `sdl.webgpuConfig`; runModule prefers it over the standalone selection.
- **The Dawn probe is lazy and optional**: `require('webgpu')` in a try/catch,
  fired only on the process's first `wgpuInstanceRequestAdapter` — `ls` never
  loads a native addon, stock Node resolves null (tier 0 unchanged), and
  nothing in compiler.js/host.js/kernel.js/os/ hard-imports the package. Root
  `package.json` (devDependencies: webgpu) already existed from the S3 spike.
- **The S3 terminate caveat is engineered around, not ignored**: every Dawn
  promise (adapter/device/mapAsync) is tracked in an in-flight set;
  `ctx.gpuDrain` (allSettled + `device.destroy()` + a beat) is awaited by
  runModule **before the deferred EXIT handshake**. This is why gpubox quits
  via `SDL_Quit()` — a bare `exit()` inside a frame callback fires the EXIT RPC
  (and the kernel's `worker.terminate()`) before any drain can run. SIGKILL
  mid-frame remains the accepted crash risk of the optional tier. The tier-1
  suite's clean `wmctl close` lifecycle checks prove the drain works — an abort
  kills the whole boot, not just a check.

## Gotchas

- **Texture vs buffer usage constants**: texture COPY_SRC is 0x01, buffer
  COPY_SRC is 0x0004. The shim OR'd the buffer value into texture usage first
  try → Dawn validation error. The literals are commented in host.js now.
- `copyTextureToBuffer` needs 256-byte-aligned bytesPerRow; gpubox is 256×256
  so rows are exactly 1024B — but the shim pads/unpads generically (and
  swizzles bgra8unorm, though the shim's preferred format is rgba8unorm).
- The pose-0 center pixel is **exactly computable** from the shader math
  (l = normalize(0.3,0.4,0.9), k = 0.25+0.75·dot → (208,28,28)) and Dawn hit it
  bit-exactly on this machine — but the suite stays tolerance-diff (±30):
  GPU output is per-platform stable, not cross-platform bit-exact.

## Tests

- `tests/kernel/test_gpubox_dawn_e2e.js` (in run.js): boots os/boot.js, poses 0
  and 45, `wmctl shot` → byte-clean PPM extraction, tolerance asserts (lit red
  +Z face, clear-color corners, poses differ, ≥3 flat-lit colors when rotated),
  graceful-close lifecycle ×2. **Skips (exit 0) without the webgpu package** —
  verified by hiding node_modules/webgpu; tier-0 gpubox fails gracefully (exit 2).
- `tests/browser/os-gpubox.mjs` (manual, tier 2): real Chromium — cube
  composites through the gpu transport, corner is the render-pass clear color,
  **animates** (probe pixels change), `wmctl close` from the shell quits it,
  shell survives.
- Standalone regression: webgpu-renders.mjs + sdl3webgpu-renders.mjs green
  (recompiled against the new import; canvas present stays implicit).

## Open edges (recorded, not blocking)

- One window per process in the browser gpu flavor (v1 limitation, unchanged —
  gpubox is one window, nothing new discovered).
- Dawn's preferred format is pinned rgba8unorm on the shm tail; formats beyond
  rgba8/bgra8 fail loud at configure.
- A real-world WebGPU C app port is the wanted follow-up (unnumbered, WEBGPU.md
  candidates).
