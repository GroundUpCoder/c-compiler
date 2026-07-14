# 0178 — kernel unified wait: one blocking primitive over fds + input ring + signal wakes

- **Status**: open
- **Design**: `todos/IDLE-POWER.md` "Follow-on: the unified wait" (and the
  KERNEL.md "Kernel-owned endpoints" wake note). The post-Stage-4
  consolidation of the wake channels 0161/0168/0169 built piecemeal —
  scoped and agreed 2026-07-14 during the Stage-3 design review.

## Goal

Wait multiplexing is the one part of waking that is NOT kernel-owned
today. Wake *production* already is — the doorbell (`KP_DOORBELL`), the
input ring (`IR_WPOS`), the vsync word (`KP_VSYNC_SEQ`), deferred-RPC
completion — but a process that wants to sleep on more than one source
builds its own multiplexer out of parts:

- **wm.c** (0168): parks on the input ring, needs the WMP socket too →
  the kernel-peer send kicks its ring (pure notify) + a pre-park
  zero-timeout `select()` closes the kick-before-park gap. Works, but the
  readiness check and the park aren't atomic — a benign-but-real residual
  race (an event landing in the select→park window sleeps ≤1 chunk).
- **user32 GetMessage** (0058): chunks `__sdl_pump_wait(25)` forever
  because its agent socket is a process→process socket the kernel can't
  kick (shared OFDs have no single owning pcb; only a *blocked reader* is
  known). 25ms polling is also what MASKED the pumpWait entry-drain race
  for two months (found+fixed b136b72).

The unified wait is the principled endgame every real OS converges on
(epoll, kqueue, WaitForMultipleObjects): ONE deferred RPC —

    WAIT { fds[...], ring: bool, timeoutMs }  →  R_WAIT { why, fd }

— the kernel checks readiness at RPC entry, parks the pcb if nothing is
ready, and completes on whichever source fires first: fd readable/EOF
(`_pipeNotify` readiness, the FS_SELECT machinery), an input-ring push
(`_wmPushEvent`), the timeout, or a posted signal (SIGPEND → complete
with EINTR-like `why`, making signal delivery just another wake source
instead of a chunk-boundary side effect). Readiness-check and park are
atomic kernel-side, so the lost-wakeup class disappears structurally.

## Plan

- Kernel: new 0x04xx-family op (it is fd-flavored; FS_SELECT is the
  closest precedent — reuse its readiness predicates and wait-queue
  plumbing; add the pcb to a ring-waiters set consulted by
  `_wmPushEvent`, and a SIGPEND hook that completes a parked WAIT).
- host.js: a `__wait` import over the RPC (park on the doorbell like any
  deferred RPC — no new futex); keep `__sdl_pump_wait` as a compat shim
  over it (`WAIT { ring: true, timeoutMs }` + drain on completion).
- Consumers, in order:
  1. wm.c: replace the pre-park `select()` + pump_wait pair with one
     WAIT on {sock} + ring — deletes the lost-wakeup comment entirely.
  2. user32 GetMessage: WAIT on {agent listen/conn fds} + ring — the 25ms
     chunk dies; measure the winmine/notepad idle-wake drop.
  3. (opportunistic) term's pty read loop if it still polls anywhere.
- Signal semantics: chunked parks are today's cooperative-signal safe
  points — a WAIT park MUST complete on SIGPEND post (kernel-side hook),
  or signals regress to wait-forever latency. Test explicitly
  (the test_waitevent_e2e signal-while-parked leg is the model).
- Keep the 0161 SDL_WaitEvent veneer on `__sdl_pump_wait` (single-source
  apps don't need the RPC round trip); the shim keeps its no-park-on-
  entry-drain rule (b136b72).
- **Escape hatch, recorded up front**: vsync deliberately stays a raw
  futex (60Hz × N apps through kernel RPC dispatch = head-of-line behind
  compiles; the 0100 broadcast is our io_uring ring / virtio suppressed
  doorbell). Two triggers would flip that decision — (a) 0169's
  ARMED/PARKED Dekker protocol proves race-prone in practice (its
  complexity was the price of keeping vsync kernel-invisible), or
  (b) kernel entry gets cheap (RPC lane split off the compositor/compile
  loop). Then "vsync as a WAIT source" is the Wayland configuration and
  the ARMED word dissolves into kernel bookkeeping.

## Acceptance

- wm.c has no pre-park select and no residual-race comment; the marquee/
  snap-preview e2es stay green under `tests/flake.js`.
- user32 apps park indefinitely in GetMessage (wake counter flat while
  idle — the 0169 counters are the probe) yet `wmctl click`/`tree` and
  WM_TIMER stay prompt; winmine's 1Hz counter still ticks.
- A signal posted to a WAIT-parked process runs its handler promptly
  (not at a chunk boundary), and SIGKILL still works.
- No regression in the 0169 idle-zero acceptance (the wake/submit
  counters stay at zero on a settled desktop).
