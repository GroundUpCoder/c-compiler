# 0013 — WM v1: kernel surfaces + compositor + SDL retarget

- **Status**: DONE 2026-07-07 (landed with 0012 in one thread; dev log:
  `logs/2026-07-07/wm-v1-implementation.md`)
- **Depends**: 0007 (design), 0012 (spikes)
- **Design**: `todos/WM.md` — see its "Implementation status v1" section
  for the shipped surface and the deliberate v1 deviations.

## What landed (WM.md plan units 2–5 + most of 7)

- kernel.js "WM surfaces": registry/z/focus, 0x1xxx RPCs, shm double-buffer
  transport (mailbox, no present RPC), per-process input ring,
  kernel-chrome v1 policy, agent channel (list/focus/move/inject/
  screenshot/screen-composite), lifecycle reclaim (exit + SIGKILL).
- host.js `createSurfaceSDL` (browser: WebGPU renderer + ImageBitmap
  handoff; both flavors: UpdateWindowSurface → shm), input drain in the
  frame loop, the main-loop exit-ordering fix, the nested-worker rAF latch.
- os/: compositor.js (Canvas2D scene draw in the kernel worker),
  os.html desktop pane + raw input bridge, /bin/winbox seeded (image v9).

## Acceptance evidence

- `tests/kernel/test_wm.js` — 34 checks over the SAB protocol (no wasm).
- `tests/kernel/test_wm_e2e.js` — real compiled C SDL app: pixels through
  shm, injected input through rings into SDL_PollEvent, chrome close →
  QUIT → exit code through the kernel.
- `tests/browser/os-wm.mjs` — real Chromium: `winbox &` from hush; window
  composited; click paints at local coords; key toggles; title drag moves;
  close box quits; shell survives.
- Full suites green: unit 697✓/3 skip, blockfs✓, kernel✓ (16 files),
  host✓, os-boots.mjs✓, standalone sdl-render✓.

## Explicitly NOT in v1 (queued onward)

/bin/wm policy client + wmctl + agent RPCs (0014); windowed doom/quake
in-OS (needs fs-resident vendor images + WADs); resize
(SURFACE_CONFIGURE); wasm terminal; audio mixing; Dawn tier-1 GPU suite.
