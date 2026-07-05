# kernel Phase 2: signals become asynchronous (todos/0001)

Implemented KERNEL.md Phase 2 across all three layers. A `kill()` from one
process now runs C handlers in another, interrupts its blocking calls with
EINTR (SA_RESTART honored on waitpid), `pause()`/`sigsuspend()` work, and
exit is an ordered kernel handshake. This is the phase that finally touched
host.js — Phase 1 deliberately didn't.

## How delivery works (the shape that landed)

- kernel.js posts pending bits (`Atomics.or` on KP_SIGPEND) + rings the
  doorbell. Default actions honor the target's published KP_SIGBLOCK: a
  blocked fatal signal parks as pending instead of killing.
- host.js wraps every env import (when a kernel is attached) so each return
  is a safe point: `sigpoll()` claims pending&~blocked bits CAS-atomically,
  and the wasm export `__sig_dispatch(sig)` runs the C handler tables.
  Math.* passthroughs are exempt (hot, pure, can't block). Zero cost
  without a kernel — the wrapper block never activates.
- libc: `__sig_deliver(sig, async)` is the single delivery core (raise()
  refactored onto it, keeping its historically mask-blind C11 semantics);
  DFL-terminate now routes through kill-self so the termsig reaches the
  parent as WIFSIGNALED (falls back to exit(128+sig) with no kernel);
  sigprocmask publishes the mask via `__on_sigmask` and drains both
  kernel-side and locally-parked pending on unblock.
- Interruptible WAIT: the parked KernelClient posts `krpc-intr` when it
  sees deliverable pending; the kernel cancels the registered waiter and
  answers EINTR (or the raced real result — both correct). host.js's
  `__spawn_wait` then delivers and either surfaces EINTR or transparently
  restarts when every delivered action had SA_RESTART.
- sleep/usleep/nanosleep park on the doorbell (hooks.park) instead of the
  private sleep cell, so signals wake them; `sleep` returns unslept
  seconds, the others EINTR. nanosleep's `rem` is not filled (noted).
- Exit: libc `__exit` → `spawnHooks.exit` → OP.EXIT rpc. Same-channel FIFO
  means all prior stdout messages are processed first, so waiters observe
  the status only after the output — the stdout-truncation class from
  CONFORMANCE-REMAINING is structurally impossible on this path.

## Bugs the work surfaced

1. **A shadowing `kill()` already existed** — unistd.h had
   `static inline int kill(...)  { return __spawn_kill(...); }` (missed in
   Phase 1's grep because of column-aligned spaces; lesson: grep libc
   headers with flexible whitespace). It silently won over the new
   __signal.c definition, so self-kill bypassed the handler tables
   entirely. Replaced with a declaration; __signal.c owns the definition.
2. **SIGCHLD-after-respond race** (caught by the e2e, visible as chld=0 at
   the first printf): the kernel answered the parked waitpid and THEN
   posted SIGCHLD — the woken client raced through its safe point before
   the bit landed. Fix: post SIGCHLD before responding, so the wake-up
   already sees it and the handler runs before waitpid returns to C.
   Cross-thread ordering around Atomics.notify is exactly where the
   fake-worker test can't catch things — the live e2e earns its keep.
3. Backticks inside C comments embedded in compiler.js template literals
   terminate the string — twice. Self-inflicted; worth remembering.

## Determinism notes for the e2e

Helpers delay 200ms before killing so targets are provably parked (they
reach the blocking call in microseconds). SIGCHLD counting is reset to DFL
after its test — later exits would coalesce nondeterministically (bitmask
pending, POSIX-legal). pause() sits in a `while (count unchanged)` loop so
an early delivery can't hang it.

## Verification

- tests/kernel: 60 semantics checks + 8 e2e + 14 signals-e2e — green.
- Full unit suite 694/0 (raise() refactor + new always-linked imports had
  no fallout; createNullSpawn grew __on_sigmask/__sig_pause stubs so
  kernel-less runtimes keep working, pause() degrades to ENOSYS).
- tests/spawn parity + BlockFS suite green.

Next: `todos/0002` (tty object + line discipline) — Ctrl-C becomes SIGINT.
