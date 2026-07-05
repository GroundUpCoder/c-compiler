# 0005 — shell port: busybox ash (+ coreutils)

- **Status**: queued
- **Depends**: 0001–0004
- **Design**: `todos/OS.md` (Phase 1); `todos/KERNEL.md` (phase 5 acceptance)

## Goal

A real `/bin/sh` (busybox ash, leaning busybox for the coreutils dividend —
see OS.md open questions) with fork points patched to the spawn model.
This is the kernel design's acceptance test: "if the shell needs a kernel
workaround, the kernel design was wrong." Unlocks the already-written
`popen()`/`system()`.

## Plan sketch

- vendor busybox (ash + a starter set of applets: ls cat cp mv rm mkdir
  echo grep sed head tail wc); bin.json like other vendor ports.
- Patch fork/exec idioms: plain commands → posix_spawnp; subshells/`$()` →
  spawn the shell binary with `-c`; document each patch site.
- Pipelines via 0003's pipes; job control via 0003's stop/cont; interactive
  editing via 0002's tty.

## Acceptance

- In the os/ page: pipelines, redirections, `$( )`, Ctrl-C on a foreground
  job, `fg`/`bg`, exit-status propagation; `system()`/`popen()` unit tests
  un-skip.
