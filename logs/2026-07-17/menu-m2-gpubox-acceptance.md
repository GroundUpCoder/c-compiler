# Menu M2 — gpubox win32 menu acceptance gate (todos/0258)

The mandate's acceptance gate: prove a GPU app's menu is first-class on the SAME
code path as a CPU app's, over a live WebGPU present.

## What landed
- **gpubox → minimal win32 app** (os/gpubox.c, +302/-104): RegisterClass (style
  `CS_OWNCLIENT`) + CreateWindowEx replace SDL_CreateWindow; the SDL window is
  fetched via the new `GetWindowSDL` accessor and the WebGPU path (SDL_GetWGPUSurface,
  async adapter/device, wgpuSetMainLoopCallback) is unchanged. The frame loop swaps
  SDL_PollEvent for a PeekMessage pump (TranslateAccelerator/Message/Dispatch). A
  File/Options menu is built at WM_CREATE (File▸Open Scene…/Quit, Options▸Spin/
  Wireframe); WM_COMMAND(Spin) toggles the rotation flag + CheckMenuItem.
- **CS_OWNCLIENT + GetWindowSDL** (user32.c +63; windows.h `CS_OWNCLIENT 0x00040000`):
  the app-presented-client seam (A6 — transport-neutral, GPU is one instance not the
  definition). user32 suppresses WM_PAINT synthesis and never calls
  GetWindowSurface/UpdateWindowSurface on such a window; GetDC fails loudly (no CPU
  plane). First and only consumer is gpubox.
- **A14 no-Dawn survival:** on adapter/device/surface acquisition failure, gpubox no
  longer exits — it keeps the window + menu + pump alive over a dead (black) client,
  so the acceptance e2e runs WITHOUT Dawn (honest graceful degradation).

## Gate (image v118)
- Headless-no-Dawn e2e: tests/kernel/test_gpubox_menu_e2e.js (forces tier 0 via the
  new tests/kernel/lib/nodawn-require.js) — bar/popup children over the black client,
  Spin/Wireframe via the agent. RED on the old tree (old gpubox exits 2 under no-Dawn).
- Browser real-cube leg: tests/browser/os-gpubox.mjs extended — cube animates → click
  Spin via wmctl → time-separated frame probes now equal, menu bar renders over the
  live cube.
- kernel 84/84, browser sweep 27/27 (incl os-user32 + os-gpubox real-cube). compiler.js
  UNTOUCHED — no codegen, no SameBoy. wm.c reseat deliberately deferred to M4.

## Note
Implemented by the M2 executor thread (fable), which hit its Claude Code session
limit during the final boundary check. The coordinator landed the close-out: the full
gate (kernel 84/84 + sweep 27/27) was re-run green before committing.
