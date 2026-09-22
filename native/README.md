# Optional native SDL3 and WebGPU for Node

Standalone Node execution needs no npm packages. `compiler.js` and `host.js`
are sufficient for console programs; generated `.js` files embed the runtime.
Native window/audio/GPU support is an optional addon. Browser and gucOS backend
selection are unchanged, including gucOS's separate optional npm Dawn tier.

## Build and run

```sh
node native/build.js
node compiler.js game.c -o game.wasm
node host.js game.wasm
# Or embed Wasm and the runtime in JS:
node compiler.js game.c -o game.js
node game.js
```

The build uses plain C Node-API, without node-gyp or node-addon-api. It needs
Node with fetch, a C compiler, tar, unzip, and CMake (default
`~/.local/bin/cmake`; override with `--cmake=/absolute/path`). It downloads
SHA-256-pinned SDL 3.4.16 source and wgpu-native v29.0.1.1 binaries, and verifies
Node header downloads against the Node release checksum manifest. Cached
installed dependencies are reused; `--deps-only` prepares SDL/wgpu dependencies.
`--no-webgpu` builds an SDL-only addon without a wgpu-native runtime dependency.
All downloaded/build outputs are under ignored `build/native/`.

macOS arm64 has been exercised here. The inherited build also provides macOS
x64 and Linux arm64/x64 dependency selections; Linux needs development headers
for the desired video/audio drivers. Those other targets have not been tested
here. Windows builds are not implemented by this component.

## Doom example and data files

From the repository root, after building the addon:

```sh
node compiler.js vendor/doom/bin.json -o doom.wasm
node host.js doom.wasm -iwad vendor/doom/data/doom1.wad
```

Raw `.wasm` output does not embed a project's `dataFiles`. The Node runner uses
host files, so pass Doom's WAD path explicitly or run from a directory containing
it. `.js` output embeds project assets, extracts them into a temporary working
directory, and removes that directory on exit; saves written there are temporary.

## Selection and absence

`node host.js game.wasm --sdl=auto|native|null` selects the backend. For generated
JS, pass the same option to **compiler.js at compile time**. Embedders pass
`sdlBackend: 'auto' | 'native' | 'null'` to `require('./host.js')({...})`.

- **auto** (default): only a standalone Node module importing SDL, clipboard,
  or WebGPU probes the addon. No addon is fine: console execution and local SDL
  helpers/timers remain usable. SDL video/audio/gamepad initialization returns
  false with `SDL_GetError()` set; window/audio creation fails normally. WebGPU
  adapter requests report unavailable. A present but unloadable addon prints
  its loader error and uses the same unavailable behavior.
- **native**: the same lazy selection, but a missing or unloadable addon throws
  a diagnostic when native imports are present. Console modules do not probe it.
- **null**: explicitly select the existing headless simulation (no real devices;
  fake resource handles). Intended for headless tests, never an implicit claim
  that unavailable video/audio initialized successfully.

Local process clipboard storage remains available without the addon; with
native support it uses SDL's system clipboard. Explicit browser/caller-supplied
adapters and kernel surface adapters retain their existing precedence.
An SDL-only addon supports SDL while GPU adapter requests report unavailable.

## Copying the runtime

Keep this relative layout (use `.so` files on Linux):

```text
compiler.js
host.js
native/
  sdl3.node                  # from build/native/sdl3.node
  sdl/lib/libSDL3.0.dylib     # preserve library filenames/sonames from sdl/lib
  wgpu/lib/libwgpu_native.dylib   # omit for an SDL-only build
```

Copy the corresponding `build/native/sdl/lib/` and `build/native/wgpu/lib/`
contents beside the addon. Loader-relative search paths allow relocation.
Discovery checks the runtime script's directory and ancestors for `sdl3.node`,
`native/sdl3.node`, and `build/native/sdl3.node`. Generated JS uses its own
location as the starting point. No build tools or npm installation are required
on the receiving machine; Node and OS graphics/audio facilities are required.
Use matching OS/architecture binaries. Removing the optional native directory
restores the normal unavailable-capability behavior.

Retain SDL's zlib license (`build/native/sdl/share/licenses/SDL3/LICENSE.txt`)
and applicable wgpu-native/wgpu third-party notices with redistributed binaries.
This repository does not commit the downloaded third-party binaries.

## API and lifecycle boundary

This implements the compiler's existing SDL/WebGPU import surface, not the
entire upstream SDL3 API. The C veneer still owns its structs, allocation,
local helpers, audio conversion, image/font code, and documented API limits.
Native pointers never enter Wasm or JS: the addon uses typed integer handles.

SDL runs on Node's main thread, with one active native program per addon.
`runModule` releases owned GPU resources before SDL resources on success,
traps, and failures during setup. Caller-supplied SDL adapters remain caller-owned.
WebGPU completions are pumped through the callback loop; GPU programs should use
`wgpuSetMainLoopCallback`. A blocking SDL loop does not pump GPU completions.
A window has one presentation path: SDL renderer, window surface, or WebGPU.

## Verification and provenance

```sh
node tests/host/test_native_optional.js # no-addon/broken-addon, npm forbidden
node tests/native/sdl.js               # requires native build; dummy drivers
node tests/native/webgpu.js            # requires WebGPU build; real offscreen GPU
node tests/native/webgpu.js --surfaces # native window/surface lifecycle
node tests/native/run.js               # reports skipped optional tiers explicitly
```

SDL tests cover all C host imports, resource types/bounds, pixels, clips,
textures, audio consumption, input, compiled C, generated JS, relocation and
cleanup. GPU tests cover imports/enums, real compute, rendering/readback,
memory growth, error scopes and cleanup. Physical gamepads and visible window
presentation are not certified by the default tests.

Ported from sibling `c-compiler-simplified` commit `08cfe69` (native C addon,
build script, runtime adapters and native tests), adapted for this repository's
split compiler/host and optional auto mode under ticket #797. The sibling's
quad batching and additional C API extensions are not part of this port.
