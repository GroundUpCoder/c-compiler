# 0115 — More screensavers — Mystify + 3D pipes

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WM.md` "Implementation status — screensaver"
  (todos/done/0096 — the framework this extends)

## Goal

The 0096 screensaver framework shipped with two classics (marquee,
starfield) and deliberately deferred the other two icons: **Mystify**
(bouncing polyline trails) and **3D Pipes** (the CPU-2D rendition —
GPU/3D savers stay a recorded 0096 non-goal). Additive fun, zero new
mechanism.

## Plan

- Each saver is one more self-contained draw routine in `os/wm.c`
  (`draw_saver` dispatch) + a name the `saver` config key accepts
  (os/saver.h documents the store; no format change — unknown names
  already fall back safely).
- Mystify: 2 polylines x 4-5 vertices bouncing off screen edges, a
  short fading trail per line (redraw-everything-per-frame makes the
  trail just a ring buffer of old vertex sets).
- Pipes: orthogonal 2D pipe runs on a coarse grid — pick a heading,
  extend, elbow at random, restart when boxed in; a handful of
  simultaneous pipes in distinct colors, screen clears when full.
- ctlpanel Screen Saver applet: two more radios (the 0096 radio row —
  ids/order follow SV_RADIO).
- Tests: extend `tests/kernel/test_saver_e2e.js` — config each name,
  `wmctl saver`, assert raise + two shots differ (the animation probe
  is saver-agnostic); the 0064 saver-eyeball operator check covers the
  look.

## Acceptance

- `saver mystify` and `saver pipes` raise via idle and `wmctl saver`,
  animate (shots differ), and dismiss on input — the 0096 semantics
  unchanged.
- The applet lists and applies all four savers.
