# 0224 — CS5: SDL_Delay cooperative in worker flavors

- **Status**: done (2026-07-16) — SDL_Delay cooperative pumpWait sleep in worker flavors, blocking sleep in null flavor, loud throw kept for the standalone-browser flavor; `tests/kernel/test_sdl_delay_e2e.js`; the stale unit golden was closed as todos/0226
- **Design**: todos/SDL3.md (timer section), todos/IDLE-POWER.md (parking discipline)

## Goal

Retire the arch-debt finding CS5 (2026-07-16 scan): `SDL_Delay` threw
"UNIFORMLY" — the standalone main-thread-browser constraint (can't block, no
JSPI) was applied to EVERY SDL flavor, including the OS worker flavors where
blocking is legal and already used (`blockingSleepMs` backs usleep/nanosleep,
`pumpWait` backs GetMessage/SDL_WaitEvent). That foreclosed the dominant SDL
corpus shape — `while(running){ poll; draw; SDL_Delay(16); }` — from running
unmodified even as an OS process: every port paid a restructure-to-callback
tax that only the standalone browser page actually requires.

## Plan

- `createSurfaceSDL` (both sub-flavors — browser worker + headless/shm):
  `__sdl_delay` = a deadline loop over `pumpWait` parks. Input keeps draining
  into the wasm event queue while the app sleeps (a mid-delay event is queued
  for the next PollEvent but does NOT shorten the sleep — SDL semantics);
  pumpWait's entry rules carry over (0169 frame-idle release → a delaying app
  lets the compositor park; cooperative signals at import return, like
  usleep). Pre-window (no ring) falls back to the raw blocking sleep.
- `createNullSDL`: a plain `blockingSleepMs` when the thread can block
  (Node/worker), the loud throw only when it can't.
- `createBrowserSDL` (standalone browser page): the throw STAYS — rAF
  callback model, main() must return, input/presents ride the message loop;
  that constraint is real. Export `blockingSleepMs`/`canBlockSync` from the
  BLOCK_FS closure so there is ONE blocking-sleep implementation.
- Docs: SDL3.md timer section + conformance note, WIN32.md/winmm.c stale
  "SDL_Delay throws by design" comments.

## Acceptance

`tests/kernel/test_sdl_delay_e2e.js` (registered in the kernel suite): a real
C classic-loop app as an OS process — pre-ring blocking fallback honours the
duration; 20-frame poll/draw/Delay(50) loop renders and receives injected
input; a mid-delay key is queued without shortening the 1500ms sleep;
present-while-PARKED rings the doorbell and the next SDL_Delay entry releases
the wantFrame pin (compKeepAlive false mid-delay — the IDLE-POWER gate); the
standalone-browser flavor still throws loudly; the null flavor really sleeps.
