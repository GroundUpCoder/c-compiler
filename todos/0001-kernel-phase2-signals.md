# 0001 — kernel Phase 2: signal delivery, EINTR, exit handshake

- **Status**: in progress
- **Depends**: — (Phase 1 landed: kernel.js @ 990c5ee)
- **Design**: `todos/KERNEL.md` (Signals; Exit and teardown; phases list)

## Goal

Asynchronous inbound signals become real: a `kill()` from another process
runs the target's C handlers at libc safe points, interrupts its blocking
calls with EINTR (honoring SA_RESTART on waitpid), and `exit()` becomes an
ordered kernel handshake.

## Plan

- kernel.js: OP.EXIT; WAIT interruption (`krpc-intr` → EINTR); DFL-terminate
  honors the target's published KP_SIGBLOCK (post pending instead of
  terminating a process that blocked the signal); post SIGCHLD to the parent
  on child exit.
- KernelClient: `sigpoll()` (atomically claim pending&~blocked), `sigmask()`,
  `park(ms)` (doorbell wait until signal/timeout), `exit(status)`;
  interruptible WAIT.
- libc `__signal.c`: exported `__sig_dispatch` (async delivery into the
  existing handler tables); sigprocmask publishes the mask via `__on_sigmask`
  and drains newly-unblocked pending signals; `pause()`/`sigsuspend()` become
  real over `__sig_pause`; DFL-terminate routes through kill-self so the
  termsig round-trips as WIFSIGNALED (fallback `__exit(128+sig)` without a
  kernel).
- host.js: generic safe-point check on env imports (kernel-present only);
  sleep/usleep/nanosleep interruptible via `park`; `__exit` calls the exit
  hook; waitpid restarts on EINTR when every delivered action had SA_RESTART.

## Acceptance

- tests/kernel: handler runs cross-process; blocked-in-`waitpid` parent gets
  EINTR (and SA_RESTART variant doesn't); `sleep(100)` interrupted by a
  caught signal returns early; blocked SIGTERM survives until sigprocmask
  unblocks, then dies as WIFSIGNALED; exit(3) handshake preserves output
  ordering.
- Full unit suite, spawn parity, BlockFS all stay green.

## Non-goals (later phases / recorded caveats)

- stdin/select EINTR (needs the tty object — `todos/0002`).
- stop/continue signals (job control — `todos/0003`).
- Compute loops still can't be interrupted by catchable signals (settled in
  KERNEL.md; SIGKILL works).
