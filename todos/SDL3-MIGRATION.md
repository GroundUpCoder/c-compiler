# SDL: unify the web bridge, then migrate SDL2 → SDL3 (minimal rename)

Status: in progress (2026-06-18). Two sequenced, independently-shippable phases.
Phase 0 (factor the input bridge into host.js) must land + sync + be green
before Phase 1 (SDL2→SDL3 rename) starts.

## Why

SDL has **two browser frontends** sitting on **one** C ABI (`SDL.h` + `__SDL.c`
in `compiler.js`) and **one** host backend (`createBrowserSDL` / audio receiver
in `host.js`):

1. **Emitted-HTML page** — `compiler.js` generates a self-contained `.html`
   (single worker; DOM glue baked into the template, ~`compiler.js:23500-24195`).
   This is the `node compiler.js game.c -o game.html` artifact and is NOT going
   away — it's independent of any app.
2. **netguc `c/` app** — runs the same compiler in-browser with a 2-worker
   topology (workspace owner + disposable run worker) and its own DOM glue
   (`frontend/src/compiler/sdl-input.ts`, `GraphicalRunSheet.tsx`,
   `run-exec-sab-worker.ts`, `host-media.ts`).

The **DOM→SDL input mapping is duplicated** between them — `c/`'s `sdl-input.ts`
is openly "ported from the emitted-page DOM→SDL mapping". Two copies of the same
keysym/scancode tables + `canvasCoords` + dispatch drift silently.

Already shared (no work): the canvas blit (`createBrowserSDL`), the audio ring +
`createAudioReceiver`. Only the **input mapping/dispatch** is duplicated, and only
**transport** (worker count, transfers, MessagePort routing, lifecycle) is
legitimately per-frontend.

## Architecture of the fix

`host.js` is loaded in **every** context that needs the bridge:
- emitted page main thread — inlined at `compiler.js:23735` (`<script>${safeHostJs}`)
- emitted worker — inlined at `compiler.js:23533`
- `c/` main thread — `host-media.ts loadHostMedia()` (`new Function(... return {...})`)
- `c/` run worker — `run-exec-sab-worker.ts loadHost()` (same mechanism)

So the single home for the pure bridge is **`host.js`**, exported alongside
`createBrowserSDL`/`createAudioReceiver` (`host.js:6570-6586`). It is **pure**
(no worker/transport assumptions) → both frontends keep their own topology and
just call it. This is dependency-injection, matching how `createBrowserSDL`
already *receives* its canvas/ring/sdl rather than creating transport.

### The bridge: `SDL_WEB` (new, in host.js)

Pure functions + constants, DOM-duck-typed (only called in-browser; never at
module load, so Node `require('host.js')` is unaffected):

```
SDL_WEB = {
  // event type constants (stable across SDL2/SDL3)
  KEYDOWN:0x300, KEYUP:0x301, MOUSEMOTION:0x400,
  MOUSEBUTTONDOWN:0x401, MOUSEBUTTONUP:0x402, MOUSEWHEEL:0x403, QUIT:0x100,
  // DOM event -> canonical descriptor {kind, ...}
  keyMsg(e, down),                       // {kind:'key', eventType, scancode, sym}
  mouseButtonMsg(canvas, e, down, logical),  // {kind:'mousebutton', eventType, button, x, y}
  mouseMoveMsg(canvas, e, logical),          // {kind:'mousemove', x, y}
  wheelMsg(e),                               // {kind:'wheel', x, y}
  // worker-side: canonical descriptor -> sdl.pushXxx
  dispatch(sdl, m),
  // helpers reused by the above (also individually useful)
  keysym(e), scancode(e), canvasCoords(canvas, e, logical),
}
```

Canonical descriptor (one shape, both frontends post it, `dispatch` consumes it):
`{kind:'key'|'mousebutton'|'mousemove'|'wheel'|'quit', eventType?, scancode?, sym?, button?, x?, y?}`.

