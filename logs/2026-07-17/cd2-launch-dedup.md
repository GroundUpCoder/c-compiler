# CD2 dedup, cheap half: os/launch.h — the ONE spawn primitive (todos/0239)

The scrub's CD2 finding: `spawn_path()`/`reap_kids()` existed as a verbatim
duplication-with-drift pair — `os/wm.c` the self-declared "reference copy",
`os/win32/fileman.c` "keeping its copy in step", differing only in the kid
counter symbol (`nkids` vs `g_nkids`) and the stderr prefix — and the
`PATH=/usr/local/bin:/bin` / `HOME=/root` envp literal was typed a third time
in `os/term/term.c`. Untracked, too: no todos/ item existed.

## What landed

`os/launch.h`, header-only in the openwith.h idiom (manifest `c` entries are
single-source compiles, so shared static functions by textual inclusion is
the right shape here):

- `LAUNCH_ENV_PATH` / `LAUNCH_ENV_HOME` — the canonical desktop env strings,
  typed exactly once.
- `spawn_path(path, argv, int *nkids, const char *who)` — the own-pgroup
  posix_spawn, generalized ONLY over the two axes the copies actually drifted
  on: the caller's kid counter (by pointer) and the diagnostic prefix.
- `reap_kids(int *nkids)` — the WNOHANG drain against the caller's counter.

wm.c and fileman.c include it and lost their local copies (8 + 3 call sites
rewired, passing `&nkids`/"wm" and `&g_nkids`/"fileman"); term.c's pty
session-leader envp now spells its PATH/HOME via the macros (its TERM entry
and spawn shape stay its own). image.json: wm's `hdrs` grew `launch.h`,
version 108 → 109.

## What deliberately did NOT move

- **Launch policy.** `activate()` (MRU recents, openwith resolution,
  dir-opens-in-fileman) stays in wm.c; fileman keeps its in-place flavor.
  That unification is the BIGGER half of CD2, now tracked open as
  todos/0240 — the primitive moved, the policy didn't.
- **The other spawn sites.** term.c (posix_spawn_file_actions pty leader),
  protoshell.c / open.c (env-INHERITING spawns — they never typed the env
  literals at all, contrary to the scrub note; verified by grep), strace.c
  (execvp-style resolution): legitimately different shapes, not drift.
  Force-merging them into spawn_path would have been the opposite failure.
- boot.js / kernel-worker.js type the same strings for pid-1's envp — that's
  the JS side of the boundary; a C header can't serve them, and two JS
  embedder twins already deliberately mirror each other. Left as is.

## Gate (pure refactor — zero behavior change claimed and verified)

- mkimage: v109, sealed, clean bake.
- Kernel suite: 75 passed / 0 failed.
- Browser sweep: 27 passed / 0 failed (desktop dbl-click, Start menu,
  fileman Open, ctlpanel launches all exercised).
