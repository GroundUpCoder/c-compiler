# SDL_Delay: scope the throw to where the constraint is real (todos/0224)

Arch-debt finding CS5 from today's scan: `SDL_Delay` threw **uniformly** — the
standalone main-thread-browser constraint (a blocking loop can't yield to the
browser without JSPI) was baked into every SDL flavor, including the OS worker
flavors where the SAME runtime already blocks happily (`blockingSleepMs` for
usleep/nanosleep, `pumpWait` for GetMessage/SDL_WaitEvent). Classic
assume-the-restrictive-case shortcut: the dominant corpus shape
`while(running){ poll; draw; SDL_Delay(16); }` couldn't be ported unmodified
even to contexts where blocking is perfectly legal — every SDL port paid a
restructure-to-callback tax only the standalone browser page actually needs.

## What changed (host.js)

- **`createSurfaceSDL` (OS processes, both sub-flavors)**: `__sdl_delay` is now
  `sdlDelay(ms)` — a deadline loop over `pumpWait` parks. Design points:
  - **Input flows while sleeping**: each pumpWait park drains the OS input
    ring into the wasm event queue, so a key injected mid-delay is waiting at
    the app's next `SDL_PollEvent`.
  - **Full-duration semantics**: an early ring wake does NOT shorten the sleep
    (SDL contract) — the loop re-parks for the remainder.
  - **IDLE-POWER discipline carries over for free**: pumpWait's entry posts the
    0169 frame-idle release, so an app dawdling in SDL_Delay drops its
    wantFrame pin and the compositor may park; the next present's doorbell
    re-wakes it. Cooperative signals run at the import's return, matching
    usleep.
  - **Pre-window** there is no ring (`pumpWait` returns 0 without sleeping) —
    fall back to the raw blocking sleep, never a spin.
  The browser sub-flavor previously inherited the inner `createBrowserSDL`
  throw; it now overrides it next to its `__sdl_pump_wait`/`__wait` wiring.
- **`createNullSDL` (headless standalone)**: plain `blockingSleepMs(ms)` when
  the thread can block (Node CLI, workers) — same primitive as usleep. The
  throw remains only when the thread genuinely can't block.
- **`createBrowserSDL` (standalone browser page)**: the throw STAYS, and its
  comment now names why this is the one real case — rAF callback model,
  main() must return, input/presents ride the worker's message loop, so a
  never-returning main() starves them no matter how Delay is implemented.
- `blockingSleepMs` + a `canBlockSync` probe are exported from the BLOCK_FS
  closure so the SDL flavors share the ONE blocking-sleep implementation
  instead of growing a duplicate.

## Why pumpWait and not waitMulti

`SDL_Delay` sleeps on ring ⊕ timeout only — single-ish source, exactly
pumpWait's shape (KERNEL.md's two-tier wait rule: multi-source sleeps go
through FS_WAIT, single-source ring parks stay raw futexes). It also keeps the
no-kernel fallback trivial.

## Gate

`tests/kernel/test_sdl_delay_e2e.js` (kernel suite): real C classic-loop app
as an OS process — pre-ring fallback honours the duration; a 20×Delay(50)
poll/draw loop renders and sees an injected key; a mid-1500ms-delay key is
queued but doesn't shorten the sleep; present-while-PARKED rings the damage
doorbell and the following SDL_Delay releases the wantFrame pin
(`compKeepAlive() === false` mid-delay); `createBrowserSDL.__sdl_delay` still
throws; `createNullSDL` really sleeps. 12/12 on first run.

Docs updated: SDL3.md timer + conformance notes, WIN32.md / os/win32/winmm.c
stale "SDL_Delay throws by design" comments. Image bumped v102 → v103
(runtime SDL behavior change; belt-and-braces for persistent browser images).
