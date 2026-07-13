# SDL_WaitEvent over pumpWait — idle SDL apps off the wake list (todos/0161, IDLE-POWER Stage 2)

## What landed

- **compiler.js (SDL veneer)**: `SDL_WaitEvent` / `SDL_WaitEventTimeout`,
  implemented as `loop { PollEvent || __sdl_pump_wait(chunk) }` over the
  exact seam user32's blocking GetMessage has used since 0058 (host.js
  `pumpWait`: drain the input ring into the wasm event queue, park on
  `IR_WPOS`). SDL3 semantics preserved: NULL event peeks, timeout <0 waits
  forever, false on timeout.
- **host.js**: `__sdl_pump_wait: () => 0` stubs in `createNullSDL` and
  `createBrowserSDL` so standalone flavors still instantiate an app that
  calls WaitEvent; the C side answers a 0 return (no ring) with a
  `__nanosleep` pace, so the timeout semantics hold without a hot spin.
- **mgp (first adopter, per the IDLE-POWER staging)**: `sdlx_wait_event(ms)`
  in sdlx.c (peek-only wrap, so every event still flows through the one
  `XCheckMaskEvent` path) + a `sdlx_wait_event(2000)` park in `frame_loop`'s
  settled branch (mgp.c). A settled slide now parks instead of re-entering a
  60 Hz frame callback to find no event; the 2 s cap keeps the
  timebar/wantreload idle duties on their upstream cadence.
- Image v86 → v87 (mgp + veneer are baked binaries).

## Why the park is chunked at 1 s

An env-import RETURN is the cooperative-signal safe point (host.js wraps
every env import with `ctx.deliverSignals()`). One unbounded `Atomics.wait`
would defer SIGTERM-class delivery forever — the kernel's signal post rings
`KP_DOORBELL`, not `IR_WPOS`, so a ring-parked waiter can't see it until the
chunk expires. 1 s chunks bound handler latency at ~1 s for ~1 wakeup/s idle
cost, which matches the IDLE-POWER honest-caveat table (wm.c's eventual
`WaitEventTimeout(1000)` loop has the same floor). Parking on the doorbell
instead was considered and rejected for this stage: it would change the
user32 GetMessage contract too, and the IDLE-POWER review blessed the
`IR_WPOS` seam specifically.

## Why a WaitEvent park is off the vsync wake list for free

`vsyncTick()` bumps+notifies `KP_VSYNC_SEQ` per pcb; a waiter parked on
`IR_WPOS` isn't waiting on that word, so the notify is a no-op wake-wise.
No frame-loop-driver change was needed — the 0161 item's plan line about it
predates the 0167 review finding (apps were never vsync-woken; they
self-woke on the setTimeout pacer, which Stage 1 replaced).

## Verification

- New `tests/kernel/test_waitevent_e2e.js` (real C app, real worker, real
  ring): no-ring fallback honors timeout; zero-timeout polls; full-timeout
  park returns false; an infinite wait crosses >2 chunks, ignores a phantom
  wake, and wakes <500 ms on `wmInjectKey`; SIGUSR1 posted mid-park runs its
  C handler at the next chunk boundary while the wait keeps waiting; NULL
  peek leaves the event for PollEvent. 14/14.
- `test_present_e2e.js` (mgp headless): slides still render, advance on
  space, gradient/GIF pixels intact — the park doesn't eat input or stall
  repaints.
- `node tests/run.js --diff` (unit, host, blockfs, projects, kernel, sweep)
  + `tests/flake.js` per the 0161 acceptance.

## Deliberately NOT here (later stages own it)

- wm.c's conversion (frame_cb → `WaitEventTimeout(1000)` loop) is Stage 3 =
  todos/0168, which also needs the WMP-socket→input-ring notify plumbing.
- Wake counters as probe surface + compositor parking = Stage 4 =
  todos/0169. The e2e's chunk-timing asserts are the Stage-2 proxy.
- term/fileman/notepad adopters: polish after 0168/0169.
