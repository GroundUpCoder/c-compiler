# WebGPU for the C compiler (webgpu.h)

Status: **Tiers 0–3 + conformance pass A1–A9 landed. Direction (2026-06-19):
finish the conformance pass (A10–A15) on the surface we already expose, PAUSE
further surface expansion (Phase B), and make SDL3 the next major feature (see
`todos/SDL3.md`). Unifying SDL_Renderer onto `webgpu.h` is deferred until JSPI
reaches iOS. See "Progress + revised direction" below.**
Decision date: 2026-06-18. Full-coverage plan: 2026-06-19.

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

---

# Path to full spec coverage (2026-06-19)

Tiers 0–3 proved the architecture end-to-end. The binding now covers the common
render + compute path, but a large slice of `webgpu.h` is either **declared but
silently dropped** (descriptor fields the glue ignores) or **not present at
all**. This section is the gap inventory + build order to reach faithful,
fully-tested coverage of the standard (Dawn/Emdawnwebgpu) `webgpu.h`.

## Definition of done

For every feature in the standard `webgpu.h`:
- **Implemented correctly** — descriptor fields are marshalled, not dropped.
- **Complete** — every enum variant is present and mapped; `Undefined` → the
  spec default, **unknown values throw/abort** (no silent `|| 'default'`).
- **Fails loud** on anything genuinely unsupported by the browser/runtime.
- **Tested** — a `tests/browser/webgpu-<feat>.c` + `-renders.mjs` asserting on
  pixels or compute readback; representative capstones re-verified on real
  Safari (in-page pixel read-back, never screenshots); vendored into `netguc/c`
  with an e2e case (graphical sheet or headless compute).

## Invariants (unchanged from Tiers 0–3)

- 3-layer contract: `webgpu.h` + `__webgpu.c` (in `compiler.js`) flatten
  descriptors into **primitives / packed-int arrays**; `host.js`
  (`createBrowserWebGPU`) keeps the int↔JS handle table and calls real WebGPU.
  The host never reads C struct layouts.
- Array-bearing descriptors use the packed-int convention already established
  (`[count, per-item fields…]`); raise the static `cap` + `abort()` on overflow.
- Async is callback-based, **NO JSPI** (host invokes `__wgpu_call_*_cb`
  trampolines). Frames via `wgpuSetMainLoopCallback` → shared rAF.
- **Enum values:** names are the contract (header↔host self-consistent). New
  variants get canonical `webgpu.h` values where known; existing working enums
  are **not** retroactively renumbered.
- **Environment-gated** features (compressed formats, `timestamp-query`,
  `float32-filterable`, …) are implemented + **feature-detected**, tested where
  the runtime supports them, and **logged as skipped** otherwise — never
  silently passed.

## Progress + revised direction (updated 2026-06-19)

**Landed (each on `main` with a `tests/browser/webgpu-*` pixel/readback test):**
A1 ✅ A2 ✅ A3 ✅ A4 ✅ A5 ✅ A6 ✅ A7 ✅ A8 ✅ A9 ✅ A10 ✅ A11 ✅ A12 ✅.

- **A10+A11** (`webgpu-mrt`): render pipeline color targets and render-pass color
  attachments are now packed arrays — multiple color targets with per-target
  `writeMask`, and multiple color attachments with `depthSlice`. `writeMask` is
  honored as-is (0 == None; the C API requires the caller to set it, as all
  samples do). The single-target/single-attachment glue is gone.
- **A12** (`webgpu-const`): pipeline-overridable constants (`WGPUConstantEntry`)
  for vertex/fragment/compute. `__wgpu_pack_constants` flattens each stage's
  constants into a parallel int (key ptr/len) + double (value) array; the host
  rebuilds the `{name: value}` record. `WGPUConstantEntry` now has a full struct
  definition (was a forward decl).

**Direction decision (2026-06-19):** stop *widening* the WebGPU surface for now;
make the surface we already expose as **conformant** as possible instead.

