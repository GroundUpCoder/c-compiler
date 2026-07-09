# 0035 — spawn-capable applets: find, xargs, awk, tar/gzip, less, diff

- **Status**: done (2026-07-09) — dev log `logs/2026-07-09/spawn-applets.md`.
  All six targets landed (find -exec/xargs/awk/tar+gzip/less/diff, plus
  gunzip/zcat); the multicall links the shim (spawn_helpers.c replaces
  vfork_daemon_rexec.c) and `env cmd` execs for real via the new
  bare-exec emulation in pv_execve. tar -z works in BOTH directions (no
  need for the documented piped fallback). Surfaced: the
  switch-decl-before-first-case codegen bug
  (`tests/unit/conformance/switch_decl_before_case`, fixed test-first)
  and libc `sched.h`/`sched_yield` (less). patch/ed deliberately left
  for 0050's orbit. Acceptance legs: test_os_boot.js "batch 3" session +
  the less-in-term pty leg in test_term_e2e.js. Image v30.
- **Depends**: 0034 (soft — shares the vendoring mechanics, not blocking)
- **Design**: `vendor/busybox/README.md` (the vfork-on-__spawn shim),
  `todos/OS.md` (spawn model)

## Goal

The high-value applets that DO spawn or need heavier porting:

- `find` (with `-exec`) + `xargs` — the pair that makes the shell feel
  complete
- `awk` — biggest single win; `cmd | getline` and `system()` go through
  popen → spawn
- `tar` + `gzip`/`gunzip` — gzip is self-contained; tar's seamless-.gz
  path on NOMMU re-execs → the shim
- `less` — pure tty work (vi already proved read_key/termios/winsize)
- `diff` (+ maybe `patch`, `ed`) — file-only, medium

## Plan

- **The key unlock**: drop `-DPV_NO_INTERCEPT` from the coreutils build
  and link `port/vfork_spawn.c` — the multicall binary gains the same
  journaling-vfork machinery hush uses. Applets that never spawn are
  unaffected (the intercept macros only bite inside `pv` child mode).
  Verify the 0010 assumption holds nowhere else (grep for
  `PV_NO_INTERCEPT` uses).
- busybox's NOEXEC/spawn helpers in libbb may need the same guarded-out
  treatment as `xfuncs_printf.c` got, or real implementations over the
  shim — decide per call site.
- awk can land first with `getline`-from-cmd/`system()` exercised last —
  the interpreter core is self-contained.
- tar: uncompressed + `-z` via the shim's re-exec path; if that fights,
  ship `tar` + standalone `gzip` and pipe (`tar cf - | gzip`) as the
  documented form first.
- `less` follows the vi porting recipe (sigsetjmp form, elvis `?:`
  rewrites — check for the same GNUisms).
- Expect libc/kernel gaps like every prior round — log them.

## Acceptance

- `find /etc -name '*.ttf' -exec wc -c {} ;` and
  `ls /bin | xargs -n1 basename` through boot.js.
- An awk program with a pipe (`ls -l | awk '{print $NF}'`) and one
  `system()` call.
- tar roundtrip (`tar czf /tmp/x.tgz /etc && tar xzf ...` or the piped
  form) with content compare.
- less driven through the pty tests (vi precedent in `test_term_e2e.js`).
