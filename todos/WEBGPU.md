# WebGPU for the C compiler (webgpu.h)

Status: **planned, starting Goal A (the `webgpu.h` binding).**
Decision date: 2026-06-18.

## What and why

Expose the browser's **WebGPU** API to compiled C programs as a first-class
platform capability. A C program should be able to `#include <webgpu.h>`, get an
adapter/device, configure a surface backed by the run's canvas, and drive the
full WebGPU object graph (buffers, textures, shader modules, pipelines, command
encoders, render/compute passes, queue submit, present).

This is the chosen path for *all* accelerated rendering on this platform:

- WebGPU is reachable **without JSPI** — its API was designed around the
  callback/`requestAnimationFrame` style, which is exactly the no-JSPI callback
  model this runtime already adopted for SDL. So it runs on every engine,
  Safari/iOS included (once Safari ships WebGPU; see "Engine support").
- It becomes the substrate for a future SDL3 Renderer/Texture (or `SDL_GPU`)
  layer (**Goal B**, separate doc) — but the primary deliverable is raw WebGPU
  for C, not an SDL-only capability.

Goal A here = the `webgpu.h` binding + samples + tests. Goal B (SDL renderer on
top) is deliberately out of scope for this doc.

## Precedent (and why little of it transfers)

- Core SDL3 has **no** `SDL_WebGPU_CreateContext` the way it has
  `SDL_GL_CreateContext`. WebGPU is not a windowing-client API.
- SDL3's `SDL_GPU` abstraction targets Vulkan/Metal/D3D12; its **WebGPU backend
  is in-flight PR work, not in a shipped release** (libsdl-org/SDL #10768,
  #12046, #15722).
- The de-facto bridge is the community extension **`eliemichel/sdl3webgpu`**
  (and `Twinklebear/sdl2webgpu`): a one-function `SDL_GetWGPUSurface(instance,
  window)`. On its web path it doesn't query SDL at all — it builds the surface
  from a canvas CSS selector. WebGPU itself comes from the standard `webgpu.h`
  (Dawn / wgpu-native / Emdawnwebgpu), not SDL.

What transfers to us: the **C API surface** (standardized `webgpu.h`) and the
**binding pattern** (Emscripten `library_webgpu.js` / Emdawnwebgpu JS glue:
handle table + descriptor marshalling). What does NOT transfer: the plumbing —
we are not Emscripten; we have a custom `compiler.js` + `host.js`. We write the
binding ourselves.

## Dialect decision: modern standard `webgpu.h` (Dawn/Emdawnwebgpu)

We bind to the **current standardized `webgpu.h`** that Dawn, wgpu-native, and
Emdawnwebgpu converge on (`WGPUStringView`, callback-info structs, future-style
async), NOT the deprecated old Emscripten `webgpu.h` (plain `const char*`, simple
2-arg callbacks).

Rationale: it is THE standard in 2026; current `sdl3webgpu` and the SDL3 WebGPU
examples target it unmodified (we want those to compile); and it matches the
project's "no shortcuts" stance. Cost: more surface to marshal (StringView,
callback modes) — accepted.

## Architecture

All of this lives in the existing single-`env` import model — no new runtime
fork.

### 1. The header — `webgpu.h` in `compiler.js`

Add `"webgpu.h"` to `_stdlibHeaders` (the SDL.h precedent at compiler.js ~17089).
Pure declarations: opaque handle typedefs (`typedef struct WGPUDeviceImpl*
WGPUDevice;` …), enums, descriptor structs, `WGPUStringView`, callback-info
structs, and `extern` prototypes for every `wgpu*` function. No C implementation
file is needed (unlike `__SDL.c`): each `wgpu*` prototype maps **directly** to a
host import. The header just declares them `extern` so calls lower to wasm
imports that `host.js` satisfies.

Handles are pointer-sized opaque ints (i32 in wasm32). Structs use the exact
field order/sizes the binding reads back from linear memory — this header and the
JS marshaller are one contract; they change together.

### 2. The binding — `createBrowserWebGPU({ canvas, ctx })` in `host.js`

Mirrors `createBrowserSDL` (host.js ~4480) and is merged the same way
(`Object.assign(imports[ENV_KEY], webgpu[ENV_KEY])` near host.js ~6286, right
after the SDL merge). A `createNullWebGPU()` stub variant resolves the imports in
headless/Node so modules always instantiate.

Three mechanisms:

- **Handle table.** A JS array/Map mapping integer handle → live JS WebGPU object
  (`GPUDevice`, `GPUBuffer`, `GPUTexture`, `GPURenderPipeline`,
  `GPUCommandEncoder`, …). Each `wgpuXCreateY` allocates a handle and stores the
  JS object; each `wgpuYRelease` frees it. Handle 0 = null.
