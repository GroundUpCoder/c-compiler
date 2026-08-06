# SDL3 on gucOS — main loops, GPU frames, and the software renderer

gucOS runs each program in a browser worker. That gives SDL3 programs one
rule desktop SDL does not have:

**A program that presents GPU frames must return control to the browser
between frames.**

WHY: the browser recycles a program's presented GPU frames on that
program's own event loop. A classic blocking main loop —
`while (running) { poll; update; draw; present; }` — never returns to the
event loop, so its frames are never recycled. The headroom for that is
finite; exhausting it destroys the desktop compositor's GPU device and the
whole desktop goes black. gucOS therefore refuses the combination
(blocking loop + GPU presents) at the program's second present, with a
fatal message and exit status 69, before the countdown starts. Only the
offending program dies; the desktop is unaffected.

There are two sanctioned ways to write an SDL3 program here. Both are
standard SDL3 — the same source runs on desktop SDL3 unchanged.

## Option 1 — the SDL3 callback main loop (preferred: keeps GPU rendering)

```c
#define SDL_MAIN_USE_CALLBACKS
#include <SDL.h>

SDL_AppResult SDL_AppInit(void **appstate, int argc, char *argv[]) {
    /* SDL_Init, create window + renderer; return SDL_APP_CONTINUE.
       Presenting one first frame here (a splash) is fine. */
}
SDL_AppResult SDL_AppIterate(void *appstate) {
    /* one frame: update, draw, SDL_RenderPresent; SDL_APP_CONTINUE to
       keep going, SDL_APP_SUCCESS / SDL_APP_FAILURE to quit (exit 0/1). */
}
SDL_AppResult SDL_AppEvent(void *appstate, SDL_Event *event) {
    /* each pending event, before the next iterate. */
}
void SDL_AppQuit(void *appstate, SDL_AppResult result) { /* teardown */ }
```

There is no `main()` — the runtime provides it. `SDL_AppIterate` runs once
per composited frame (~60 Hz) and the program yields between frames, so
GPU rendering is sound indefinitely. Do NOT add your own `while` loop or
`SDL_Delay` pacing inside `SDL_AppIterate`.

Reference apps in this OS: `pollball` (pure SDL_Renderer),
`gpubox` (win32 + webgpu.h).

## Option 2 — keep your blocking loop, use the software renderer

If you have an existing program with a classic blocking loop and don't
want to restructure it, request SDL's software renderer. It draws on the
CPU into the window surface (no GPU frames, no budget), so a blocking loop
is safe:

```sh
SDL_RENDER_DRIVER=software ./mygame     # no code changes
```

or in code:

```c
SDL_Renderer *r = SDL_CreateRenderer(win, "software");
```

or `SDL_SetHint(SDL_HINT_RENDER_DRIVER, "software")` before creating the
renderer. The environment variable overrides the hint, as in upstream SDL.

The software renderer is NEVER auto-selected: `SDL_CreateRenderer(win,
NULL)` always means the GPU tier. Asking for any other driver name
("opengl", "metal", …) fails with "Couldn't find matching render driver".

## What is unaffected

- Programs that draw with `SDL_GetWindowSurface` + `SDL_UpdateWindowSurface`
  (no SDL_Renderer): CPU pixels, any loop shape is fine.
- The win32 veneer (GDI apps) and every existing shipped app.
- `emscripten_set_main_loop(f, 0, 1)` and `wgpuSetMainLoopCallback(f)`:
  alternate spellings of the callback model, also sound. Prefer
  `SDL_MAIN_USE_CALLBACKS` in new code — it is portable SDL3.

## Quitting a callback app

Return `SDL_APP_SUCCESS` (exit 0) or `SDL_APP_FAILURE` (exit 1) from any
callback. `SDL_AppQuit` always runs once before the process exits.
webgpu.h apps must quit this way (never `exit()` from a frame callback):
the runtime drains pending GPU work after the loop stops.
