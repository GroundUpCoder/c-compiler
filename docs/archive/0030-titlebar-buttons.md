# 0030 — title-bar minimize/maximize boxes

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/titlebar-boxes.md`)
- **Depends**: —
- **Design**: `todos/WM.md` "The desktop shell" (title-bar-buttons
  block); mechanism/policy split per done/0025

## Goal

The title bar today has exactly one button — the close box
(kernel.js `WM_CLOSE_*`). Add minimize and maximize boxes left of it,
Win95 order [min][max][close], same 16px metrics.

## Plan

- kernel.js: two more hit zones in `wmPointer`'s title branch.
  **Minimize box → `wmMinimize` directly** (kernel-implemented, works
  with no WM — minimize is already kernel mechanism, focus-fall included).
  **Maximize box → EV_TITLE_ACTIVATE** (the 0025 double-click event;
  wm.c's toggle handles it unchanged; no WM → the same R_ERR/no-op as
  `wmctl max`).
- Drawing in both flavors: `os/compositor.js` and the headless composite
  (kernel.js) — flat-rect glyphs (bar / hollow box / ×-ish) in the
  existing chrome style; export the new metrics beside `WM_CLOSE_W`.
- No wm.c change, no image bump (chrome is kernel-drawn).

## Acceptance

- `test_wm.js`: min-box click minimizes without a WM (and focus falls);
  max-box click with a subscriber emits EV_TITLE_ACTIVATE (and the
  policy toggle round-trips via `test_wm_policy.js`); without one it's a
  no-op; boxes don't exist on borderless surfaces; hit zones respect the
  0024 dst rect.
- Headless composite: box pixels present at the expected offsets.
- Browser (`os-wm.mjs` legs): click min → window gone from screen, in
  taskbar; click max on winbox → work-area fill; on fixbox → scale-to-fit.