- **Descriptor marshalling.** Read descriptor structs out of wasm linear memory
  via `ctx.getMemory()` + DataView, following the header's field layout, into JS
  descriptor objects. Strings via `WGPUStringView` (ptr+len) → `readString`-style
  decode. Chained structs (`nextInChain`) walked by `sType`.
- **Async via callbacks (NO JSPI).** `wgpuInstanceRequestAdapter`,
  `wgpuAdapterRequestDevice`, `wgpuBufferMapAsync`, `wgpuQueueOnSubmittedWork…`
  take callback-info structs. The binding calls the JS Promise
  (`navigator.gpu.requestAdapter()` …) and, on resolve, invokes the C callback
  **function pointer through the indirect function table**
  (`ctx.getIndirectFunctionTable().get(fnPtr)(status, handle, message, userdata)`)
  — the identical mechanism `__sdl_set_animation_frame_func` uses for frames.
  Per-frame rendering is fully synchronous WGPU calls; only setup is async.

### 3. The surface — straight from the run's OffscreenCanvas

No SDL, no selector. We already own the OffscreenCanvas transferred into the run
worker (the SDL graphical path). `wgpuInstanceCreateSurface` /
`wgpuSurfaceConfigure` resolve to `canvas.getContext('webgpu')` +
`context.configure({ device, format, … })`. `wgpuSurfaceGetCurrentTexture`
returns a handle wrapping `context.getCurrentTexture()`. "Present" is implicit on
the web (the browser presents the configured context after the frame), so
`wgpuSurfacePresent` is a no-op/bookkeeping call — documented as such.

## Tiered scope (build order)

Architecture supports the whole API; we prove it end-to-end first, then widen.

- **Tier 0 — triangle.** instance, requestAdapter, requestDevice, queue, surface
  configure + getCurrentTexture + view, WGSL shader module, render pipeline,
  command encoder, render pass (clear + draw), submit. Screenshot a colored
  triangle. This proves every mechanism (handles, marshalling, async callbacks,
  surface).
- **Tier 1 — textured quad.** buffers (vertex/index/uniform), `writeBuffer`,
  bind group layouts + bind groups, textures + sampler + `writeTexture`, vertex
  layouts. Screenshot a textured quad.
- **Tier 2 — SDL3 + WebGPU sample.** An SDL3 window program that uses the
  `sdl3webgpu`-style surface bridge (surface from our canvas) and renders with
  WebGPU. Confirms the headline use case compiles and runs.
- **Tier 3 — completeness.** compute pipelines + dispatch, all texture formats,
  query sets, render bundles, multiple bind groups, buffer mapAsync read-back,
  error scopes / uncaptured-error callback. Additive; each lands with a test.

Any cap or unimplemented enum **fails loud** (throw with the function/enum name),
never silently no-ops — per the repo's "surface errors loudly" rule.

## Testing

1. **c-compiler browser harness** (`tests/browser/`, modeled on
   `sdl-input-check.mjs` + `server.mjs`): compile each sample to a self-contained
   page, drive with Playwright (Chromium, WebGPU enabled), screenshot, assert on
   pixels (e.g. center pixel is the triangle color, corners are clear color).
   `webgpu-renders.mjs` alongside `doom-renders.mjs`.
2. **Vendor into netguc/c** via `scripts/sync-compiler.sh`, then run the samples
   through the real graphical run pipeline (`GraphicalRunSheet`, OffscreenCanvas
   through nested workers); Playwright e2e + screenshot.
3. **Real Safari** via safaridriver + Selenium (netguc/c `scripts/safari-probe`
   style + `tests/browser/safari-renders.mjs`): confirm WebGPU presence on the
   shipping engine and that a sample renders. Playwright's `webkit` is trunk and
   is NOT authoritative for shipping-Safari capability (see memory:
   playwright-webkit-is-not-safari).

## Engine support / risks

- **WebGPU shipping:** Chrome/Edge yes; Firefox rolling out; **Safari** ships
  WebGPU in Safari 26 (2025). Verify on the mac mini's real Safari before relying
  on it — do NOT infer from Playwright webkit.
- **No JSPI needed** (the whole point) — async is callback-based, frames via rAF.
- **OffscreenCanvas + WebGPU in a nested worker** is the real risk on iOS (same
  topology risk already flagged for the Canvas2D SDL path). Probe early on real
  Safari; the graphical sheet's debug overlay surfaces worker-side errors.
- **Dialect churn:** the modern `webgpu.h` struct names have moved
  (`WGPUSurfaceDescriptorFromCanvasHTMLSelector` →
  `WGPUEmscriptenSurfaceSourceCanvasHTMLSelector`). Pin to the current
  Emdawnwebgpu spelling; header + marshaller move together.

## Out of scope (this doc)

- Goal B: SDL3 Renderer/Texture or full `SDL_GPU` on top of this binding.
- Native (non-browser) WebGPU.
