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

## Known strays still open (audited, not yet fixed)

Each of these violates **correctness**, **performance**, or both (per the Guiding
principles). Listed so they're visible, not silently shipped.

### Correctness
- **Event `timestamp` is always 0.** SDL stamps every event with
  `SDL_GetTicksNS()`; ours are memset-zeroed in `__sdl_push_*`.
- **Keyboard `mod` never populated** (no `SDL_GetModState`). Programs reading
  `event.key.mod` for Shift/Ctrl/Alt see 0. Web: `KeyboardEvent.getModifierState`.
- **Keyboard `repeat` never set.** DOM provides `e.repeat`; every auto-repeat
  currently looks like a fresh press.
- **Shifted-letter keycode is wrong.** `keysym` returns `e.key.charCodeAt(0)`, so
  Shift+A → keycode 65; SDL's keycode for the A key is `SDLK_a` (97) regardless of
  shift. (Unshifted letters are fine; scancodes are now correct.)
- **Mouse `xrel`/`yrel` always 0; no relative / pointer-lock mode.** Kills FPS
  mouselook; `SDL_GetRelativeMouseState` / `SDL_SetWindowRelativeMouseMode` absent.
- **Mouse motion `state` mask + button `clicks` never set** (no held-button mask,
  no double-click count).
- **Duplicate `SDL_PIXELFORMAT_RGBA32` macro** with conflicting values
  (`0x16462004` then `0x16762004`). Harmless only because the host treats every
  texture as RGBA bytes, but it's a real redefinition.
- **Audio:** no format conversion / resampling (the defining feature of
  `SDL_AudioStream`); the get-callback pull mode is silently ignored;
  `PutAudioStreamData` drops on a full ring; `GetAudioStreamQueued` returns a
  `0x7FFFFFFF` sentinel when no SAB is wired.
- **`SDL_Init` ignores its flags** — no subsystem tracking; no `SDL_WasInit` /
  `SDL_InitSubSystem` / `SDL_QuitSubSystem`.
- **`SDL_SetWindowTitle` is a no-op**, and **`SDL_CreateTextureFromSurface`
  assumes RGBA32** input.
- **`SDL_RenderLine` / `SDL_RenderRect` are quad approximations** (1px quad / 1px
  borders), not Bresenham — sub-pixel coverage and endpoints differ slightly.
- **Forced linear texture filtering; no `SDL_SetTextureScaleMode`.** The renderer
  sampler is hardcoded `linear`. SDL3's *default* is also linear, so defaults
  match — but a program can't select `SDL_SCALEMODE_NEAREST`, so **pixel-art games
  render blurry when scaled** with no fix. (Fix: a second nearest sampler +
  per-texture bind group selected by the texture's scale mode.)
- **HiDPI: the canvas renders at logical size and is CSS-upscaled.**
  `canvas.width = w` (logical), so on a retina display output is upscaled by the
  browser, not rendered at device-pixel density like native SDL. Blurrier; no
  `SDL_GetWindowSizeInPixels` / pixel-density / `devicePixelRatio` handling.
- **Destroying a texture already recorded in the current frame's batch** → null
  deref at present (`texBindGroup` on a nulled slot). SDL tolerates this; we trap.
  Robustness edge case.
- **Deferred batch-render model vs SDL's immediate mode** (subtle, mostly within
  spec): draws are recorded and executed only at `RenderPresent` (one pass,
  `loadOp: clear`). Equivalent under SDL's "backbuffer undefined after present"
  rule, BUT a program that draws incrementally **without clearing** (expecting the
  previous frame to be retained) won't see it retained.

### Performance
- **Per-present GPU→CPU readback runs unconditionally.** Every
  `SDL_RenderPresent` does a `copyTextureToBuffer` + `mapAsync` + an **O(W·H)
  per-pixel JS loop** allocating a fresh `Uint8Array(W*H*4)`, solely to feed
  `getLastFrame()` (the capture probe). A normal render loop pays this **every
  frame even when nothing is capturing**. Fix: make it **on-demand** (only when a
  capture is pending) and move the unpad/BGRA→RGBA swizzle onto the GPU. (Also in
  `todos/WEBGPU.md` → Performance.)
- **Per-primitive allocation in the renderer.** `__sdl_render_quad` allocates a
  48-float `Float32Array` per quad; `rdrFlush` then allocates one combined array
  **and creates+destroys a GPU vertex buffer every present**. A sprite/tile-heavy
  frame churns N allocations + a buffer create/destroy per frame; the expected
  cost is a reused, grown vertex buffer.
- **`SDL_UpdateTexture` reuploads the whole texture** for any update (it ignores
  the sub-rect, see Correctness) — a one-pixel change is O(texture).

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
(`SDL_RenderDebugText`); `SDL_GetRenderDrawColorFloat` / float-color variants;
scale mode per texture (`SDL_SetTextureScaleMode`). Note: the per-frame readback
that already exists (`getLastFrame`) has a perf issue — see `todos/WEBGPU.md`
Performance section.

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
