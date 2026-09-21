# 0238 — os-wm.mjs keyboard-Move leg: instant sample races the post-move composite (33% flake)

- **Status**: done (2026-07-17 — marker-wait fix; os-wm stable 3/3 plain AND
  3/3 --under-load; full sweep 27/27; dev log:
  logs/2026-07-17/os-fail-loud-gaps.md)
- **Design**: —

## Goal

Found while gating todos/0237: `os-wm.mjs` failed its "keyboard Move relocated
C (+40,+16)" leg once in the full sweep and flaked 2/3 under
`--repeat 3` — reproduced identically at origin/main with the v107 image, so
pre-existing, not a product regression.

Root cause (the 0171 anti-pattern, test-side): the leg's "move committed"
gate — `waitPixel(CX+240, CY+116, GREEN)` — samples a point inside C's
PRE-move footprint (C at (96,108) is ~300 wide), so it is satisfied before
the move even composites; the following move proof is an INSTANT
`sample(CX+5, CY+5)` expecting B's orange under C's vacated corner, which
races the frame. The failure prints the second (diagnostic) sample — exactly
ORANGE — because the composite landed between the two samples.

## Plan

Replace the pre-satisfiable waitPixel + instant sample with one true marker
wait: `waitPixel(CX+5, CY+5, ORANGE)` — B's orange appearing at C's old
corner IS the post-move composite.

## Acceptance

- `node tests/browser/os-sweep.mjs --repeat 3 --filter=os-wm` — no FLAKY verdict.
