# #496 — SDL render targets: from declared-but-inert to real on every tier

Lane `lane/496` from `5930715b`. Ticket #496 (dup #671 — @master owns the
consolidation; #678 holds a hard edge to #671, so it stays open).

## The defect, as measured on this base

`SDL_TEXTUREACCESS_TARGET` was declared (`compiler.js` SDL.h literal) and
`SDL_CreateTexture` passed `access` through with **no validation** — TARGET was
accepted silently and handed back an ordinary texture. The *function* absence
was already honest (documented in the generated `os/doc/sdl-api-index.md`,
pinned by `tests/host/test_sdl_api_index.js`); the wart was the dangling enum
member plus the silent acceptance. The epic's own dogfood pass hit it live and
fell back to CPU-rasterizing a sprite sheet
(`s3://groundupcoder/gucos/508-passb-r2/2026-08-13/s5-frontier.log`).

## Phase 1 measurement → medium ⇒ implement

Three renderer implementations, one C veneer:

- **GPU tier** — `createBrowserSDL`'s renderer (host.js) serves BOTH the
  standalone page and the OS browser flavor (`createSurfaceSDL` wraps it; the
  present tail ships an ImageBitmap). The batch *representation* was
  target-agnostic; the *flush* was not — hardwired to
  `getCurrentTexture()`, canvas dims, unconditional `loadOp:'clear'`, one
  flush per present.
- **Software tier** — `makeSoftwareRenderer` (headless OS + the explicit
  `"software"`/no-GPU fallback). All draws already funneled into `rd.fb`
  through `quad()`/`tri()`/`render_clear`, and textures keep `cpuPixels` in
  the identical RGBA8 layout — redirection is natural.
- **Null tier** — stubs; only the import must exist.
- **C veneer** — every draw flattens through `__sdl_render_quad` /
  `__sdl_render_geometry` with no dimension deps, so the C side carries the
  whole *contract* and the host carries only the *aim*.

## Design decisions (and why)

- **Upstream contract verified from the SDL3 wiki** (2026-08-15):
  NULL restores the window; the texture must be TARGET-access (error string
  `texture is not a render target` — upstream's); *"Calling SDL_RenderPresent
  while rendering to a texture will fail"* — which forced
  **`SDL_RenderPresent` void → bool** (upstream's real signature; a documented
  failure must be reportable — a void present would have made the refusal
  invisible, a PRINCIPLES.md success-reporting stub). Source-compatible for
  every existing caller.
- **GPU tier: segments, not per-present flushes.** A target switch flushes the
  outgoing batch into its attachment — exactly upstream's
  FlushRenderCommands-at-SetRenderTarget — so cross-switch draw order is
  submit order. Targets render through an **rgba8unorm pipeline family**
  (the canvas family is the preferred format, bgra8unorm on this Mac; a
  fragment target format must match its attachment) with RENDER_ATTACHMENT
  usage. `loadOp` is `'clear'` only when RenderClear was issued for that
  attachment — `'load'` otherwise, which is what makes target content persist
  across binds. The window's first flush of a frame keeps the old
  always-clear semantics **byte-identical** for non-target apps.
- **Mid-frame segment flushes never ship a frame.** onPresent (the
  ImageBitmap ship), the getLastFrame readback, and the deferred texture
  frees are present-time tails (`rdrPresent`). A half-frame ship per target
  switch would burn the #484/#551 bitmap budget that killed pollball's
  pre-conversion shape.
- **Software tier: real dst alpha on targets only.** `put()` grew a `ta` arm
  running SDL_BLEND_DESC's alpha rows (BLEND: dstA = srcA + dstA·(1−srcA);
  ADD/MOD leave dstA; NONE writes srcA). The window path still forces 255 —
  byte-identical to pre-#496, which the existing pixel-exact suites pin.
  Target clears write the draw alpha (transparent clear is the standard
  offscreen idiom).
- **UpdateTexture on a bound target (GPU)** flushes the pending segment first
  so program order holds; the dirty-RECT upload then only overwrites the
  updated region, leaving GPU-rendered content around it intact (both tiers
  agree by construction: sw-tier updates write the same buffer draws hit).
- **Bound-target-as-source is refused loudly** (`SDL_SetError`, all three
  texture-sourcing calls). Upstream leaves it undefined (GL feedback loop);
  a loud named refusal of an upstream-UB case is the honest stricter choice.
- **Access validation at create**: out-of-enum access → `SDL_InvalidParamError`.
  This is the half of the ticket that was a live defect regardless of the
  feature: silent acceptance is what made the trap invisible.
- **Destroy-unbinds**: `SDL_DestroyTexture` of the bound target restores the
  window (upstream behavior), renderer liveness checked best-effort through
  the window backref chain (the #497 `__magic` idiom). Host-side belts clear
  the aim too, so a stale handle can never attach a freed view.
- **Standalone-page readiness gap closed**: `createBrowserSDL` now exposes
  `gpuRendererReady`, so runModule's pre-main device gate covers the
  standalone flavor too — render-target content drawn once in `SDL_AppInit`
  must not fall into the drop-pre-device branch (a per-frame redraw
  self-heals; a once-only target render is lost forever).

## Not covered, with reasons

- Per-target viewport/clip/scale state: those APIs are absent entirely
  (documented, pinned — `SDL_SetRenderViewport` now carries that pin). The
  per-target state lands with them.
- `SDL_RenderReadPixels`: separate absence, unchanged.

## Tests

- **Red control recorded**: on base `5930715b` the new kernel e2e fails —
  in-OS `cc` rejects `SDL_SetRenderTarget` (undeclared), the window never
  appears, driveBoot throws on the dead `wmctl wait` (exit ≠ 0).
- `tests/kernel/test_sdl_rendertarget_e2e.js` (software tier, 18 checks):
  contract legs (STATIC refused, bogus access refused, round-trip, present
  fails while bound, self-source refused) + a discriminating composition —
  window cleared blue AFTER the target renders, so a target that silently
  draws to the screen fails both ways; persistence across re-bind (no-clear
  second bind); transparent target region composites as *nothing*; the
  semi-white BLEND probe is exact (128,128,255).
- `tests/browser/os-rendertarget.mjs` (GPU tier, real Chromium): same scene,
  same probes → the two tiers are pinned to one answer. PASS 11/11.
  Gotcha for future fixtures: `wc -c` counts bytes — an em-dash in a pasted
  C comment is 3 UTF-8 bytes, so the #562 byte-count leg must use
  `Buffer.byteLength`, not `.length`.
- `tests/host/test_sdl_api_index.js`: absence pin re-pointed
  (SDL_SetRenderTarget → SDL_SetRenderViewport, the #468 precedent), plus the
  #496 inversion (the pair must now compile).

## Bookkeeping

image.json 265 → 266 (baked `/usr/include/SDL.h` + baked
`/usr/share/doc/sdl-api-index.md` changed — the #468/#601 precedent).
