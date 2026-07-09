# 0044 — interval timers: alarm/setitimer(ITIMER_REAL) → SIGALRM

- **Status**: done (2026-07-09) — ONE kernel-side ITIMER_REAL per process
  (OP.SETITIMER/GETITIMER 0x000B/0x000C, ms wire ABI) firing SIGALRM
  through `_deliver` (DFL-terminate/EINTR/pending-while-stopped for
  free); libc setitimer/getitimer in <sys/time.h>, alarm/ualarm facades
  in <unistd.h> (__signal.c; ENOSYS stubs without a kernel);
  VIRTUAL/PROF → EINVAL by design; image v33 (libc rebake); tests
  `test_kernel.js` itimer section + `tests/kernel/test_itimer_e2e.js`;
  dev log `logs/2026-07-09/interval-timers.md`
- **Depends**: —
- **Design**: `todos/KERNEL.md` (signals, 0001)

## Goal

`alarm()` and `setitimer`/`getitimer(ITIMER_REAL)` delivering SIGALRM
through the existing SIGPEND path — pure kernel-side bookkeeping on
machinery that already exists.

## Plan

- One kernel-side real-time timer per process; expiry posts the SIGALRM
  SIGPEND bit; `it_interval` reloads. `alarm()` is a facade over it
  (returns seconds remaining); `ualarm` too. Cleared at exit.
- `ITIMER_VIRTUAL`/`ITIMER_PROF` → `EINVAL` (no CPU accounting) —
  documented, fail loud.
- libc: `<sys/time.h>` setitimer/getitimer; alarm/ualarm in
  `<unistd.h>`.
- Delivery is cooperative like all signals (safe points, 0001): a
  pure-compute loop observes SIGALRM only at its next safe point —
  recorded, consistent with the settled signal design.

## Acceptance

- The classic timeout idiom: `alarm(1)` interrupts a blocking pipe/tty
  read with `EINTR` (compiled-C e2e in tests/kernel).
- `setitimer` with an interval fires repeatedly; `getitimer` reports a
  sane remaining value; `alarm(0)` cancels.
- Default action (no handler installed) terminates the process.
