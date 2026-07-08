# DOOM presents 640×400 raw — the 0024 payoff lands (todos/0027)

The doomgeneric port carried a `WINDOW_SCALE 2` CPU pre-scale from its
emscripten origins: every frame, a 2×2 duplication loop wrote 1280×800×4
bytes so the window wouldn't be a postage stamp. That was the only way
to be bigger than your buffer before todos/0024 gave every fixed-size
surface a compositor-side dst rect.

Now the window is created at native `DOOMGENERIC_RESX×RESY` (640×400)
and `DG_DrawFrame` is a straight RGBA copy — ~4× fewer pixel writes per
frame, and scaling is the compositor's nearest-neighbor job (frame-edge
drag → wm.c aspect-fit, `wmctl scale`, 0025 maximize scale-to-fit).

## Consequences worth noting

- **The window now fits the desktop.** Pre-change, DOOM's 1280×800
  overflowed the classic 800×500 screen by design (close box clipped
  off-screen — the reason os-doom.mjs quits via `wmctl close`). Tests
  that sampled "the visible clipped region" now sample the native
  client: `DOOM_REGION` shrank to `[16,40,648,432]` in **both**
  os-doom.mjs and os-vt.mjs (the latter's mid-app leg would have failed
  its `nonTeal > 0.9n` predicate with ~20% desktop teal in the old
  region).
- `test_os_apps_e2e.js`: window row + PPM shot asserts 1280×800 →
  640×400. The three-PPM `maxBuffer` comment drops from ≈5.9MB to
  ≈1.6MB (doom's shot is now 768KB).
- **image.json v19 → v20** — main.c is compiled at seed time, so
  existing OPFS images must re-seed to pick it up.
- Default on-screen size is smaller than before (640×400 vs 1280×800).
  Deliberate: the user scales/maximizes to taste; the app no longer
  hardcodes a presentation choice. If a "spawn maximized" nicety is ever
  wanted, that's wm.c policy, not vendor source.
