# #672 — SDL_RenderTextureRotated (the SDL3 rotated blit)

Lane branch `lane/672-render-rotated` off `a53fb357` (#668's tip — the hard
blocker: before #668 the software tier collapsed rotated quads to their
bounding box, so shipping this name would have been present-but-wrong).

## Design

The whole function is C-side geometry over the existing 4-free-corner
primitive `__sdl_render_quad` — no new import, no new host capability:

- **angle** is degrees CLOCKWISE (SDL3's convention). In y-down screen
  coordinates the standard rotation matrix `(x·c − y·s, x·s + y·c)` IS
  clockwise for positive angles, so there is no sign fixup to remember.
- **center** is relative to dstrect's top-left; NULL means the middle.
  The pivot is applied before rotation, so a top-left pivot at 180°
  relocates the quad to the mirrored footprint — the acceptance test pins
  exactly that (the parameter most likely to be quietly dropped).
- **flip** mirrors the TEXTURE, not the geometry: upstream SDL swaps the
  source UVs on the rotated quad. Our primitive maps the src rect onto its
  corner slots in fixed TL,TR,BR,BL order, so a flip is exactly a
  permutation of which rotated corner is emitted in which slot
  (H: TL↔TR, BL↔BR; V: TL↔BL, TR↔BR; H|V composes both). This keeps flip
  orthogonal to rotation with zero extra math.

## The kickoff's "compiler.js-only" prediction was wrong — and the first
## test run proved it

First run: 10 probe failures. Every flip leg and the 180°-center leg drew
UNFLIPPED. Root cause (host.js software tier): the #668 fast-path predicate
`y0===y1 && x1===x2 && y2===y3 && x3===x0` matches axis-aligned quads by
SHAPE but not ORDER. A horizontally-flipped blit emits corners
(TR,TL,BL,BR) — axis-aligned, predicate-true, negative width — and the
scanline `quad()` samples left-to-right/top-to-bottom from the bbox, so the
mirror silently vanished. Same for exact 180° rotations (both extents
negative). 90° escaped only because its corner order breaks `y0===y1`.

Fix: the fast path now also requires canonical order (`x1 > x0 && y2 > y0`);
order-reversed quads rasterize through `tri()`, which honors slot UVs (and
normalizes winding). Contract-anchored: the primitive's documented contract
(host.js "4 dst corners TL,TR,BR,BL + a src rect" mapped per slot) gives
corner order meaning; the fast path was dropping it. Every existing emitter
goes through `__sdl_quad_rect` (canonical, positive extents) and stays
byte-identical. The GPU tier never had a fast path, so it already honored
order — the fix also removes a tier divergence: a degenerate negative-extent
rect used to draw nothing on software but normalized-draw on GPU; both now
go through triangles.

## Gotchas

- 🔴 The SDL veneer C lives in a JS **template literal** inside compiler.js:
  a backtick in a C comment terminates the string and breaks
  `require('./compiler.js')` outright. Quote identifiers with `'...'` in
  veneer comments, never backticks.
- New kernel e2es stay **untagged** in `tests/kernel/run.js` (untagged =
  assumed boot-heavy) until someone measures peak RSS — the BOOT tag is an
  assertion about a measurement (#579), not a description.

## Red controls

1. Pre-change tree (implementation stashed, test kept): the in-OS `cc`
   fails on the undeclared symbol, the window never appears, `driveBoot`
   throws on the `wmctl wait` timeout — exit 1.
2. The first live run above: 10 flip/center probe failures against a real
   defect the probes were designed to catch. Watched red before green.

Test: `tests/kernel/test_sdl_rotated_e2e.js` (kernel suite 179 → 180) —
angle 0/45/90/180, default + explicit centers, all three flip modes on
2x1/1x2/2x2 textures, NULL rects, validation legs.

Scope fence honoured: #603's other three names (SetRenderScale,
SetRenderLogicalPresentation, GetRenderOutputSize) are untouched; nothing
in this shape makes them awkward later — they compose above the same
primitive.