`canvasCoords` uses the emitted-page's superset logic (`logical?.w || canvas.width
|| rect.width`, letterbox-aware). `wheelMsg` uses the emitted-page's deltaMode
scaling (the original). **`c/` adopts these** — the emitted page is the canonical
source; `c/` was the port. Behavioral deltas vs `c/`'s current code: wheel
magnitude/sign normalizes to the emitted-page semantics (no `c/` wheel test
exists; keyboard/mouse unchanged).

## Phase 0 — factor the bridge into host.js

1. **host.js**: add `SDL_WEB` (above) near `createBrowserSDL`; export it in the
   `module.exports` + `window`/`self` block (`host.js:6570-6586`).
2. **compiler.js emitted page** (`~23878-23940`): delete the inline
   `sdlNamedKeysyms`/`sdlScancodeMap`/`sdlKeysym`/`sdlScancode`/`canvasCoords`;
   rewrite `onKeydown/onKeyup/onMousedown/onMouseup/onMousemove/onWheel` to post
   `{type:'sdl-input', input: SDL_WEB.keyMsg(e,true)}` etc. (SDL_WEB is in page
   scope). Keep `sdlCanvasW/H` -> pass as `{w,h}` logical.
3. **compiler.js emitted worker** (`self.onmessage`, `~23543-23567`): replace the
   4 `keydown/keyup/mousedown/.../wheel/quit` branches with one
   `else if (msg.type==='sdl-input'){ if(sdlRef) SDL_WEB.dispatch(sdlRef, msg.input); }`.
4. **c/ `run-exec-sab-worker.ts`**: have `loadHost()` also return `SDL_WEB`; use
   `SDL_WEB.dispatch(liveSdl, msg)` instead of the local `dispatchSdlInput`.
5. **c/ `host-media.ts` (or a sibling loader)**: also expose `SDL_WEB`; cache it.
6. **c/ `sdl-input.ts`**: keep `attachSdlInput` (c/-specific listener lifecycle)
   but take the bridge as a param and delegate mapping to it; `GraphicalRunSheet`
   awaits the bridge (alongside audio) then attaches. Keep `SdlInputMsg` as the
   canonical descriptor type. Remove the duplicated tables/`keysym`/`canvasCoords`.
7. **Sync**: re-vendor host.js into `c/` via `c/scripts/sync-compiler.sh`.

### Phase 0 guardrails (must all pass, both repos)
- `cd ~/git/c-compiler/tests/browser && pnpm run doom` → **screenshot the DOOM
  title screen and eyeball it** (Doomguy + logo), not just the ≥10% non-black gate.
- `pnpm run test` (quake render) in tests/browser.
- `python3 tests/run.py --types=unit` (regression gate; SDL-independent but the
  project standard).
- `c/`: `pnpm test:unit` + `pnpm test:e2e` (esp. `graphical-run.spec.ts`:
  canvas non-black, audio ring advances, keypress flips blue→red).
- Commit c-compiler (main) + c/ (main), push both.

## Phase 1 — minimal SDL2 → SDL3 rename (same functional surface)

Rename SDL2-isms to SDL3 spelling; **no new capabilities** (no renderer/texture,
no AudioStream resampling, no touch, no multi-window). Keep the vendored demos
working via an **SDL2-compat shim header** rather than porting them.

### What actually changes (not pure sed)
- **Event type values are stable** (SDL_EVENT_QUIT 0x100, KEY_DOWN/UP 0x300/1,
  MOUSE_* 0x400-0x403) → the bridge's posted `eventType` hex are unchanged. 
- **Keyboard event struct flattens**: SDL2 `event.key.keysym.{scancode,sym}` →
  SDL3 `event.key.{scancode,key}`. Change in `SDL.h` + `__sdl_push_key_event`
  (C-side struct write). JS `pushKeyEvent(handle,eventType,scancode,sym)` signature
  unchanged → **bridge untouched**.
- **Mouse coords become float**: SDL3 `motion/button .x/.y` are `float`. Change
  the C structs + push helpers' stored type. JS passes numbers → bridge untouched.
- **`SDL_CreateWindow` drops x,y**: `(title,w,h,flags)`. C signature + host
  `__sdl_create_window`. Demos call the 6-arg form → handled by the compat shim.
- **Audio → streams**: `SDL_OpenAudioDevice`→`SDL_OpenAudioDeviceStream`,
  `SDL_QueueAudio`→`SDL_PutAudioStreamData`, `SDL_GetQueuedAudioSize`→
  `SDL_GetAudioStreamQueued`, `SDL_AudioSpec` loses samples/callback, format enum
  `AUDIO_*`→`SDL_AUDIO_*`. The **SAB ring + `createAudioReceiver` stay byte-identical**;
  only C-facing names/types + the format-constant map (`host.js:4707-4709`) change.
- **Return types**: `bool` (false==0, harmless), `SDL_GetTicks`→`Uint64`.

### Phase 1 steps
1. `SDL.h` (`compiler.js:17089`): SDL3 spelling — flat key event, float coords,
   4-arg CreateWindow, stream audio types, `SDL_AUDIO_*`, bool returns, Uint64 ticks.
2. `__SDL.c` (`compiler.js:19745`): match struct writes + function names/sigs.
3. `host.js`: rename `__sdl_*` audio imports to stream semantics; remap format
   constants; widen ticks. Backend behavior identical.
4. **SDL2-compat shim header** (new, embedded like `SDL.h`): maps SDL2 names /
   6-arg CreateWindow / queue-audio → SDL3 core, so `vendor/{doom,quake,gameboy,
   freetype}` compile unchanged. Wire it as an opt-in include or auto for those projects.
5. Bridge `SDL_WEB`: only `dispatch` may need to pass coords as floats — verify;
   the posted descriptor shape is unchanged.

### Phase 1 guardrails — same as Phase 0, plus
- DOOM + Quake MUST still render (they exercise the renamed ABI via the compat shim).
- Confirm audio still plays (the ring/receiver are unchanged; the rename is C-facing).
- Commit + push both repos.

## Risks / watch
- Two glue copies drifting — Phase 0 removes this for input; canvas/audio already shared.
- `c/` main-thread input now depends on an async host.js bridge load — precedent
  is `loadHostMedia`; sequence load-before-attach (a few ms before input is live
  on a graphical run is fine).
- iOS unverified for `c/` (Chromium-only proof) — out of scope here; don't regress.
- Demos are the emitted-HTML SDL regression corpus; the compat shim is what keeps
  them green through Phase 1.
