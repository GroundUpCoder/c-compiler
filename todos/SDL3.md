# SDL3 for the C compiler — scope, current state, and the work to do

Status: **partial SDL3 subset shipped (window + 2D renderer + basic events +
audio streams + timer + the `sdl3webgpu` bridge). This doc enumerates the full
SDL3 surface and what remains.** Written 2026-06-19, after the WebGPU
conformance pass (A1–A9; see `todos/WEBGPU.md`). SDL3 is the next major feature
after the WebGPU A10–A15 conformance pass.

## Goal

Let compiled C programs `#include <SDL.h>` (SDL3 dialect) and run real SDL3
apps/games on this runtime — backed by browser APIs (WebGPU for video, Web Audio
for sound, DOM/Pointer/Gamepad/Keyboard events for input), with **no JSPI**.

## Guiding principles

Two goals govern every part of this implementation. A gap in either is a bug to
file, not an acceptable shortcut — both are first-class:

1. **Correctness.** The interface must behave **exactly** as a program written
   against upstream SDL3 expects: same function semantics, same struct fields
   populated, same event values/codes, same defaults, same error behavior. When
   something genuinely can't be honored on this runtime (e.g. a blocking sleep
   without JSPI), it **fails loud** — it never silently no-ops or mis-behaves.
2. **Performance.** Every operation should cost **no more than a user would
   reasonably expect** of it. A per-frame `RenderPresent` must not do a hidden
   full-canvas GPU→CPU readback; a one-pixel `UpdateTexture` must not reupload the
   whole texture; batched 2D draws must not allocate per primitive. Hidden O(n) or
   per-frame overhead on a path the caller believes is cheap is a defect.

A change that is correct but quietly quadratic, or fast but subtly off-spec, is
not done. The "Known strays" section below tracks current violations of either.

## Architecture (how SDL3 maps onto this runtime)

- **Single `env` import model**, same as WebGPU: `__SDL.c` (in `compiler.js`,
  ~424 lines) flattens SDL structs to primitives and forwards to `__sdl_*`
  imports satisfied by `createBrowserSDL` in `host.js` (~550 lines). `SDL.h` is
  in `_stdlibHeaders` (~289 lines).
- **No JSPI ⇒ SDL3's callback main loop is the natural fit.** SDL3 ships
  `SDL_MAIN_USE_CALLBACKS` (`SDL_AppInit`/`SDL_AppIterate`/`SDL_AppEvent`/
  `SDL_AppQuit`). `SDL_AppIterate` is *exactly* the per-frame callback this
  runtime already uses (`__sdl_set_animation_frame_func` → rAF, shared with
  `wgpuSetMainLoopCallback`). **Adopting the callback model should be the primary
  SDL3 entry path**; the classic `while (SDL_PollEvent) {...} ` blocking loop only
  works for programs that already yield via the frame callback.
- **Video is already 100% WebGPU** (software blitter + batched 2D renderer in
  `createBrowserSDL`). The decision to *unify* SDL_Renderer onto the `webgpu.h`
  binding is **deferred until JSPI reaches iOS** (see `todos/WEBGPU.md` →
  "DEFERRED: unify SDL_Renderer onto the webgpu.h binding"). Until then the JS
  renderer stays.
