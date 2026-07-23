# /bin/deck Lane 1 — format freeze, AA-gated rasterizer, nav (todos/0284)

Lane 1 of the slide-presenter build (design: the external design pass's
slide-tool doc, Option A). Delivered: `os/deck/` — the frozen `.deck` v1
format (model.h is the contract doc), the supersample-AA CPU rasterizer
(raster.h/c, pure C, no SDL/freetype — deliberately reusable as the future
litehtml container's paint layer), the fontcore text layer (text.c, the
ksvc multi-size adapter shape), and the presenter shell (deck.c: mgpp nav,
idle park, `--shot`/`--validate`/`--ss`/`--slide`). Not in this lane (Lane
2): live-reload, the on-screen error placard, seeding/openwith/image bump,
kernel e2e + browser leg.

## The AA gate (design §6 unknown #1) — 4x chosen

Ordered the work so the supersample decision was proven before anything
else: minimum rasterizer → thin-diagonal-arrow fixture at 1280x720 →
SS=1/2/4 renders + 4x zoom crops (host-clang scratch driver over
raster.c).

Verdict: **2x passes at natural size but is marginal** — a width-3 shallow
diagonal keeps a ~5-level edge that reads "ropey" under zoom and is
exactly the thing video scaling/compression makes shimmer. **4x (~17
coverage levels) is clean** and became `DECK_SS`. The cost argument: a
render happens only on nav/resize/reload (the presenter parks between
states — mgp's `SDL_WaitEventTimeout(NULL, ms)` peek idiom in the frame
callback), and a full 4x 1280x720 slide renders in well under a second
in-OS, ~75MB transient. `--ss N` keeps the A/B one flag away, for goldens
and for dropping to 2x if some future context needs it.

## Renderer shape decisions

- **Mask-then-composite, not blend-as-you-rasterize**: every fill/stroke
  rasterizes HARD 0/255 coverage into a dirty-bbox-tracked RMask, then
  composites src-over once. The stroke machinery (segment quads + round
  joint discs + arrowhead triangles + dash pieces) overlaps itself freely;
  coverage is idempotent, so translucent strokes never double-blend.
- **Flatten, don't offset**: ellipse and rounded-rect strokes flatten to
  sagitta-bounded (<=0.25 SS px) polylines and stroke each edge — constant
  stroke width by construction (the inner/outer-ellipse trick drifts thin
  on eccentric shapes).
- **Text at final size, post-downsample** (design §1.3): freetype coverage
  is already AA. Documented v1 consequence: within a slide, text (incl.
  shape labels) composites ABOVE shapes/images; order among text elements
  still follows the array. Shapes/images respect array z-order exactly.
- **Images**: bilinear + source-rect blit into the SS canvas (`fit: cover`
  is a true source crop, not a clipped overdraw); missing image = loud
  gray crossed placeholder + a load-time warning, never a silent gap.

## The dash wedge (fixed in-lane; a pattern worth remembering)

First live wedge: `wmctl resize` to 700x500 on the fixture's "arch" slide
froze deck at 100% CPU — window alive, keys dead, `[t]` stderr tracing
showed `render_slide` never returning. Root cause: the dash walker
accumulated a raw float `phase` and computed `run = don - fmodf(phase,
cycle)`; at that exact fit scale the residual fell below one ulp of the
accumulators, so `t += run` stopped advancing — an infinite loop that only
exists at specific window sizes (1280x720 and 960x540 rendered the same
slide fine). Fix: keep the dash position bounded in [0, cycle) with exact
boundary snapping (`p = don` / `p = 0`), plus an epsilon loop guard.
Pattern: **any float walk that accumulates distance must keep its
accumulators small or snap to exact boundaries** — "it terminated at three
window sizes" proves nothing.

## Validation contract (what Lane 2 renders on the placard)

- Hard errors (malformed JSON / missing required field / unknown type /
  bad geometry) → structured `DeckErr` {msg, where = "slide 'x' element
  'y'", byte offset for parse errors}, load fails, exit 1.
- Unknown keys anywhere, bad style values, duplicate ids, missing image
  files → collected `DeckWarn`s, defaults applied, deck loads. Surfaced on
  stderr and via `deck --validate` (prints "deck: OK: N slides, M
  warnings").
- First error wins (agents fix one at a time); warnings collected before
  the error still hand out.

Verified in-OS via the menubox inject pattern (buildProject → write into
the root volume → driveBoot): parse error carries the byte offset,
structural errors carry the element context, the fixture validates clean,
all three slides `--shot` to PNG, and the present-mode smoke drives
window/nav/resize/quit through wmctl (Right re-renders, resize re-fits
with letterbox bars, `q` exits). `wmctl shot` needs an explicit SID — SID
0 (focused) returns EINVAL for shots.
