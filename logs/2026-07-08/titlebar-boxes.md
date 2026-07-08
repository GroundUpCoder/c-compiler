# 0030 — title-bar minimize/maximize boxes

Landed `todos/0030`: Win95-order [min][max][close] boxes in the kernel
title bar, close-box metrics (16px, `WM_BOX_GAP` 2). The 0025 mechanism/
policy split held exactly: the **min box calls `wmMinimize` directly**
(kernel mechanism — works with no WM, focus-fall included); the **max box
emits EV_TITLE_ACTIVATE** (no new event — box, title double-click, and
`wmctl max` are indistinguishable to /bin/wm; without a subscriber it's
the same no-op as `wmctl max`'s R_ERR). No wm.c change, no image bump —
chrome is kernel-drawn.

## Decisions / findings

- **Fit-gating** (found by the existing tests, not anticipated): at
  `WM_MIN_SIZE` (32px) the min/max boxes would extend past the title's
  LEFT edge — hit zones covering the whole title (undraggable window) and
  composite boxes drawn over the frame/desktop. Rule: each box exists
  only if it fits fully inside the title (`x0 >= s.x`), same gate in the
  hit test and BOTH composites. A 32px window keeps close-only; the
  existing "window drags while unlocked" leg (title click at +5 on a
  32px window) is the regression proof — it hit the would-be max box
  before gating.
- Box clicks behave like the close box: no focus, no drag, no
  double-click-timer arming (they return before all three).
- The headless composite grew deterministic flat-rect GLYPHS (min bar,
  max hollow box) — unlike title text, rects are deterministic, and three
  identical face-colored boxes would be indistinguishable to pixel
  asserts. The browser compositor draws the same rects (close keeps its
  text 'x' there).
- Hit zones are dstW-relative (the 0024 dst rect), like the close box.
- One pre-0030 test click moved: the "quick pair outside the slop"
  double-click leg clicked (x+30, y-10) on a 64px window — that spot IS
  the max box now (boxes span x+8..x+60 there); moved to x+0.

## Tests

- `test_wm.js`: max box no-WM no-op (no drag, no events), min box
  minimizes + focus falls, dst-rect box offsets on the scaled surface,
  composite three faces + glyph pixels at the hit-test offsets.
- `test_wm_policy.js`: max box → EV_TITLE_ACTIVATE to the subscriber
  (the one policy path), min box → EV_MINIMIZED + focus-fall events.
- `os-wm.mjs`: box faces composited, min box → window gone/in taskbar/
  restorable, max box → work-area fill → second click restores the saved
  geometry (via the maximized-position box).