- **Immediate work = finish Phase A (A10–A15).** These are not new API — they
  fix *silent drops on already-declared* functions/structs (MRT + write masks,
  multiple color attachments, pipeline constants, full sampler, depth bias /
  read-only / stripIndex, surface viewFormats/presentMode). I.e. conformance of
  the declared surface, per the "behaves correctly for the surface we implement"
  goal.
- **Phase B (B16–B27) = PAUSED.** Adding brand-new API surface
  (viewport/scissor, copies, query sets, render bundles, indirect, …) is
  deferred — revisit after the conformance pass and after SDL3 (below).
- **Next major feature after conformance = SDL3** (see `todos/SDL3.md`), not more
  raw WebGPU.

Vendored into `netguc/c` on disk (compiler `b8bdbc4`); netguc e2e + vendored-bump
commit deferred until port 8006 is free (dev server running).

## DEFERRED: unify SDL_Renderer onto the `webgpu.h` binding — wait for JSPI

Considered (2026-06-19): reimplement the SDL backend's renderer/blitter (today a
~550-line hand-written JS WebGPU path in `createBrowserSDL`, with its own
`createCanvasGPU` device acquisition, pipelines, and readback) **in C on top of
`webgpu.h`**, so there is ONE WebGPU code path that both raw and SDL programs
exercise.

**Verdict without JSPI: not a clear win — deferred.** Complexity *relocates*
JS→C rather than dropping (~250–350 JS lines deleted, comparable C added), and
the one hard part gets *harder* in C: `SDL_CreateRenderer`/`RenderPresent` are
**synchronous**, WebGPU device acquisition is **async**, and with **no JSPI** C
cannot block — so the C glue would have to hand-roll the async "device-ready?"
state machine + frame buffering that JS today expresses cleanly with promises
(`createCanvasGPU.whenReady`). Net ~neutral LOC + real regression risk on a path
that already works and is already 100% GPU-backed.

**With JSPI it flips to a clear win.** `SDL_CreateRenderer` could *suspend* on
`wgpuAdapterRequestDevice` and return a ready renderer synchronously — no
state machine, near-direct port of upstream `sdl3webgpu`/SDL_Renderer, and the
JS path deletes cleanly. JSPI ships in Chrome; **iOS Safari is the holdout**
(see memory `c-sdl-ios-jspi-blocking-loop`). **Revisit when JSPI lands on iOS.**
(NB: the SDL path is already on the GPU — this is code-path *unification*, not a
capability change.)

## Performance characteristics (as implemented, 2026-06-19)

Audited the per-frame hot paths.

- **Raw `webgpu.h` binding: no per-frame GPU resource allocation.** Buffers /
  textures / pipelines / bind groups are created once at setup. Per frame a
  program creates only the transient swapchain texture + view + command encoder
  + render pass + command buffer — required by WebGPU — and on our side those are
  handle-table slots **reused via a freelist** (O(1), no array growth, by
  design). `writeBuffer`/`writeTexture` copy in place via a `Uint8Array` *view*
  over wasm memory (no alloc). Per-call cost is O(1) / O(descriptor size).
- **The one genuinely expensive per-frame path is the SDL_Renderer readback**
  (`rdrEncodeReadback`/`rdrStartReadbackMap`, `host.js:~4775`), used for
  `getLastFrame()` snapshots: after every present it does a `copyTextureToBuffer`
  + `mapAsync` (GPU buffer reused, one-in-flight guard — good) **but** a
  double-nested **O(W·H) per-pixel JS loop** that allocates a fresh
  `new Uint8Array(W*H*4)` every frame to de-pad 256B-aligned rows and swap B/R.
  **Fix:** do BGRA→RGBA + unpad on the GPU (small blit/compute), or row-wise
  `.set` when no swizzle is needed (rows are already contiguous).
- **Minor:** `Array.from(new Uint32Array(...))` in dynamic-offset `SetBindGroup`
  allocates a JS array per call (per draw) — pass the typed array directly or
  reuse a scratch. `beginRenderPass` rebuilds a small descriptor object each
  frame (cheap; unavoidable in the stateless design).

