# 0027 — DOOM presents 640×400 raw (drop the CPU pre-scale)

- **Status**: done (2026-07-08; dev log
  `logs/2026-07-08/doom-native-present.md`)
- **Depends**: 0024 (viewport scaling — the mechanism that made the
  pre-scale redundant)
- **Design**: `todos/done/0024-viewport-scaling.md` (goal section: "DOOM
  then fits the screen with zero source changes — its `WINDOW_SCALE 2`
  CPU pre-scale becomes redundant — present 640×400 raw")

## Goal

`vendor/doom/src/main.c` doubled every frame on the CPU (`WINDOW_SCALE
2` → a 1280×800 window) because pre-0024 windows had no other way to be
bigger than their buffer. With per-surface dst scaling landed, present
at native 640×400 and let the compositor scale: frame-edge drags,
`wmctl scale`, and maximize (0025 scale-to-fit) all work on it.

## Done

- `DG_Init` creates the window at `DOOMGENERIC_RESX×DOOMGENERIC_RESY`;
  `DG_DrawFrame` is a straight RGBA copy (no 2×2 duplication loop —
  ~4× less pixel writing per frame).
- image.json → **v20** (seeded vendor source changed).
- Tests updated: `test_os_apps_e2e.js` (window + shot now 640×400),
  `os-doom.mjs` / `os-vt.mjs` (sample region shrunk to the native
  client; the window no longer overflows the desktop), browser README.
