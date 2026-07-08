# Honoring SDL_WINDOW_RESIZABLE — resize gating (todos/0021)

**The bug** (todos/done/0021): drag-resizing a fixed-resolution app sheared
its image. doom and quake cache `SDL_GetWindowSurface()` once and blit at a
compile-time stride; they never handle `SDL_EVENT_WINDOW_RESIZED`, so after
a SURFACE_CONFIGURE the present path read the pixel buffer at the NEW width
while the app kept writing the OLD stride. Heap-safe (0019's high-water
rule) but visually garbage. Root cause: 0019 offered resize drags on every
window; `SDL_WINDOW_RESIZABLE` wasn't implemented anywhere. In real SDL3 a
`flags=0` window is non-resizable and never sees a resize — so the fix is
SDL3 conformance, not per-app patches.

## What landed

One new bit, dispatched everywhere resize can start:

- **host.js**: `SDL_WINDOW_RESIZABLE` (0x20) → kernel surface-flag **bit2**
  at `surfaceCreate` (next to the existing borderless bit0 mapping). The
  `kFlagsBySid` read-modify-write in `setRelativeMouse` already preserved
  unknown bits, so the relative-mouse path keeps bit2 intact for free.
- **kernel.js**: `surf.resizable` from create flags (and through
  `SURFACE_SET_FLAGS`, which replaces the whole word — that's the existing
  0018 contract). Gates:
  - frame hit-testing: a non-resizable surface has NO E/S/SE drag zones —
    the entire frame is a focus affordance, exactly like the left/top
    edges already were;
  - `wmResize` refuses (`false` → WMP `RESIZE` → R_ERR → `wmctl resize`
    exit 1), keeping the no-pending-state rule: a fixed app would never
    ack, so nothing may be left pending;
  - `wmList` exposes `resizable`; the WMP window record carries **bit4**
    (`WMP_F_RESIZABLE` in wm_proto.h, `R` in `wmctl list`'s FLAGS column,
    which grew 4→5 chars).
- **Apps**: winbox and term already declared the flag (pre-staged by 0020);
  **gpubox** now does too (its `wmctl resize` legs renegotiate a Dawn/gpu
  surface). doom/quake/gameboy stay `flags=0` — their unmodified vendor
  source is now *correct* rather than merely tolerated. **image.json → v16**
  (gpubox.c + wmctl.c are seeded sources).

## Gotchas hit

- `SURFACE_SET_FLAGS` replaces the full flag word, so a raw-RPC test that
  toggles bit1 (relative mouse) on a resizable surface must carry bit2
  along or it silently revokes resizability — test_wm_policy.js's resize
  leg deadlocked waiting for an EV_CONFIGURED that could never come.
  (Real apps are immune: host.js's `kFlagsBySid` word preserves the bit.)
- Tests that parse `wmctl list`'s FLAGS column needed the width bump:
  `f---` → `f---R` (test_wm_service_e2e), `f..r\t` → `f..r-\t`
  (os-quake.mjs).
- doom's window (1280x800 on the 800x500 screen) clips its frame edges
  off-canvas, so the browser no-resize-drag assertion lives in
  **os-quake.mjs** (320x200 — grip visible); doom's browser/headless
  coverage is `wmctl resize` → refused (test_os_apps_e2e.js + the doom
  1280x800 PPM re-check downstream of the refused resize).

## Coverage

- `test_wm.js`: create-without-bit2 → not resizable; wmResize refused,
  nothing pending, no client event; SE/E/S frame zones focus-only;
  SET_FLAGS bit2 grants at runtime (zones light up, wmResize works).
- `test_wm_policy.js`: record bit4 set/clear; RESIZE → R_ERR on a
  non-resizable surface, geometry unchanged.
- `test_wm_e2e.js` / `test_gpubox_dawn_e2e.js` / `test_term_e2e.js`: the
  positive path — real C apps declaring the flag still renegotiate.
- `test_os_apps_e2e.js`: `wmctl resize` on doom refused + no `R` flag.
- Browser: `os-quake.mjs` SE-grip drag is a no-op on fixed-res quake;
  `os-wm.mjs` winbox drag-resize unchanged.
