# 0425 — netsurf demo visual upgrade

- **Status**: open
- **Design**: —

## Goal

jku opened the paint demo, clicked the buttons, and saw no visual effect.
The engine was correct. The demo was not. A click painted one 10px dot on
a white 240x160 pad. The page showed nothing at load. The layout put an
unlabelled white rectangle first and left 225px of white space at the
bottom.

Make the demos show the engine. A user who opens a page and does nothing
must see real graphics. A user who clicks once must see a substantial
change.

## Plan

1. Rework `paint/`: a 512x512 pad, a generated sunset scene at load, a
   paint splat on each click, a thick continuous stroke on each drag.
   The page carries its own rasteriser (gradients, circles, thick lines,
   ridge fills) over one `ImageData` buffer. The controls move to a rail
   on the right of the pad, so the page fills an 800x600 window.
2. Keep the pad pinned to the document origin. The engine has no
   `getBoundingClientRect`, so the pin is what makes a page coordinate a
   canvas pixel. The scene at load gives the pad its visible affordance.
3. Add `plasma/`: an animated demoscene plasma at 320x200 with four
   palettes. It animates at load with no interaction. A click switches
   the palette.
4. Enlarge the `sketch/` canvas from 128x96 to 256x192.
5. Audit the other five demos and record the judgement.
6. Update `demos.js` INTERACTIONS, the smoke-js legs, the landing page,
   and the README. Bump the `netsurf-demos` package to version 3.

## Acceptance

- The paint pad shows the scene at load. One click stamps a full splat.
- Plasma animates at load. The measured frame rate is stated honestly.
- No rasterised pixel enters the load-check pill's red or green band.
- All demo gates pass: the demos contract, smoke-js, the kernel demos
  e2e, and the interaction table on real screenshots.
- Screenshots of the new pages exist as PNGs for the router.