- **SDL_GPU** (SDL3's new explicit GPU API) would also map onto `webgpu.h`. It
  shares the same async-device-under-sync-API / no-JSPI problem as the renderer
  unification, so it is likewise **JSPI-gated** (see "SDL_GPU" below).

## Current state (what already works)

Host ops implemented (32) and the `SDL.h`/`__SDL.c` C API on top of them:

- **Init/quit:** `SDL_Init`, `SDL_Quit` (INIT_VIDEO|INIT_AUDIO).
- **Window:** `SDL_CreateWindow`, `SDL_DestroyWindow`, `SDL_SetWindowTitle`,
  `SDL_GetWindowID`, `SDL_GetWindowSurface`, `SDL_UpdateWindowSurface`
  (software-surface present path), `WINDOWPOS_*`, `WINDOW_FULLSCREEN`.
- **2D renderer:** `SDL_CreateRenderer`/`DestroyRenderer`, `RenderClear`,
  `RenderPresent`, `SetRenderDrawColor`, `SetRenderDrawBlendMode`,
  `RenderFillRect`, `RenderRect`, `RenderLine`, `RenderPoint`, `RenderGeometry`,
  `RenderTexture`, `CreateTexture`, `CreateTextureFromSurface`, `UpdateTexture`,
  `DestroyTexture`, `SetTextureColorMod`/`AlphaMod`/`BlendMode`, blend modes
  (NONE/BLEND/ADD/MOD). (Built on a few host primitives: `render_quad`,
  `render_geometry`, `render_clear`, `update_texture`.)
- **Events:** `SDL_PollEvent` with QUIT, KEY_DOWN/UP, MOUSE_MOTION/
  BUTTON_DOWN/UP/WHEEL; the host pushes these from DOM listeners
  (`__sdl_push_*_event`).
- **Audio:** `SDL_OpenAudioDeviceStream`, `SDL_PutAudioStreamData`,
  `SDL_PauseAudioStreamDevice`/`Resume`, `SDL_ClearAudioStream`,
  `SDL_GetAudioStreamQueued`, `SDL_DestroyAudioStream` (Web Audio backed).
- **Timer:** `SDL_GetTicks` (true `Uint64` ms since `SDL_Init`), `SDL_Delay`
  (always throws — a blocking sleep can't yield without JSPI; use the callback).
- **Errors:** `SDL_GetError`/`SDL_SetError`/`SDL_ClearError` (single global
  string; set on the failure paths of Init/CreateWindow/Renderer/Texture/audio).
- **Frame loop:** `__sdl_set_animation_frame_func` (rAF; the no-JSPI loop).
- **WebGPU bridge:** `sdl3webgpu.h` → `SDL_GetWGPUSurface` (surface from the
  canvas), so SDL programs can drive raw `webgpu.h`.

## Conformance pass (2026-06-19, after this doc was first written)

Fixed a batch of stray-from-SDL behaviors found in an audit (all tested, headless
+ Chromium + real Safari):

- **Error API** is real now (was entirely absent — `SDL_GetError()` didn't even
  compile).
- **`SDL_GetTicks`** returns a full `Uint64` (was 32-bit-truncated, wrapped ~49d).
- **`SDL_Delay`** always throws (was a silent no-op when a frame callback was
  registered) — no shipping demo calls it; Doom routes around it.
- **Blend modes are honored per draw** (`SDL_SetTextureBlendMode`/
  `SetRenderDrawBlendMode` were no-op stubs; everything was force-alpha-blended).
  One WebGPU pipeline per mode; SDL-correct defaults (renderer draw + CreateTexture
  = NONE, CreateTextureFromSurface = BLEND); unsupported modes fail loud.
- **Full scancode map** — letters/digits/punct/keypad/nav now carry the right
  `SDL_Scancode` (only arrows/mods/F-keys were mapped → WASD reported scancode 0).
- **Mouse wheel sign** corrected to SDL's convention (+y = away/up) + horizontal.
- **SDL_SetTextureScaleMode / SDL_GetTextureScaleMode** (nearest/linear per
  texture) — two samplers, one per filter mode; `texBindGroup()` picks the right
  one based on `t.scaleMode`; NEAREST preserves pixel-art crispness at scale,
  LINEAR blurs. SDL3-default LINEAR honored. Unsupported modes fail loud. The
  getter round-trips the mode (real SDL3 `bool` + out-param signature).
  Test: 8×8 checkerboard at 25× in both modes (Playwright pixel assertions at
  texel centers + boundaries); a headless unit test for the get/set round-trip.
  **Fixed 2026-06-20 (follow-up):** changing the scale mode AFTER a texture's
  first present was a no-op that then crashed — `texBindGroup()` rebuilt the bind
  group only when `!t.view`, but the setter only nulled `t.bindGroup`, so a
  post-present mode change returned a null bind group (`No bind group set at group
  index 0`). Now the bind group rebuilds whenever it's null. Regression-tested in
  Chromium AND on real Safari (safaridriver) with a texture that toggles
  LINEAR↔NEAREST every ~1s at runtime; the test gates on the red texel staying
  red so a "texture stopped drawing" regression can't masquerade as a pass.
  (Also fixed the Safari test harness: current Safari needs a JS-click, not a
  WebDriver native click, to start an emitted page — `webgpu-safari.mjs` was
  silently broken by this too and is now fixed.)

## Conformance audit (2026-06-20, read-only investigation)

Re-audited the **implemented** surface (declared in `SDL.h` AND wired in
`__SDL.c`/`host.js`) against shipping **SDL3 release-3.2.0** headers/source and the
wiki. Every numeric value, struct layout, and semantic below was verified against a
cited source, not assumed. Outcome: confirmed most prior strays, **deleted one that
was a false positive under SDL3 semantics**, elevated one perf stray to a
correctness+safety bug, and found **5 new strays**. No implementation code was
changed in this pass. Baseline references: SDL `release-3.2.0`
`include/SDL3/SDL_{events,audio,surface,render,pixels,init,scancode,keycode}.h`,
`src/render/SDL_render.c`, `src/audio/SDL_audioqueue.c`, and `wiki.libsdl.org`.

Verified **conformant** (so they don't get re-flagged):
- Every event/audio struct field order + type matches `release-3.2.0` exactly
  (`SDL_KeyboardEvent`, `SDL_Mouse{Motion,Button,Wheel}Event`, `SDL_AudioSpec`,
  `SDL_Vertex`/`SDL_FColor`/`SDL_FPoint`, `SDL_Event` `padding[128]`).
- All enum/macro numeric values match (`SDL_INIT_*`, `SDL_AUDIO_*`, `SDL_BLENDMODE_*`
  0/1/2/4, `SDL_SCALEMODE_NEAREST/LINEAR` = 0/1 — unchanged across all 3.2.x;
  `SDL_BUTTON_*`, `SDLK_*`, `SDLK_SCANCODE_MASK` 0x40000000, `WINDOWPOS_*`,
  `SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK`).
- The full `code → SDL_Scancode` map (`SDL_WEB.SCANCODE_MAP`, host.js) is correct
  USB-HID (A=4…Z=29, 1=30…0=39, F1=58…F12=69, keypad, nav, mods; `NumpadEnter`→
  KP_ENTER 88, `ContextMenu`→APPLICATION 101, `IntlBackslash`→NONUSBACKSLASH 100).
- Blend math: the WebGPU blend descriptors for BLEND/ADD/MOD match SDL's documented
  equations exactly (host.js `SDL_BLEND_DESC`).
- `SDL_RenderGeometry` uses per-vertex colors **as-is** and does NOT apply the
  texture's color/alpha mod — this matches SDL3 (verified in `SDL_render_gl.c` /
  `SDL_render_gpu.c`; only `SDL_RenderTexture` honors color mod).
- Renderer default draw blend = `SDL_BLENDMODE_NONE` (matches SDL3); texture default
  scale mode = `SDL_SCALEMODE_LINEAR` (matches SDL3).

**Deleted (was a false positive):** the old *"Shifted-letter keycode is wrong"*
stray. It applied SDL2 semantics. In SDL3 the key event's `key` (keycode) is
**modifier-applied by default** (`SDL_HINT_KEYCODE_OPTIONS` defaults to
`"french_numbers,latin_letters"`; neither disables shift), so Shift+A → `SDLK_A`
(65), not 97. Our `keysym()` returns `e.key.charCodeAt(0)` = the DOM-resolved
character, which tracks SDL3's modifier-applied keycode (Shift+A→65, plain a→97,
Shift+1→'!'=33, Caps+a→65). Verified against `wiki.libsdl.org/SDL3/`
`SDL_HINT_KEYCODE_OPTIONS` + `SDL_GetKeyFromScancode`. (One residual corner remains
— see new stray on keypad-digit keycodes.)

## Fixed 2026-06-20 (conformance fixes pass)

The audit's strays were then **fixed** (all behind headless unit tests
`tests/unit/sdl_*` + the `tests/browser/sdl-*` Chromium suite; vendored into
`netguc/c` and deployed). Done:

