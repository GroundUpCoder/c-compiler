# 0018 — quake windowed: relative mouse + pointer lock

- **Status**: DONE 2026-07-08 (dev log `logs/2026-07-08/quake-relative-mouse.md`;
  WM.md "Implementation status — relative mouse / quake")
- **Depends**: 0015 (binary-asset seeding, vendor-app pattern); 0017
  (nice-to-have — quake with sound)
- **Design**: `todos/WM.md` ("Input routing" — relative-mouse as a surface
  flag; `SURFACE_SET_FLAGS` in the surface protocol)

## Goal

Quake needs mouse look; the relative-mouse surface flag is designed in
WM.md but did not land in v1 (verified: no pointer-lock/relative path in
host.js/kernel.js/os/).

- `SURFACE_SET_FLAGS` relative-mouse: the flag round-trips kernel →
  compositor → os.html pointer lock on the desktop canvas; the input ring
  carries relative deltas while locked; define unlock semantics (ESC /
  focus loss).
- Seed `/bin/quake` + `pak0.pak` (~18MB) + `autoexec.cfg` via 0015's asset
  entries — a real size test for seed-time BlockFS writes.
- Headless: injected relative motion reaches the app (grow the agent
  channel a relative-pointer inject if the absolute one doesn't map).

## Acceptance

- quake in-OS: click into the window locks the pointer, mouse look works,
  unlock releases; window remains draggable/closable when unlocked.
- Kernel test drives the flag + relative deltas headless; existing suites
  green.
