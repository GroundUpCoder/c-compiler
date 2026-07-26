# 0294 — Window resize: west / north / NW / NE / SW moving edges (kernel hit test + wm policy)

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27 (finding #7).

## Goal

Implement moving-edge window resize. Today only E, S and SE exist.

`kernel.js:1075-1077`:

```js
 * Resize drag zones on the frame: right edge -> E, bottom edge -> S, within
 * WM_GRIP of the bottom-right corner -> SE (left/top edges just focus —
 * moving-edge resizes are deliberately not in this version).
```

**Verified at `847dc057`:** `kernel.js:5388-5392` computes `ex` from `x >= s.x + dw` and `ey`
from `y >= s.y + dh` **only**. No west or north zone exists anywhere in the codebase.

A "moving edge" resize is the harder case because the window's origin moves as it resizes — it
is a kernel hit-test change **plus** a wm policy decision about how origin and size change
together, not just three more drag zones.

## Why nothing scheduled it

No ticket mentions moving-edge resize. #4 / `todos/0064` is a **WM bug sweep**, not this. And
*"deliberately not in this version"* has had **no subsequent version** — the phrasing makes an
absent feature read as *staged*, which is why it never got refiled. (Compare `0300`, the same
shape in `wm.c`.)

## Plan

- Kernel: add W / N / NW / NE / SW drag zones to the frame hit test, mirroring the existing
  E/S/SE zone logic and `WM_GRIP` corner sizing.
- wm: define the policy for origin-moves-with-size, including interaction with minimum window
  size (dragging a west edge past the min width must pin the edge, not teleport the window) and
  with snap/maximize state.
- Cursor feedback for the new zones, consistent with the existing ones.

## Acceptance

- All eight resize zones work: E, S, SE **and** W, N, NW, NE, SW.
- Dragging a west or north edge moves the origin and changes the size in one gesture, with no
  visual jump at the minimum-size boundary.
- Correct resize cursors on all eight zones.
- `kernel.js:1075-1077`'s comment updated to describe what exists.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