## Phase A — fix "implemented but not to spec" (silent drops / partial coverage)

A1. **Texture formats** — full `WGPUTextureFormat` set + host maps + a
    bytes-per-block helper for copy validation; compressed (BC/ETC2/EAC/ASTC)
    behind feature-detect.
A2. **Vertex formats** — full `WGPUVertexFormat` set (8/16/32-bit, float16,
    unorm10-10-10-2).
A3. **Lossy enum collapses → exact** — address/filter/mipmap-filter, `alphaMode`
    (+ Unpremultiplied/Inherit), sampler & texture binding types: default on
    `Undefined`, throw on unknown.
A4. **Buffer write-mapping + `mappedAtCreation`** — creation-mapped buffers and
    write-back on `unmap` (today only the read path exists).
A5. **Multisample / MSAA** — `WGPUMultisampleState` into the pipeline +
    `resolveTarget` in color attachments.
A6. **Dynamic bind-group offsets** — render + compute `SetBindGroup` (today
    `abort()`).
A7. **Texture view descriptors** — format / dimension (1d/2d/2d-array/cube/
    cube-array/3d) / aspect / base+count mip & array layers.
A8. **Storage-texture bind layout** — handle the kind the glue currently skips.
A9. **Texture binding `viewDimension`/`multisampled`** — read from the struct.
A10. **Multiple color targets + per-target write masks** (MRT).
A11. **Multiple color attachments + `depthSlice`** in a render pass.
A12. **Pipeline-overridable constants** — `WGPUConstantEntry` (vs/fs/compute).
A13. **Sampler completeness** — lodMin/MaxClamp, maxAnisotropy, compare
     (comparison samplers / shadow maps).
A14. **Depth-stencil completeness** — depthBias/SlopeScale/Clamp,
     depth/stencilReadOnly, `stripIndexFormat`.
A15. **Surface** — viewFormats, presentMode, correct alphaMode.

## Phase B — add "not implemented at all" (highest-use first) — PAUSED

**Paused as of 2026-06-19** (surface expansion deferred; do the A10–A15
conformance pass and SDL3 first). Kept here as the backlog for when it resumes.

B16. **Viewport / Scissor / BlendConstant**.
B17. **`copyBufferToTexture`, `copyTextureToTexture`, `clearBuffer`**.
B18. **`GetBindGroupLayout`** on render & compute pipelines (unlocks
     `layout:"auto"`).
B19. **Adapter/Device introspection** — Get Limits/Info/Features, Has Feature;
     `requestDevice` descriptor (requiredFeatures/Limits) + `requestAdapter`
     options.
B20. **Indirect** — Draw/DrawIndexed/DispatchWorkgroups Indirect.
B21. **Render bundles** — `RenderBundleEncoder*` + `ExecuteBundles`.
B22. **Query sets** — CreateQuerySet, ResolveQuerySet, occlusion + timestamp
     (timestamps feature-gated).
B23. **Async / events** — QueueOnSubmittedWorkDone, Create*PipelineAsync,
     InstanceProcessEvents.
B24. **Error / diagnostics** — SetUncapturedErrorCallback, device-lost,
     ShaderModuleGetCompilationInfo.
B25. **Surface caps** — GetCapabilities, Unconfigure.
B26. **Object lifecycle / introspection** — `AddRef` for every type,
     Buffer/TextureDestroy, Buffer Get Size/Usage/MapState, Texture Get
     Width/Height/…/Format, `SetLabel`.
B27. **Debug markers** — Push/Pop debug group + insert marker (render/compute/
     command encoders).

## Cadence

One commit per increment (or small capstone) in `c-compiler` `main`, each with
its test. After each batch: `netguc/c/scripts/sync-compiler.sh`, rebuild
`/bin` wasms, run netguc e2e, commit the vendored bump in `netguc` `main`.
Report the netguc `c` build number on syncs meant to go live.
