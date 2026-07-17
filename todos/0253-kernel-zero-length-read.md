# 0253 — kernel-brokered zero-length reads park: _streamRead / tty FS_READ ignore count===0

- **Status**: open
- **Design**: —

## Goal

The 0252 R1 class (a `read(fd, buf, 0)` must return 0 immediately, never
block) also exists in the kernel-brokered path, found during the 0252 scrub
but out of that item's host.js-only scope:

- `kernel.js _streamRead` (pipes / sockets / pty master): an empty stream
  with a live writer parks the pcb as a `piperead` waiter even for count 0
  (`kernel.js:5350` — the avail check is `avail > 0`, so count 0 falls
  through to the park).
- The tty branch of `FS_READ` (`kernel.js:~2844`): no cooked bytes → parks a
  `ttyread` waiter regardless of count.

A brokered process doing a POSIX feature-probe `read(fd, buf, 0)` on an
empty pipe/tty hangs until unrelated input arrives. (Whether libc or
RemoteFS should also short-circuit count===0 before issuing the RPC is part
of the design call — an early return process-side would avoid the RPC
entirely, but the kernel should be correct regardless of client.)

## Plan

- Early-return an empty payload for `count === 0` in `_streamRead` and the
  tty `FS_READ` branch (before SIGTTIN? — decide: POSIX says a zero-length
  read "may" detect errors; returning 0 before job-control checks is the
  simple conforming choice, but match Linux behavior).
- Consider a RemoteFS-side `count === 0` short-circuit as well (zero RPCs).
- Red→green: a fake-worker kernel test (tests/kernel/test_pipes.js /
  test_tty.js style) proving a count-0 FS_READ on an empty pipe and tty
  responds immediately instead of deferring.

## Acceptance

- Zero-length brokered reads on empty pipe / socket / pty master / tty
  return 0 immediately with a live writer; count>0 blocking semantics
  unchanged. Kernel suite green.
