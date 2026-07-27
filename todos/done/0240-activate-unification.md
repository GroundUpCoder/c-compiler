# 0240 — CD2 (big half): unify activate() launch policy (wm MRU vs fileman in-place)

- **Status**: done
- **Design**: —

## Goal

The deferred BIGGER half of the CD2 dedup (the cheap half — the shared
`os/launch.h` spawn primitive — landed as todos/0239). The launch POLICY
layer is still duplicated with drift between:

- `os/wm.c` `activate()` (todos/0066): stat → directory opens in fileman
  (0185) → runnable spawns directly with an MRU recents push
  (`sm_record_recent`, 0098) → else openwith resolution (`ow_resolve` +
  `ow_build`) in GUI context.
- `os/win32/fileman.c` `open_selected()` + `spawn_assoc()`: the same shape
  minus the MRU push, with directories navigating IN-PLACE (the fileman
  window changes cwd) instead of spawning a new fileman.

The comment pair "wm.c is the reference copy" / "fileman keeps its copy in
step" is exactly the drift risk CD2 exists to kill. Unify the shared policy
(runnable-check → spawn, openwith fallback) into one place — plausibly
`launch.h` gaining an `activate()`-shaped helper parameterized on the two
GENUINE variation points: what to do with a directory (spawn fileman vs
navigate in place) and whether to push MRU recents. Do NOT flatten those
differences — they are real product behavior, not drift.

## Plan

- Extract the common stat/runnable/openwith ladder; keep directory handling
  and recents as caller-supplied behavior (callback or flags — decide at
  implementation time against the openwith.h/fileops.h precedents).
- wm.c's `activate()` and fileman's `open_selected()` become thin callers;
  the "keeps its copy in step" comments die.

## Acceptance

- Zero behavior change: Start-menu/desktop launches still push MRU recents,
  fileman directory opens still navigate in place, openwith fallback
  identical in both. Kernel suite green + browser sweep green (os-shell,
  os-fileman legs cover both paths).
