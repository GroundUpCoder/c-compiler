# 0031 — taskbar polish: clock, stable order, overflow

- **Status**: open
- **Depends**: 0028 (button layout shifts for the Start button; do the
  polish on the post-0028 layout)
- **Design**: `todos/WM.md` "The desktop shell" (taskbar-polish block)

## Goal

Three small Win95-feel fixes, all wm.c-local.

## Plan

- **Clock**: right-aligned HH.MM (`time()` + the 5×7 font — it has
  digits and `.`), redrawn on the minute from the frame tick.
- **Stable button order**: `wins[i] = wins[--nwins]` swap-remove
  (wm.c ~293) reshuffles buttons on any close — preserve launch order
  (memmove compaction; wins[] is 64 entries, cost is nothing).
- **Overflow**: once buttons would run past the clock, shrink button
  width to fit (Win95 behavior) instead of drawing off the surface.
- Image version bump (wm.c is seeded).

## Acceptance

- `test_wm_policy.js` legs: close a middle window → remaining button
  order preserved (shot pixel-diff on label columns or model asserts);
  N windows → buttons all land left of the clock.
- Clock digits present in a taskbar shot (histogram over the clock cell).
