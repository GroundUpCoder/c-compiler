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

## Audio on a headless boot: the queue never drains

The browser boot has a real audio sink. The headless boot (`os/boot.js`)
has none, by design — nothing consumes pushed audio there.
`SDL_OpenAudioDeviceStream` and `SDL_PutAudioStreamData` still succeed,
but `SDL_GetAudioStreamQueued` NEVER decreases: the value grows with
each push and then holds.

Push audio with a bounded backlog. Skip a chunk when the backlog is
full; never wait for it to drain:

```c
/* each frame: top up only while the backlog is below the cap */
if (SDL_GetAudioStreamQueued(stream) < CAP_BYTES)
    SDL_PutAudioStreamData(stream, chunk, chunk_len);
/* above the cap: drop or defer this chunk and carry on */
```

Do NOT block on drain:

```c
while (SDL_GetAudioStreamQueued(stream) > CAP_BYTES)  /* WRONG */
    SDL_Delay(1);   /* headless, this loop never exits */
```

Unconditional pushing is also wrong: `SDL_PutAudioStreamData` always
accepts the data, so on a headless boot the queue grows without bound.
With the bounded pattern the same program plays sound in the browser
and runs silently, with bounded memory, on a headless boot.

## Text: there is no SDL_ttf

SDL_ttf is not part of this platform. No `TTF_*` function exists, and
`#include <SDL_ttf.h>` fails. Draw text with FreeType, the way the
in-OS apps (the terminal, the deck viewer) do:

```c
#include <ft2build.h>
#include FT_FREETYPE_H
```

The FreeType headers pull their own sources, like the other system
libraries (on a minimal boot, `gucman install freetype` first). Then:

1. `FT_Init_FreeType`, and `FT_New_Face` on a shipped font. TrueType
   fonts live under `/usr/share/fonts/` (`mono.ttf`, `sans.ttf`,
   `serif.ttf`, bold/italic variants). Try `/etc/fonts/mono.ttf` first
   and fall back to `/usr/share/fonts/mono.ttf` — user overrides live
   in `/etc/fonts`.
2. `FT_Set_Pixel_Sizes`, then `FT_Load_Glyph` + `FT_Render_Glyph` per
   character.
3. Blit each glyph bitmap into your own pixels — the window surface, or
   a streaming texture on the renderer path.

For a small fixed HUD (score, lives), an embedded bitmap font drawn
with `SDL_RenderFillRect` per pixel also works and needs no library.
For anything more, use FreeType and the shipped fonts.
