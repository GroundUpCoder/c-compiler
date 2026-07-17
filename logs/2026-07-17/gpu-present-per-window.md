# Per-window GPU present binding (menu build item 0 / A4) — todos/0251

The first landed piece of the menu build (kernel-anchored child subsurfaces):
a standalone host.js correctness fix the menu work depends on, not menu code.

## The defect

shm windows were already per-window (`fbByHandle`/`handleBySid`), but the GPU
present tail was a per-process scalar in both flavors:

- **Browser**: one worker-local `OffscreenCanvas(1,1)` + `currentSid`
  reassigned at EVERY `__sdl_create_window` ("one window per process (one
  canvas)"), and the resize renegotiation resized that one shared canvas on
  ANY window's configure.
- **Headless Dawn**: `getTarget()` returned the newest live window.

So a GPU app opening a second window (a menu child, a split-pane preview) had
its presents silently repointed at the newest window. The design review's A4
amendment struck the "≤1 GPU window per process" budget as the forbidden
"no current customer" pattern — the fix is the general per-window form.

## The shape

- `canvasBySid` (browser flavor): one OffscreenCanvas per GPU-presenting sid,
  handed out by `webgpuConfig.bindWindow(handle)`; the present closure
  captures (sid, canvas) and lands `hooks.surfaceFrame(sid, bmp)` on ITS
  window, with the 0019 pending-configure ack per-window. `onConfigure`
  resizes `canvasBySid.get(sid) || canvas`. Destroy deletes only that sid's
  entry.
- **Binding point**: `SDL_GetWGPUSurface` — the veneer (`__sdl3webgpu.c` in
  compiler.js) now passes the window's host handle (`SDL_GetWindowID`; the
  `SDL_Window*` itself is a wasm struct pointer, NOT the handle — first
  attempt tripped on that) over a new
  `__wgpu_instance_create_surface_for_window(instance, window)` import.
- **Headless Dawn**: the surface stores `winHandle`; `shmPresentTail` resolves
  `shmSurface.byHandle(winHandle)`; `getTarget()` survives only as the legacy
  tail.
- **Backward compat**: the handle-less `__wgpu_instance_create_surface`
  import is kept with its exact old semantics (browser: shared canvas +
  last-created-window tail via `legacySid`; headless: newest-wins), so pre-A4
  baked binaries (old browser OPFS images keep their old gpubox) still
  instantiate and behave as before. No image version bump: the rebaked gpubox
  behaves identically single-window; the new binding reaches persistent
  browser images at the next ordinary bump.
- **SDL_Renderer / blit tails**: `onPresent` now carries the presenting
  window's handle (renderer records its window at create; blit passes the
  UpdateWindowSurface handle), so those presents bind to their window too.
  Residual, surfaced not hidden: multiple SDL_Renderers in ONE process still
  share the one inner createBrowserSDL canvas (that component is single-canvas
  by construction; no consumer in-repo — os/ and vendor/ have zero
  SDL_CreateRenderer users — and standalone pages are one-canvas by nature).
  If a multi-renderer OS app ever appears, createBrowserSDL needs its own
  per-window-canvas refactor (cgpu/blit/pipeline state per canvas).

## Red→green

- `tests/kernel/test_gpu_multiwin_dawn_e2e.js`: real C, two windows, surfaces
  bound AFTER both exist (the ordering a newest-unbound heuristic would
  mis-bind), A clears RED / B GREEN. Pre-fix: A=[0,0,0], B=[0,255,0] — both
  presents landed on B, exactly the reported defect. Post-fix: each window
  shows its color (`wmThumbnail` full-size = exact front-buffer pixels).
  Stable 3/3 under `--under-load`.
- `tests/host/test_gpu_present_binding.js`: the browser flavor driven in Node
  over fake OffscreenCanvas/navigator.gpu — per-sid landings, per-canvas
  identity, interleaving, destroy isolation, legacy-tail compatibility.

## Gate

SameBoy byte-identical pre/post (the compiler.js delta is veneer C text only —
no codegen); unit 757 green (8 xfail), host suite green (new test registered),
blockfs 15/15, kernel 76/76 + the new e2e, browser sweep 27/27 including the
mandatory os-gpubox real-cube leg (live ImageBitmap present + resize
renegotiation through the new per-window path).

Scope guard note: the kickoff said "host.js only", but the window handle never
reached the host — the old veneer did `(void)window`. The design note's
landing-zone table assigns this fix to "host.js / SDL veneer", so the minimal
veneer glue (one import + the SDL_GetWGPUSurface body) landed with it; kernel
focus (`_focusSid`), user32, menu code, os/ C, image.json all untouched (A9 is
explicitly sequenced separately).
