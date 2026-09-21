# 0239 — CD2: launch.h — dedup the wm/fileman spawn primitive

- **Status**: done (2026-07-17 — os/launch.h landed, wm/fileman copies
  deleted, term.c env literals de-duped; image v109; kernel 75/0, sweep
  27/27; the activate() policy half stays open as todos/0240; dev log:
  logs/2026-07-17/cd2-launch-dedup.md)
- **Design**: —

## Goal

Scrub follow-up (CD2): `os/wm.c` `spawn_path()`/`reap_kids()` and
`os/win32/fileman.c`'s verbatim copies ("wm.c is the reference copy" /
"fileman keeps its copy in step") were a duplication-with-drift pair — they
differed only in the kid-counter symbol (`nkids` vs `g_nkids`) and the stderr
prefix ("wm:" vs "fileman:"), and the
`{"PATH=/usr/local/bin:/bin","HOME=/root"}` envp literal was re-typed a third
time in `os/term/term.c` (there a superset adding TERM).

This item is the CHEAP half of CD2: consolidate the low-level spawn
PRIMITIVE into one header-only `os/launch.h` (the openwith.h idiom — static
functions shared by textual inclusion, since manifest `c` entries are
single-source compiles):

- `LAUNCH_ENV_PATH` / `LAUNCH_ENV_HOME` — the canonical desktop env strings,
  typed once. wm.c/fileman.c use them via `spawn_path`; term.c references
  them for its pty session-leader envp instead of re-typing the literals.
- `spawn_path(path, argv, int *nkids, const char *who)` — the shared
  own-pgroup posix_spawn, taking the caller's kid counter by pointer and a
  diagnostic prefix, byte-for-byte the old behavior at every call site.
- `reap_kids(int *nkids)` — the shared WNOHANG drain.

Deliberately NOT merged (legitimately different spawn shapes, not drift):
term.c's pty session-leader spawn (file actions + posix_spawnp),
protoshell.c/open.c/strace.c (env-inheriting spawns — they never typed the
env literals at all, so only wm/fileman/term reference launch.h).

Launch POLICY is untouched: `activate()` stays in wm.c and fileman keeps its
in-place open flavor — unifying those is the BIGGER half of CD2, tracked
open as todos/0240.

## Plan

- New `os/launch.h`; wm.c/fileman.c include it, local copies deleted, call
  sites pass (`&nkids`, "wm") / (`&g_nkids`, "fileman"); term.c envp uses the
  macros. image.json: wm `hdrs` += launch.h, version 108 → 109.

## Acceptance

- Pure refactor, zero behavior change: image rebakes, kernel suite green,
  browser sweep 27/27 (desktop dbl-click / Start menu / fileman Open /
  ctlpanel launches identical).
