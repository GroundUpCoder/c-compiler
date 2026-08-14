# #668 — software SDL tier: real triangle rasterizer (RenderLine bbox / RenderGeometry no-op)

**Ticket:** #668 (P0, contract-violation — wrong pixels reported as success).
**Lane:** `lane/668-sdl-raster`. **Class:** honest-shape fix per `todos/PRINCIPLES.md` —
the implementation option, not the loud-failure option, because the platform carries
the semantic cleanly (it's just CPU rasterization) and three tickets (#672/#603/#533)
are hard-blocked on the real thing.

## The defect, re-derived from source at 14146dfb

- `host.js` `makeSoftwareRenderer` (the SDL_Renderer tier for **every** OS process —
  headless *and* browser; the "browser/WebGPU tier" at ~9190 serves only the
  standalone page): `__sdl_render_quad` collapsed its four arbitrary corners to
  `minx/miny/maxx/maxy` and filled the bbox, so the C veneer's rotated 1px-thick
  RenderLine quad (compiler.js `SDL_RenderLine`) drew a filled rectangle;
  `__sdl_render_geometry` was literally `function () {}` while the C side returned
  `true`.
- `host.js:7181-7182` (`createNullSDL`) also has no-op quad/geometry — **left
  unchanged deliberately**: that flavor has no display at all (clear/present are
  no-ops too); there are no pixels to be wrong. The defect was only in the
  surface-backed tier.

## The fix

One triangle rasterizer (`tri`) added to `makeSoftwareRenderer`, consuming the GPU
tier's own vertex vocabulary — the flat `[x,y,u,v,r,g,b,a]` layout of `RENDER_WGSL`
(u/v normalized, colors 0..1):

- **Coverage:** pixel-center sampling under the GPU's top-left fill rule
  (clockwise-normalized edge functions; top edges run right, left edges run up).
  The two triangles of a split quad neither gap nor double-blend their shared
  edge — load-bearing for BLEND/ADD correctness, not just aesthetics.
- **Sampling:** NEAREST floor-pick and LINEAR texel-center+clamp copied from the
  axis-aligned `quad()` path formulas, so the two software paths sample
  identically; all four blend arms go through the existing shared `put()`.
- **Color:** rounds to nearest at the write (the GPU's float→unorm8 conversion),
  with a pre-put clamp because soup colors may exceed [0,1] (Uint8Array stores
  wrap mod 256 — an unclamped 300 would write 44). The axis-aligned fast path
  keeps its historical truncation; the two paths never rasterize the same call.
- **`__sdl_render_quad`:** axis-labeled corners (everything `__sdl_quad_rect`
  emits) keep the byte-identical scanline fast path; rotated corners split into
  the GPU tier's `(TL,TR,BR)+(TL,BR,BL)` with its exact UV corner mapping.
  Textured rotated quads bake color/alpha mods into the vertices — same as GPU.
- **`__sdl_render_geometry`:** each soup triple feeds `tri`. Textured geometry
  uses the texture's blend mode, untextured the renderer's draw blend mode, and
  per-vertex colors ride verbatim (mods do NOT apply) — all three rules read off
  the GPU tier so cross-tier pixels agree.

## Evidence

- **Red control** (pre-fix host.js, same test): 9 FAILURES of exactly the
  defect's shape — bbox-interior probes painted line-red, every geometry probe
  still clear-colored — while the app printed `RAS-UP fails=0` (success, wrong
  pixels). Post-fix: ALL PASS, mostly at tolerance 0.
- New `tests/kernel/test_sdl_raster_e2e.js` (registered in the kernel suite):
  1px diagonal line with untouched bbox interior + untouched immediate off-line
  neighbour; solid / indexed-textured(NEAREST) / Gouraud / renderer-BLEND
  geometry; and a 45°-rotated textured diamond proving off-axis UV gradients —
  the exact capability #672 (RenderTextureRotated) and #533 rung 3 (Asteroids)
  sit on.
- Neighbouring pinned suites green: `test_sdl_render_e2e.js` (fast-path pixels
  byte-identical), `test_sdl_util_e2e.js` (the axis-aligned polyline segments —
  note its *vertical* segment's rotated corner labels now route through the
  triangle path and still land on the same probes).

## Gotchas recorded

- The vertical-line thin quad has axis-aligned GEOMETRY but rotated corner
  LABELS (TL/TR sit on one x), so it takes the triangle path; at exact
  half-integer coordinates center-coverage and the old `Math.round` bbox differ
  by one row — pre-existing tier-vs-tier half-integer skew, unchanged for
  axis-labeled quads, now GPU-consistent for rotated ones.
- No `os/image.json` bump: host.js is runtime, fetched per-boot; baked image
  bytes are unchanged (Node-side mtime staleness just re-bakes identically).
- Rotated **textured** `__sdl_render_quad` corners have no C-level caller until
  #672 lands `SDL_RenderTextureRotated`; the path shares `tri` and mirrors the
  GPU UV mapping, and the diamond leg covers rotated texture sampling — #672's
  own acceptance test should e2e the real API end-to-end.
