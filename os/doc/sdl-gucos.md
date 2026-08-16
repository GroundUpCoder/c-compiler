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

Both hosts enforce this rule identically: the desktop and the headless
`node os/boot.js` dev loop refuse the same shape with the same message
and the same exit status, so a headless run is real evidence about it —
a program that runs headlessly will not die at its second frame on the
desktop. The explicit software renderer (Option 2 below) is exempt in
both hosts.

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

## Frame pacing — SDL_SetRenderVSync (#500)

`SDL_SetRenderVSync(r, 1)` is the standard SDL3 way to pace a game to the
display, and it is real here: the display clock is the OS compositor's own
per-frame tick (the one clock that drives every composited frame), never a
timer.

- **Software renderer, blocking loop** (Option 2 — the common game shape):
  a paced `SDL_RenderPresent` publishes the frame, then blocks until the
  next Nth compositor tick. One frame per N ticks, freshest frame always on
  screen. A hidden tab stops the ticks, so the game pauses honestly and
  resumes without a burst of stale frames.
- **GPU tier, callback loop** (Option 1): `SDL_AppIterate` already runs
  once per compositor tick — the platform cadence — so `vsync = 1` matches
  what you get by default. `vsync = N` runs the iterate every Nth tick
  (half rate at 2, and so on). `SDL_GetRenderVSync` reports what you SET
  (0 on a fresh renderer, per SDL3) — it does not report the platform's
  own cadence.
- **Defaults and refusals**: vsync starts DISABLED (0). Adaptive (`-1`) is
  unsupported: `SDL_SetRenderVSync` returns false, sets `SDL_GetError()`,
  and leaves the mode unchanged. The same refusal applies anywhere there is
  no display clock — a plain headless `boot.js` (use `--vsync[=hz]` to give
  the headless host a tick clock) or a standalone page.
- An UNPACED loop stays legal (SDL's contract): it simply burns CPU
  producing frames the display cannot show. Prefer `vsync = 1` over
  `SDL_Delay(16)` — a delay loop free-runs against the compositor and
  beats (dropped/duplicated frames); vsync is aligned by construction.

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

## Text: SDL_ttf (the classic API) over FreeType

`#include <SDL3_ttf/SDL_ttf.h>` is the sanctioned text path: the classic
SDL_ttf render-to-surface API, spelled exactly as SDL3_ttf 3.x —
`TTF_Init` / `TTF_OpenFont` / `TTF_RenderText_{Solid,Shaded,Blended}`
(plus `_Wrapped` and `TTF_RenderGlyph_*` variants), `TTF_GetStringSize`,
font metrics, style/hinting/kerning. The header pulls FreeType through
the freetype source package automatically (on a minimal boot,
`gucman install freetype` first); a program that does not include it
stays FreeType-free. Shipped TrueType fonts live under
`/usr/share/fonts/` (`mono.ttf`, `sans.ttf`, `serif.ttf`, bold/italic
variants; user overrides in `/etc/fonts`).

```c
#include <SDL3_ttf/SDL_ttf.h>

TTF_Init();
TTF_Font *font = TTF_OpenFont("/usr/share/fonts/sans.ttf", 24.0f);
SDL_Color white = { 255, 255, 255, 255 };
SDL_Surface *s = TTF_RenderText_Blended(font, "Score: 100", 0, white);
SDL_Texture *t = SDL_CreateTextureFromSurface(renderer, s);
SDL_DestroySurface(s);
/* draw t with SDL_RenderTexture each frame */
```

Rules and boundaries:

- Render once and CACHE the texture; re-render only when the string
  changes. A per-frame `TTF_RenderText_*` + `SDL_CreateTextureFromSurface`
  round trip works but burns CPU for nothing.
- Every returned surface is RGBA32 (this platform has no palettized
  surfaces). The visual semantics are upstream's: Solid = bilevel ink on
  a transparent background, Shaded = antialiased on an opaque bg-colored
  box, Blended = antialiased with per-pixel alpha.
- Text is UTF-8 (the `length` parameter is bytes, 0 = null-terminated);
  invalid bytes render as the replacement glyph, never garbage.
- The modern `TTF_Text` / `TTF_TextEngine` API is NOT part of this
  platform (tracked separately), and the LCD renderers, `TTF_OpenFontIO`
  and `TTF_SetFontOutline` do not exist — absent names fail loud at
  compile time.
- Raw FreeType (`<ft2build.h>`, see the freetype package) stays available
  for custom rasterization; an embedded bitmap font still works for a
  tiny fixed HUD.
