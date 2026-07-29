# 0425 — the demos must show the engine

Lane: `paint-demo-upgrade`. Origin: jku clicked the paint demo's buttons
and saw no visual effect. The bug-hunt lane proved the engine correct.
The demo was the defect: a blank white pad at load, one 10px dot per
click, and 225px of dead space at the bottom of the page.

## What changed

**paint/** is rebuilt. The pad is 512x512. It opens with a generated
sunset scene: gradient sky, stars, a banded sun, two mountain ridges, a
broken sun reflection on the water, a headland, and birds. A click
stamps a paint splat with satellite droplets. A drag paints a thick
continuous stroke — each mousemove draws a round-capped line from the
previous point, so sparse events still make one stroke. A Scene button
repaints the picture. The controls sit in a rail on the right of the
pad, so the page fills an 800x600 netsurf window.

The scene needs drawing primitives and canvas 2D has none here (Lane D,
todos/0290). So paint.js carries a small rasteriser over one ImageData
buffer: rect fill, vertical gradient, filled circle, thick line, and a
per-column ridge fill. The splats and strokes use the same calls.

**plasma/** is new — the headline demo. A 320x200 demoscene plasma
animates from setInterval alone, with four palettes and click-to-switch.
Its purpose is product, not engine coverage: a user who opens one page
and touches nothing must see real-time graphics.

**sketch/** grows from 128x96 to 256x192. Pattern 0 computed
`g = (y*2) & 0xff`, which wrapped at row 128 on the taller canvas and
drew a static seam; it now scales without a wrap.

The other five demos pass the same look-at-it-as-a-user test without
change. Stopwatch animates at load. Counter, events and todo respond
visibly to the first click. Hello-js demonstrates text, and shows its
computed output at load. Only paint had the full defect: nothing at
load, no visible affordance, and interaction-only visuals.

## The pin stays; the DOM order stays

The pad keeps `position:absolute; top:0; left:0`. The engine has no
`getBoundingClientRect` and no `offsetLeft`, so the pin is the only
thing that makes a page coordinate equal a canvas pixel. "Title first,
canvas second" is therefore NOT delivered — the scene at load is the
affordance instead. The router promised jku that order by email; that
promise needs a walk-back.

## Measurements (duktape in the monkey frontend, this machine)

- Flat 512x512 ImageData fill: ~0.22 s. Per-pixel arithmetic fill:
  ~0.36 s. Row-precomputed fill: ~0.29 s.
- `putImageData` of a full 512x512 buffer: under 10 ms — the blit is
  native; the JS fill is the cost.
- The paint scene draws in ~0.18 s at load (`paint scene start` to
  `paint scene drawn`). The in-OS status bar shows "Done (0.3s)" for
  the whole page load.
- Plasma: ~130 ms per 320x200 frame after two optimisations (per-frame
  1-D term arrays; flat palette channel arrays — the array-of-triples
  palette cost ~60% more). Measured rate: **5.3 fps** over a 3 s
  window. smoke-js leg 12 measures and prints this on every run.
- A Mandelbrot explorer was considered and rejected: ~800k iterations/s
  in duktape puts a 512x384 render at ~5 s per click. Too slow to feel
  rewarding; the plasma shows more per second of user attention.

## Pill safety

The demos e2e counts the load-check pill's red/green over the whole
window. Every rasterised colour must stay out of both bands. paint.js
states the rule and its palette obeys it; plasma.js clamps every
palette entry in buildPalette; the render probes assert zero band
pixels over the scene, the marked scene, and all four palettes.

## Calibration gotcha

The monkey frontend's font metrics differ from the in-OS build, so
PLOT TEXT positions from the monkey must not calibrate INTERACTIONS
coordinates. Counter's known-good coordinates proved it: the monkey
plots "Reset" at x=421; the in-OS truth is ~x=360. The new coordinates
were calibrated from real in-OS `wmctl shot` screenshots.
