# #551 redesign — unconditional blocking-loop refusal + SDL_MAIN_USE_CALLBACKS

Branch `lane-551b`, off `keepup-device-loss` @ `0b223ea8` (legs A+B kept).
Design authority: the #551 ticket comments (jku's veto of leg C, the
unconditional-refusal decision, the SDL_MAIN_USE_CALLBACKS scope growth).

## What replaced leg C

Leg C (OS SDL_Render\* apps silently rasterizing software→shm) is REVERTED —
the GPU renderer + pre-main `gpuRendererReady` acquisition are back, exactly
as before `71321c3c`. In its place:

1. **The refusal** (host.js, browser surface flavor): a GPU-transport
   present (`transferToImageBitmap` ship) issued **while `main()` is still
   on the stack** refuses at the FIRST present — message on the app's real
   fd 2 (brokered write, respects `2>`), exit **69** (EX_UNAVAILABLE)
   through the ordered kernel handshake, unwind via a marked throw that
   runModule converts to a clean exit when no kernel tears the worker down
   first. Armed by runModule around the wasm entry (`setMainLive`); unit
   tests driving the backend directly never arm it. The trigger is the
   LOOP MODEL, deliberately not a park: the poll-only spin loop never
   parks and floods hardest (jku's correction on the ticket). Unconditional
   — fires on JSPI browsers too; when suspending frame-loop parks land the
   rule RELAXES, never unwinds.

2. **The sanctioned alternative, shipped WITH the refusal**:
   `SDL_MAIN_USE_CALLBACKS` — real SDL3 semantics (`SDL_AppInit`/
   `SDL_AppIterate`/`SDL_AppEvent`/`SDL_AppQuit`, `SDL_AppResult`), emitted
   from `<SDL.h>` or `<SDL3/SDL_main.h>` via a `#pragma once` chunk
   (`__SDL_main.h`) so both SDL3-documented include orderings work. The
   header-provided `main()` runs AppInit, registers the frame driver on
   `__sdl_set_animation_frame_func`, and returns; the driver polls events
   to AppEvent, calls AppIterate, and on a non-CONTINUE result runs
   AppQuit + `SDL_Quit`. `SDL_APP_FAILURE` → exit 1 through a new
   `__sdl_app_result` export read AFTER the frame loop stops — no in-frame
   `exit()`, so the Dawn drain keeps its S3-safe order.

3. **Demo conversions**: `pollball` is the pure-SDL reference callback app.
   `gpubox` is the win32+webgpu.h reference: under the callback entry the
   driver owns `SDL_PollEvent`, so user32 grew `__u32_feed_sdl_event`
   (pump_sdl's switch body extracted verbatim, by-value param) and
   gpubox's `SDL_AppEvent` forwards each event there; `SDL_AppIterate` is
   the old `frame()` (PeekMessage pump + render), WM_QUIT →
   `SDL_APP_SUCCESS`.

## Corrections to the ticket record (verified, measured)

- **gpubox was never in the refusal's blast radius.** The ticket inventory
  called it "webgpu.h, blocking loop"; its `main()` in fact returned after
  `wgpuSetMainLoopCallback` — it always presented from the callback path.
  The conversion makes it the reference for the mandated pattern; it was
  not a rescue.
- **The prior lane's residual "webgpu.h apps still burn budget at ≤60
  ships/s → ghost-freeze after ~4.6 min" is REFUTED.** That figure was an
  extrapolation (16,744 ÷ 60/s ≈ 4.6 min), not a measurement. Measured
  here: converted pollball (callback loop, `vsyncWait` =
  `Atomics.waitAsync`, i.e. a real event-loop yield between frames) ran
  **6.0 min continuous, 30,038 ships, zero device losses, steady
  ~5,000 ships/min, still shipping at cutoff** — 1.8× past the
  blocked-worker wall. Yielding recycles; the wall belongs to BLOCKED
  producers only, exactly as the probe matrix said.

## The failure message

One clearly-marked template in host.js (`blockingPresentMessage`), populated
at runtime: program, pid, browser (UA-parsed) + JSPI availability, renderer
tier (SDL_Renderer vs webgpu.h surface). Per jku's rulings it quotes **no
vendor budget figure** (the 16,744 wall is Chromium-measured; Safari's is
unmeasured — the mechanism is stated without a number). Deviation from the
draft, flagged for approval: the draft's remedy #2 ("run gucOS in a browser
with JSPI: Chrome 137+…") is DROPPED — under the unconditional refusal a
JSPI browser refuses too, so that line would be a false remedy today. The
JSPI status still appears, honestly, on the `browser :` line. Remedy #1
(SDL_MAIN_USE_CALLBACKS / SDL_AppIterate) is the fix taught, plus a note
that shm presents stay legal from any loop.

## What replaced #484's pollball coverage

The poll-only flood can no longer be produced by a shipped app — the class
is refused. Coverage moved:
- the flood-shaped loops live on as FIXTURES in `os-loopguard.mjs` (NEW
  sweep member): both shapes (SDL_Delay(1) Keep Up loop, poll-only spin)
  compiled in-OS, each refused with exit 69 + the teaching message, zero
  bitmaps shipped, desktop/compositor/shell alive, and a callback app
  presenting fine afterwards;
- the ship-rate ceiling is BACK in `os-pollball.mjs` (15..300/s band — the
  gpu transport is back and a callback app cannot free-run it) and in
  `os-devloss.mjs` as ships-per-composited-frame ratios (measured 1.000
  for pollball alone, 2.000 for pollball+gpubox);
- `os-devloss.mjs` keeps the leg-B recovery legs (device.destroy → recover,
  repaint), with winbox joining as the app-level shm window.

## Proof runs (this machine, headless Chromium 149, 2026-08-06)

- `os-loopguard.mjs` — PASS (14 legs; both refusal shapes, exit 69, zero
  ships, desktop survives).
- Real Keep Up source (`~/git/meta/meta/notes/keepup-crash/keepup-main.c`)
  compiled in-OS with `cc`: refused at first present, `RC=69`, full message
  on the tty naming `keepup (pid 6)`, desktop alive, zero device losses
  (lane driver, not committed).
- Long-run: 6.0 min, 30,038 ships, 0 losses (above).
- `os-devloss.mjs` — PASS; `os-pollball.mjs` — PASS (83/s in-band);
  `test_gpu_present_clamp.js` — PASS (23 legs, 14 old preserved);
  `test_gpubox_menu_e2e.js` + `test_gpubox_dawn_e2e.js` — PASS (the
  feeder refactor + callback conversion hold headless, Dawn included);
  headless pollball boots, animates, ESC-quits clean.

## Residuals / notes for the follow-ups

- JSPI relaxation of the refusal is the filed follow-up; the refusal site
  carries the relax-don't-unwind note.
- `emscripten_set_main_loop` (fps=0) and `wgpuSetMainLoopCallback` remain
  legal alternate spellings of the callback model; the message teaches only
  the portable SDL3 one, by design.
- gpubox's AppInit failure paths now exit 1 (SDL_APP_FAILURE) where the old
  main returned 1/3; the '3' (no window) collapses to 1. No test keyed on
  it.
- The on-demand compositor (0169) parks on an idle desktop — os-loopguard
  measures composite liveness under damage, not idle (first cut of the leg
  was wrong and fixed in-lane).
