# 0055 — the WebGPU compositor (no Canvas2D fallback)

Landed `todos/0055`: `os/compositor.js`'s scene assembly is now the one
WebGPU render pass WM.md designed all along; the Canvas2D draw path is
deleted, not kept as a fallback. Direction decision (and the no-fallback
rationale) was recorded the same day in
`logs/2026-07-09/webgpu-mvu-direction.md` — this entry is about how the
implementation went and what to know when touching it.

## Shape of the pass

One `requestAnimationFrame` → one render pass → one vertex buffer, quads
in painter's order (exactly the old Canvas2D ordering: border → client →
title → boxes → glyphs → text, next window covers all of it):

- **Desktop fill = the pass clearValue** (`WM_COLORS.desktop`). Zero
  quads for an empty scene.
- **One pipeline** for everything, host.js `RENDER_WGSL`-shaped: NDC
  positions + uv + per-vertex color; fragment = `texel * color`,
  source-over blending. Flat chrome quads sample a shared **1×1 white
  texture** (color does the work); textured quads pass white. Consecutive
  same-texture quads batch into one draw, so all-chrome runs (border +
  title + three boxes + glyph rects) cost one draw call.
- **shm surfaces**: per-sid GPUTexture cache, `writeTexture` gated on
  `SH_SEQ` + size (the same discipline as the old scratch-canvas cache —
  the fresh-SAB-after-resize seq-collision comment carried over
  verbatim). Pixels still copy SAB → scratch once per changed frame;
  idle surfaces upload nothing, moves/z-changes just re-sample.
- **gpu surfaces**: `copyExternalImageToTexture` from `surf.bitmap`,
  **identity-gated** — one import per new ImageBitmap. The kernel's
  close-superseded lifetime discipline is untouched (the compositor
  never closes). gpubox frames now go ImageBitmap → texture → pass; no
  CPU pixel path end to end.
- **Text** (title, the close-box 'x') is NOT scene assembly: rasterized
  once per distinct string+width through a throwaway 2D canvas into a
  cached label texture (`fillText` with the same font/baseline/maxWidth
  as before, so the look is identical). Cache is capped and clear-all on
  overflow; titles are few.
- **Rubber band**: the `setLineDash([4,4])` strokeRect became 4-on/4-off
  hairline quads on the same outer 1px ring.
- `configure({alphaMode:'opaque'})` re-runs when the canvas size changes
  (the screen-resize dance); nearest sampler everywhere (todos/0024 —
  integer-scale NN is exactly the headless composite's mapping, and all
  WM scale policy snaps to integer factors).

## The boot guard

`kernel-worker.js` probes the full `navigator.gpu` → adapter → device
chain at the very top of `boot()`, BEFORE the 0045 web lock and any
mount. Failure posts `{type:'boot-nogpu'}`; os.html shows the 0045-style
guard screen (message names the WebGPU requirement, **no Retry** — a
reload won't grow a GPU; `booting` stays latched like boot-error) and
sets `__osState = 'nogpu'` for probes. The acquired device is handed to
`startCompositor` — the compositor never does async acquisition. A lost
device logs loudly to the boot log (no re-acquire path yet; there is
deliberately nothing to fall back to).

## Verification

- Full 10-file browser sweep green **unmodified** (os-boots/wm/doom/
  gpubox/quake/term/vt/screen/scale/shell) — no tolerance changes, which
  was the acceptance bar: chrome geometry, colors, NN scaling, z-layers,
  minimize, maximize, menus, icons all pixel-compatible with the Canvas2D
  path. (One os-boots vi-leg flake on the first run, clean on re-run —
  the known typed-chars-race, unrelated.)
- New os-boots leg: a `--disable-features=WebGPU` Chromium boot lands on
  the guard (`__osState === 'nogpu'`, guard visible, retry hidden).
  Verified empirically that flagless headless Chromium gets **no
  adapter** while `--enable-unsafe-webgpu --enable-features=Vulkan` gets
  one — so os-boots.mjs and os-term.mjs (the two sweep files launched
  flagless until now) gained the standard flags. That's a harness
  requirement of the new platform floor, not a tolerance change.
- kernel + blockfs suites green; headless (`boot.js`, kernel suite,
  `wmScreenshotScreen`) untouched by construction — it never constructs
  a compositor.
- Human-eye check via canvas screenshot: title text, box glyphs, focus
  colors, taskbar + clock all render correctly through the label-texture
  path.

## Gotchas for future compositor work

- `copyExternalImageToTexture` destinations need
  `GPUTextureUsage.RENDER_ATTACHMENT` in addition to COPY_DST/
  TEXTURE_BINDING (spec requirement) — label + gpu-surface textures have
  it, shm textures don't need it.
- WebGPU needs a **secure context**: a probe on `about:blank` sees no
  `navigator.gpu` at all; localhost is fine. Don't chase that ghost.
- Browser pixel tests read the desktop through
  `drawImage(placeholderCanvas)` — that works identically for a
  WebGPU-context OffscreenCanvas, nothing to change there.
- Image version untouched (v32): compositor.js/kernel-worker.js/os.html
  are page/worker scripts, not baked binaries.

Follow-ups deliberately NOT here (ride this pass later, per the item):
per-pixel alpha surfaces, blur/shadow/animation (the Aero wave), damage
rects, kernel cursor sprite.
