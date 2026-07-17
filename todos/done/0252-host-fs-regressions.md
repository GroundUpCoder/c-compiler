# 0252 — host createFileSystem regressions: zero-length pipe read deadlock + O_APPEND committed-write-reported-failed

- **Status**: done
- **Design**: —

## Goal

Fix two HIGH regressions an adversarial review found in the 0233 fail-loud
cleanup, both in host.js's `createFileSystem` (the native-fs flavor):

- **R1 (regression on CD5, ae775da)**: the pipe read's blocking loop parks a
  `read(fd, buf, 0)` on an EMPTY pipe with a LIVE writer — POSIX requires a
  zero-length read to return 0 immediately (a common feature-probe pattern).
  The `readImpl` stdin path has the same gap (parks on `stdinWaiters`).
- **R2 (regression on CD4, a80949d)**: the O_APPEND write's post-commit EOF
  resync (`fstatSync` after a successful `writeSync`) routes its throw to the
  outer catch → the COMMITTED write is reported as -1. The caller retries and
  the data is appended twice.

## Plan

- R1: `count === 0` early-return 0 at the top of the pipe branch and of
  `readImpl` (covers stdin + both file paths; fix the class, not the line).
- R2: keep the committed `n`; mark `entry.positionUnknown` and gate EVERY
  consumer of `entry.position` (positioned read, positioned write, SEEK_CUR)
  on an `ensurePosition` helper that lazily re-fstats (self-heal) or fails
  loud with the fstat errno — never a silently stale offset. Don't reuse the
  `position === null` "not seekable" sentinel (would flip a regular file to
  ESPIPE/unpositioned semantics).
- Audit the sibling sites: open-time append fstat (fails the open before any
  commit — correct), positioned write (throw = no commit reported — correct),
  SEEK_END fstat (no commit involved), BlockFS append write (synchronous
  `ino.dataSize`, no post-commit stat — no equivalent shape).
- Kernel-brokered zero-length reads (`_streamRead` / tty FS_READ park on
  count 0 too) are the same R1 class but kernel.js — split out to their own
  item, out of this one's scope.

## Acceptance

- `tests/host/test_pipe_read_block.js` grows the zero-length legs (empty pipe
  + live writer returns 0 immediately; non-empty pipe returns 0 and leaves the
  data; stdin returns 0), red pre-fix (HUNG), green post-fix; the CD5
  blocking legs keep passing.
- `tests/host/test_append_fstat_fail.js` asserts the new invariant: committed
  write returns n despite a failed resync (pre-fix -1), SEEK_CUR/positioned
  read with the broken position fail loud with the fstat errno (pre-fix stale
  offset), and both resync (self-heal) once fstat recovers.
- unit + host + blockfs + kernel green. No image/os-C/codegen change.
