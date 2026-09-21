# 0161 — SDL_WaitEvent over pumpWait: take idle SDL apps off the vsync wake list

- **Status**: done (2026-07-13)
  **Unified framing:** see `todos/IDLE-POWER.md` — this item is piece C of the
  idle-zero design (idle apps stop producing frames); it is a prerequisite for
  the compositor ever parking, but insufficient alone. Read IDLE-POWER first.
- **Review notes (2026-07-12, verified against code):** (1) the seam checks
  out — `pumpWait` drains the input ring into the same wasm-side event queue
  `SDL_PollEvent` pops (host.js `__sdl_push_*` ~5963-6018), so
  `WaitEventTimeout` is `loop { PollEvent || __sdl_pump_wait(remaining) }`;
  the `Atomics.wait` timeout form is already in use (host.js ~6036). (2) The
  Goal's premise needs one correction: apps are NOT vsync-woken today —
  0100's vsyncWait shim was never wired into the browser SDL flavor, so app
  workers self-wake on the deadline-setTimeout pacer (IDLE-POWER Stage 1
  wires the shim first). (3) **wm.c is a REQUIRED adopter, not incremental**
  (IDLE-POWER piece W): without it nothing ever parks, and its conversion
  needs kernel WMP-socket→input-ring notify plumbing (`pumpWait` parks on
  the ring only; wm's events arrive on the socket).
- **Design**: this file + `todos/IDLE-POWER.md` (found profiling the 0119 mgp
  present path)

## Resolution

Landed 2026-07-13 (dev log: `logs/2026-07-13/waitevent-idle-park.md`):
`SDL_WaitEvent`/`SDL_WaitEventTimeout` in the SDL veneer as
`loop { PollEvent || __sdl_pump_wait(chunk) }` over the user32-GetMessage
seam — parked waiters are off the vsync heartbeat for free (they wait on
`IR_WPOS`, not `KP_VSYNC_SEQ`), chunked at 1s so env-import returns stay
cooperative-signal safe points; no-ring flavors get a `__nanosleep` fallback
pace (host.js stubs in createNullSDL/createBrowserSDL). mgp is the first
adopter: `sdlx_wait_event(2000)` parks a settled slide (peek-only, events
still flow through the one XCheckMaskEvent path). Image v86→v87. Test:
`tests/kernel/test_waitevent_e2e.js` (timeout, chunk-crossing wake,
signal-while-parked, NULL peek) — 3/3 stable under load; `tests/flake.js`
green; `test_present_e2e` 3/3 under load. Scope split per the review notes:
wm.c's conversion (socket→ring notify plumbing) is 0168, wake-counter
probes + compositor parking 0169.

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