### Correctness — fixed
- **NULL/invalid handling + `SDL_SetError`.** Every object-taking entry point
  (renderer/texture/window/stream) now validates its handle and sets SDL's exact
  wording via `SDL_InvalidParamError` ("Parameter 'X' is invalid") instead of
  dereferencing NULL; `SDL_UpdateWindowSurface` and `SDL_RenderGeometry` (incl.
  `malloc` failure) failure paths set the error too. Test: `sdl_null_guards`.
- **`SDL_PollEvent(NULL)` peeks** — returns true if an event is queued without
  removing it, never derefs the NULL. Test: `sdl_null_guards`.
- **`SDL_CreateTexture` default blend mode is alpha-aware** — `BLEND` for an
  alpha format, `NONE` otherwise (added the real `SDL_ISPIXELFORMAT_*` macros +
  `SDL_GetTextureBlendMode`). Test: `sdl_texture_blend_default`, `sdl-blend-renders`.
- **`SDL_UpdateTexture` honours the rect** — patches only the sub-region into a
  full CPU buffer (dirty bbox) and uploads just that region: fixes the wrong-data,
  the OOB read, AND the O(texture) cost (a 1px update is O(1)). Bounds-validated.
  Test: `sdl_update_texture_rect`.
- **`SDL_AudioStream` is an unbounded queue** — never silently drops:
  `__sdl_queue_audio` reports bytes *accepted* and the C stream backlogs the
  remainder, re-pumping each Put; `GetAudioStreamQueued` = ring + backlog; no-SAB
  sentinel fixed. (No resampler needed for the push path — the Web Audio device is
  opened at the program's exact spec.) Test: `sdl_audio_queue`.
- **Events carry their full fields** — `timestamp` (GetTicksNS-equivalent), key
  `mod` + `repeat`, motion `xrel`/`yrel` (relative deltas) + `state` button-mask +
  float coords, button `clicks` (double-click count) + float coords, wheel float
  x/y + `direction` + `mouse_x`/`mouse_y`, and a nonzero `which` throughout. New
  `__sdl_push_*` ABI carries DOM-only fields; C derives the rest. Added
  `SDL_KMOD_*`, `SDL_MOUSEWHEEL_*`, `SDL_BUTTON_MASK`, `SDL_CommonEvent`. Keypad
  keys report `SDLK_KP_*`. Test: `sdl_event_fields`, `sdl-input-check`,
  `sdl-scancode-check`, `sdl-wheel-check`.
- **Duplicate `SDL_PIXELFORMAT_RGBA32`** removed — single canonical LE value
  (`0x16762004` == ABGR8888). Test: `sdl_pixelformat_surface`.
- **`SDL_Surface`** gained SDL3's public fields (`flags/format/refcount/reserved`)
  in order. **`SDL_Init(0)`** no longer re-baselines the tick clock on a later
  init. Test: `sdl_pixelformat_surface`.
- **Mid-frame `SDL_DestroyTexture`** no longer crashes at present — the GPU free is
  deferred until after the next present and batch entries hold the texture object,
  so the in-flight frame still renders (matches SDL keeping it alive for the frame).

### Performance — fixed (earlier 2026-06-20)
- ~~Per-present GPU→CPU readback~~ — now on-demand + GPU-side BGRA→RGBA blit.
- ~~Per-primitive allocation in the renderer~~ — one reused/grown vertex buffer,
  no per-quad allocation (`sdl-render-batch`).
- ~~`SDL_UpdateTexture` whole-texture reupload~~ — now uploads only the dirty rect
  (see the UpdateTexture correctness fix above).

### Corrected (was a false positive, deleted not fixed)
- "Shifted-letter keycode is wrong" — SDL3 keycodes are modifier-applied by
  default, so our DOM-resolved char already matches (Shift+A → 65). Not a deviation.

## Still open — deferred feature/within-spec work (NOT silent deviations)

These remain, but are either deferred feature work or within SDL's own latitude;
none is a silent misbehavior. Decided 2026-06-20 to defer.

- **HiDPI: canvas renders at logical size, CSS-upscaled** (`host.js`). Blurrier on
  retina; needs device-pixel rendering + a logical/device coordinate split +
  `SDL_GetWindowSizeInPixels`/pixel-density. Deferred — pairs with the missing
  Video features (window resize / display APIs).
- **Full relative-mouse mode (Pointer Lock)** — `xrel`/`yrel` are now populated
  (motion deltas), but `SDL_SetWindowRelativeMouseMode` / `SDL_GetRelativeMouseState`
  (Pointer Lock API) are still missing. Feature work.
- **`SDL_RenderLine`/`SDL_RenderRect` are quad approximations** (1px quad / 1px
  borders), not Bresenham. SDL's own line rasterization isn't byte-identical across
  backends, so "exactly like SDL" is ill-defined; accepted as a close approximation.
- **Deferred batch-render vs immediate mode** — draws execute at `RenderPresent`
  (one `loadOp: clear` pass). Within SDL's "backbuffer undefined after present"
  rule, but a program that draws incrementally *without* clearing won't see the
  previous frame retained (would need a persistent offscreen target). Deferred.
- **`SDL_CreateTextureFromSurface` assumes RGBA32** — latent only; every surface
  this runtime can produce is RGBA32 (no `SDL_CreateSurface`/`SDL_LoadBMP` yet).
- **`SDL_AudioStream` as a standalone format converter** — `SDL_SetAudioStreamFormat`
  / cross-format stream binding are unimplemented (the push path needs no
  conversion). Missing feature, not a stray.
- **`SDL_UpdateTexture` reuploads the whole texture** for any update (it ignores
  the sub-rect — and see the elevated correctness+safety stray above) — a one-pixel
  change is O(texture).

## The work to do — by subsystem

Legend: **✅ have** · **◑ partial** · **✗ missing**. "Web" = the backing browser
API. Priority P0 (needed for most apps) → P3 (niche).

### Video / Window — ◑ partial — P0
Missing: multiple windows; window resize + `SDL_EVENT_WINDOW_*` (resized,
focus gained/lost, exposed, close-requested); `SDL_GetWindowSize` /
`SetWindowSize` / `GetWindowSizeInPixels` / position / min/max; fullscreen
toggle at runtime; `SDL_GetWindowPixelDensity`/display scale (HiDPI);
`SDL_SetWindowResizable`/`Bordered`; display enumeration (`SDL_GetDisplays`,
desktop/current mode); `SDL_ShowWindow`/`Hide`; `SDL_GetWindowFlags`;
`CreateWindowWithProperties` (needs SDL_properties). Web: canvas resize observer,
`devicePixelRatio`, Fullscreen API.

### 2D Renderer (SDL_render) — ◑ partial — P0
Missing: **render targets** (`SDL_SetRenderTarget` + texture with
TEXTUREACCESS_TARGET); **viewport / clip rect / scale** (`SetRenderViewport`,
`SetRenderClipRect`, `SetRenderScale`); **logical presentation**
(`SetRenderLogicalPresentation` — letterbox/scale, very common); plural
primitives (`RenderLines`, `RenderPoints`, `RenderRects`, `RenderFillRects`);
`RenderTextureRotated` / `RenderTextureTiled` / `RenderTexture9Grid`;
`RenderReadPixels`; `SetRenderVSync`; `GetRenderOutputSize`; render debug text
(`SDL_RenderDebugText`); `SDL_GetRenderDrawColorFloat` / float-color variants.
(Fixed 2026-06-20: `SDL_SetTextureScaleMode`/`GetTextureScaleMode` — nearest +
linear samplers, per-texture bind-group selection, pixel-art crispness tested,
runtime mode change honoured. Renderer vertex path now uses one reused/grown GPU
vertex buffer + no per-quad allocation. The `getLastFrame` per-present readback is
on-demand now — both done; see `todos/WEBGPU.md`.)

### SDL_GPU (SDL3 explicit GPU API) — ✗ missing — P1, **JSPI-gated**
The modern SDL3 GPU abstraction: `SDL_GPUDevice`, command buffers, render/compute
copy passes, graphics/compute pipelines, GPU buffers/textures/samplers, transfer
buffers, fences, swapchain, shader formats. Natural mapping is **onto our
`webgpu.h` binding** (Phase A surface already covers buffers/textures/pipelines/
bind groups/compute). Same blocker as the renderer unification: SDL_GPU's
device/await calls vs async WebGPU with no JSPI. **Defer the bulk until JSPI on
iOS;** a thin always-available subset (device creation, basic graphics pipeline)
could be prototyped behind a feature gate. Shader story: SDL_GPU expects
SPIR-V/DXIL/MSL; on web we'd require WGSL (or a translator) — decide the shader
ingestion path.

### Events (SDL_events) — ◑ partial — P0
Missing: `SDL_PushEvent`, `SDL_WaitEvent`/`WaitEventTimeout` (no-JSPI: must be
the callback model, not a true block), `SDL_PeepEvents`, event filters/watchers
(`SetEventFilter`), `SDL_FlushEvents`, and event *types*: window events, text
input/editing (IME), gamepad/joystick, touch, pen, drop (file drag-drop),
clipboard-update, render-targets-reset. Web: DOM event listeners already feed the
queue; extend the producers.

### Keyboard (SDL_keyboard) — ◑ partial — P0
Have: key down/up events with full USB-HID `SDL_Scancode`s (letters/digits/
punctuation/keypad/nav/modifiers) + keycodes. Missing: `SDL_GetKeyboardState`
(snapshot array), scancode↔keycode maps (`SDL_GetKeyFromScancode`, names),
`SDL_GetModState` (event `.mod` is not yet populated),
**text input** (`SDL_StartTextInput`/`Stop` + `SDL_EVENT_TEXT_INPUT`, IME),
on-screen keyboard. Web: `KeyboardEvent.code`/`key`, `beforeinput`/composition.

### Mouse (SDL_mouse) — ◑ partial — P0
Have: motion/button/wheel events (wheel `.y` sign matches SDL: +y = away/up,
+x = right). Missing: `SDL_GetMouseState` /
`GetRelativeMouseState`, **relative mouse mode** (`SDL_SetWindowRelativeMouseMode`
→ Pointer Lock — critical for FPS games), cursor create/set/show/hide
(`SDL_CreateCursor`, system cursors), `SDL_WarpMouseInWindow`, mouse capture.
Web: Pointer Lock API, CSS cursors.

### Gamepad / Joystick (SDL_gamepad, SDL_joystick) — ✗ missing — P1
Entire subsystem absent. `SDL_GetGamepads`, open, button/axis state + events,
mappings, rumble. Web: **Gamepad API** (poll-based — fits the frame callback),
`GamepadHapticActuator` for rumble.

### Touch / Pen (SDL_touch, SDL_pen) — ✗ missing — P2
`SDL_GetTouchDevices`, finger events, pressure. Web: Pointer/Touch events.

### Audio (SDL_audio) — ◑ partial — P1
Have: output stream queue (Web Audio). Missing: **recording/capture**
(getUserMedia), device enumeration (`SDL_GetAudioPlaybackDevices`),
`SDL_AudioStream` format conversion/resampling (SDL does this in-lib; verify ours
resamples or document the constraint), audio callbacks
(`SDL_SetAudioStreamGetCallback`), multiple streams/devices, `SDL_LoadWAV`,
gain/`SDL_SetAudioStreamGain`, channel maps.

### Timer (SDL_timer) — ◑ partial — P1
Have: `GetTicks` (ms), `Delay`. Missing: `SDL_GetTicksNS`,
`SDL_GetPerformanceCounter`/`Frequency` (high-res timing — many games need it),
`SDL_DelayNS`/`DelayPrecise`, `SDL_AddTimer`/`AddTimerNS` (callback timers —
map to setTimeout, fire via the frame loop). Web: `performance.now()`.

### Filesystem / IO (SDL_iostream, SDL_filesystem, SDL_storage) — ✗ missing — P1
`SDL_IOFromFile`/`IOFromMem`/`IOFromConstMem`, read/write/seek/tell/close,
`SDL_LoadFile`/`SaveFile`, `SDL_GetBasePath`/`GetPrefPath`, the Storage API.
Note: this runtime already has a libc FS (BlockFS/OPFS) — `SDL_IOFromFile` should
**bridge to the existing FS**, not reinvent it. Pref/base path → a BlockFS dir.

### Threads / sync / atomics (SDL_thread, SDL_mutex, SDL_atomic) — ✗ missing — P2
`SDL_CreateThread`, mutex/cond/semaphore/rwlock, `SDL_RunOnMainThread`, atomics.
Hard without pthreads. Options: back atomics with `Atomics`/SAB (already used by
the SAB runner), back threads with Web Workers (heavy, limited), or **stub
single-threaded** + fail loud on real thread creation. Decide policy; many ports
only need atomics + a mutex.

### Clipboard (SDL_clipboard) — ✗ missing — P3
`SDL_SetClipboardText`/`GetClipboardText`/`HasClipboardText`. Web:
`navigator.clipboard` (async + permission — needs the callback model).

### Properties (SDL_properties) — ✗ missing — P2
SDL3's typed key→value store, used by `*WithProperties` constructors across
video/renderer/GPU. A pure-C in-wasm hash map (no host needed). Implement early
since other subsystems' "modern" constructors depend on it.

### Hints (SDL_hints) — ✗ missing — P2
`SDL_SetHint`/`GetHint` + the hint constants programs set (e.g. render driver,
mouse relative warp). Pure-C store; honor the few that matter, ignore the rest.

### Logging / errors / version / platform — ◑ partial — P2
`SDL_Log`/`LogError`/... → console (easy). `SDL_GetError`/`SetError` (thread-less
global string). `SDL_GetVersion`, `SDL_GetPlatform` ("Emscripten"-like).

### Power / Sensors / Haptics / Locale / Misc — ✗ missing — P3
`SDL_GetPowerInfo` (navigator.getBattery), sensors (DeviceOrientation),
haptics (gamepad rumble — see Gamepad), `SDL_GetPreferredLocales`,
`SDL_OpenURL` (window.open), message boxes / `SDL_ShowMessageBox` /
`SDL_Dialog` open-file (DOM `<input type=file>` / `alert`).

### stdinc / SDL_main — ◑ partial — P1
`SDL_main`/`SDL_MAIN_USE_CALLBACKS` entry handling (see Architecture — make the
callback model the supported entry path). `SDL_malloc`/`free`/`memcpy` etc. map
to libc. `SDL_GetEnvironment`.

### Satellite libraries — out of scope here (track separately)
SDL_image (browser image decode could back it), SDL_ttf (font rasterization),
SDL_mixer (on top of audio). Note as future, separate docs.

## Suggested build order

1. **Input completeness (P0):** keyboard state + modifiers, mouse state +
   **Pointer Lock** (relative mode), full event types incl. **window resize**.
   Unblocks most games.
2. **Renderer completeness (P0):** render targets, viewport/clip/scale, **logical
   presentation**, plural primitives, RenderReadPixels. (Plus fix the readback
   perf — `todos/WEBGPU.md`.)
3. **Timing + IO + properties + hints (P1/P2):** high-res timers; `SDL_IOFromFile`
   bridged to the existing FS; the properties + hints stores.
4. **Gamepad (P1):** Web Gamepad API, poll in the frame callback.
5. **Audio completeness (P1):** capture, WAV load, gain, device enum.
6. **SDL_GPU (P1) — JSPI-gated:** map onto `webgpu.h`; bulk deferred to JSPI on
   iOS (shares the renderer-unification blocker).
7. **Threads/atomics policy (P2), clipboard/power/misc (P3).**

## Constraints to honor (carried from the rest of the project)

- **No JSPI:** anything that "blocks" (WaitEvent, Delay, device await, clipboard
  read) must be expressed through the frame-callback model, not a real block.
- **Fail loud** on unsupported calls (don't silently no-op) — match the WebGPU
  binding's stance.
- **Tests:** each subsystem lands with a `tests/browser/` sample + Playwright
  assertion (pixel for video, value for input/audio/timer), then vendored into
  `netguc/c` with an e2e case (graphical sheet / headless).
