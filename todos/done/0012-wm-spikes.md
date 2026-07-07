# 0012 — WM platform spikes (S1–S5)

- **Status**: DONE 2026-07-07 — all five verdicts recorded in `todos/WM.md`
  spike appendix. S1/S2/S4 PASS (harness kept: `tests/browser/wm-spikes.mjs`
  + `www/wm-spikes.html`); S3 PASS with the Dawn worker.terminate() caveat
  (`tests/spikes/s3_dawn.mjs`; `webgpu` devDependency in the repo's first
  package.json); S5 folded into `tests/kernel/test_wm.js` (the 10k-event
  storm). One spike verdict was WRONG in a useful way: rAF works in
  page-level workers but THROWS in nested workers — found and fixed during
  0013 (host.js setTimeout latch).
- **Depends**: 0007 (design: `todos/WM.md`, spike appendix)
- **Design**: `todos/WM.md`

## Goal

Verify the five platform assumptions the WM design leans on, before any
implementation unit lands. Small throwaway harnesses (browser scratch page +
Node scripts), results recorded back into WM.md's spike appendix.

- **S1** (gates the `gpu` transport): `transferToImageBitmap()` on a
  webgpu-context OffscreenCanvas in a dedicated worker stays GPU-backed
  through postMessage transfer + `copyExternalImageToTexture` — no hidden
  readback. If this fails, `direct` gets promoted and shm carries the
  interim.
- **S2**: rAF cadence/jitter in a busy kernel worker (compositor sharing a
  thread with RPC service) under fs load.
- **S3**: Dawn via the `webgpu` npm package (`dawn-gpu/node-webgpu`) under
  `worker_threads`: device per worker, render, `copyTextureToBuffer`
  readback; install footprint and platform coverage.
- **S4**: two-hop OffscreenCanvas transfer (DOM canvas → kernel worker →
  process worker) for the future `direct` kind.
- **S5**: input-ring throughput sanity (mousemove storms ≥250Hz through a
  ring into an SDL-style queue).

## Acceptance

Each spike has a written verdict (works / fails / caveats) in WM.md;
S1's verdict explicitly confirms or re-routes the `gpu` present tail.
