# 0251 — menu build item 0 / A4: per-window GPU present binding (canvasBySid, bind at SDL_GetWGPUSurface)

- **Status**: done (2026-07-17) — landed in one commit with the red→green
  tests; both flavors per-window, veneer binds at SDL_GetWGPUSurface via
  SDL_GetWindowID, legacy handle-less import kept for pre-A4 binaries
- **Design**: the menu-uniform architecture note (external), §1.5/§3.6 + amendment A4

## Goal

The GPU present tail was a per-process SCALAR while shm was already
per-window: the browser flavor kept ONE worker-local OffscreenCanvas with
`currentSid` clobbered at EVERY window create, and headless Dawn's
`getTarget()` answered "newest window wins". A GPU app that opened a second
window had its ImageBitmap/readback presents silently repointed at the newest
window — a latent correctness bug independent of menus (the menu build's
kernel-anchored child subsurfaces depend on this being fixed first).

A4 explicitly struck the "≤1 GPU window per process" budget: fix the GENERAL
per-window form, not "bind newest→handle while freezing the canvas count at 1".

## Plan

- Browser flavor: `canvasBySid` — one OffscreenCanvas + present closure per
  GPU-presenting sid, symmetric with `fbByHandle`/`handleBySid`; configure
  sizes and resize-renegotiation target the sid's OWN canvas; destroy tears
  down only that sid's binding.
- Bind at `SDL_GetWGPUSurface` time: the veneer passes the window's host
  handle (`SDL_GetWindowID`) over a new
  `__wgpu_instance_create_surface_for_window` import. The handle-less
  `wgpuInstanceCreateSurface` import stays as the legacy tail
  (last-created-window semantics) so pre-A4 baked binaries keep working
  unchanged.
- Headless Dawn: surfaces store their bound window handle; the readback tail
  presents into `shmSurface.byHandle(handle)`, `getTarget()` newest-wins only
  for legacy handle-less surfaces.
- SDL_Renderer flush + software blit pass their window handle through
  `onPresent(handle)` so those presents also bind to their window.

## Acceptance

- `tests/host/test_gpu_present_binding.js` — browser flavor, mocked
  OffscreenCanvas/navigator.gpu: two windows, two surfaces, each present lands
  on its OWN sid from its OWN canvas; interleaves never cross; destroy drops
  only that window; legacy import keeps the old tail. RED pre-fix.
- `tests/kernel/test_gpu_multiwin_dawn_e2e.js` — real C under Dawn: two SDL
  windows, surfaces bound AFTER both exist (create, create, bind, bind),
  window A clears RED / window B GREEN — each window shows ITS color via
  `wmThumbnail`. RED pre-fix (A stayed black, both presents landed on B).
- Single-GPU-window unregressed: `test_gpubox_dawn_e2e.js` + the
  `os-gpubox.mjs` real-cube browser leg green.
- SameBoy byte-identical pre/post (the compiler.js delta is veneer-glue text
  only, no codegen).
