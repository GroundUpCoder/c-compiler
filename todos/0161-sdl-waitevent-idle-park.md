# 0161 — SDL_WaitEvent over pumpWait: take idle SDL apps off the vsync wake list

- **Status**: open
- **Design**: this file (found profiling the 0119 mgp present path)

## Goal

Every SDL app in this system is a **poll-loop** app: the veneer exposes
`SDL_PollEvent` but **no `SDL_WaitEvent`**, so apps register an
`emscripten_set_main_loop(fps=0)` callback driven by
`requestAnimationFrame` → `hooks.vsyncWait()` (todos/0100). Result: the
kernel's per-composite `vsyncTick()` wakes **every** app's worker ~60×/s —
even ones with nothing to do (a settled mgp slide, an idle editor/filemanager).
Each idle wake unparks a worker, runs a frame callback that finds no work, and
re-parks: N pointless worker wakeups per frame for N windows.

The block-on-input plumbing already exists but is used only by user32: its
blocking `GetMessage` calls host.js `__sdl_pump_wait` (`pumpWait`), which
drains the input ring and `Atomics.wait`s on `IR_WPOS` until the kernel's
`_wmPushEvent` notifies — i.e. an app parked there wakes ONLY on routed input,
not on vsync. That is exactly the semantics an idle SDL app wants.

Goal: **implement `SDL_WaitEvent`/`SDL_WaitEventTimeout` over `pumpWait`, and
only vsync-wake apps that are actually in a present/animation loop.** Apps that
adopt WaitEvent when idle drop off the heartbeat entirely → zero CPU when idle.
This is the real SDL idiom (event-driven UIs use WaitEvent; games poll+present)
— it's just unimplemented here.

## Plan

- Add `SDL_WaitEvent(ev)` and `SDL_WaitEventTimeout(ev, ms)` to the SDL veneer,
  routed to the existing `__sdl_pump_wait` import (the same seam user32 uses):
  drain the input ring; if dry, park on `IR_WPOS` (bounded by the timeout for
  WaitEventTimeout); on wake, return the dequeued event. Runs inside the import
  call so the event is in the wasm queue when it returns.
- Frame-loop driver (host.js): an app parked in WaitEvent is **not** on the
  vsync wake list. `vsyncTick()` only unparks apps that are vsync-parked (in an
  `emscripten_set_main_loop`/present loop). The kernel already notifies
  `IR_WPOS` on input, resize (SIGWINCH/EV), reload, etc., so a WaitEvent app
  still wakes for every real reason — just not 60×/s for nothing.
- **mgp as first adopter** (todos/0119): its upstream loop was `XNextEvent`
  (already block-on-input); the port flattened it to an
  `emscripten_set_main_loop` poll callback (`draw_one` returns 2 = "settled")
  for uniformity. Map "settled AND no pending `%pause`/fly-in animation" →
  `SDL_WaitEvent` (block), so a static slide costs zero; any in-progress
  animation stays on the poll/present path. This should be a small,
  self-contained change to mgp's `frame_loop`.
- Low-frequency pollers use the timeout form: wm.c's 1Hz `GET_IDLE`
  screensaver poll becomes `SDL_WaitEventTimeout(…, 1000)`, not a 60Hz spin.

## Acceptance

- A settled mgp slide (and an idle term/fileman once ported) generates **no**
  per-frame worker wakeups — verified by a wake counter — yet still repaints
  immediately on input, resize, focus and reload.
- Games/animations (doom, quake, gpubox, mgp mid-animation) are unchanged:
  still vsync-paced, one present per frame.
- No regressions in the kernel present/pty/wm e2es; run the flake gate
  (`tests/flake.js`) — this touches the frame loop and input-wake path.
- Composes with 0160 (compositor damage skip): idle apps don't wake AND the
  compositor skips submits → a genuinely idle system on a static screen. Do
  0160 first (safe, GPU-only); 0161 is the bigger CPU/wakeup win but changes
  the SDL wait contract, so land it app-by-app starting with mgp.
