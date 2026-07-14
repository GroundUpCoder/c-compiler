# The unified wait — one park over every wake source (todos/0178)

The post-Stage-4 consolidation of the wake channels 0161/0168/0169 built
piecemeal. Wake *production* was already kernel-owned (doorbell, input
ring, vsync word, deferred-RPC completion); wait *multiplexing* was not —
wm.c slept on two sources via the 0168 ring kick + a pre-park zero-timeout
`select()` (benign residual race, one comment of shame), and user32's
GetMessage chunked `__sdl_pump_wait(25)` forever because a
process→process agent socket has no pcb the kernel can kick.

## What landed

- **kernel.js `FS_WAIT` (0x0420)**: one deferred RPC over
  `{r: fds, ring, timeoutMs}` → `{why: 0 timeout / 1 fd / 2 ring}`, EINTR
  via the ordinary interruptible-RPC path (`_deliver` already rings the
  doorbell; the client's `krpc-intr` does the rest — no new signal
  machinery). Readiness at entry = `_selectScan` ∪ ring (WPOS≠RPOS);
  parked completion = `_recheckSelects` (extended to `uwait` waiters), a
  `_waitRingWake` hook in `_wmPushEvent`/`_wmKick`, or the timeout timer.
  The parked process can't move RPOS, so entry-scan-empty stays true
  until a push — and every push calls the hook. That pairing is the
  atomicity; the lost-wakeup class is gone structurally, not patched.
- **host.js `__wait`** in the surface backend: keeps pumpWait's two entry
  rules — the 0169 frame-idle release, and the b136b72
  no-park-when-entry-drain-produced rule (drained records → return 2
  without the RPC; drain again on ring completion so events are visible
  at import return). `__sdl_pump_wait` STAYS the raw single-source futex
  (KERNEL.md's two-tier wait rule is normative; SDL_WaitEvent apps never
  pay an RPC round trip).
- **wm.c**: `frame_cb(); __wait(&sock, 1, 1, saver ? 16 : 1000)` — the
  pre-park select and its residual-race comment are deleted.
- **peer.send kick-skip**: a client parked in a kernel fd-waiter is woken
  by its RPC completion; `peer.send()` captures the waiter kind before
  notifying and skips the `_wmKick` for those, so wm gets exactly ONE
  wake per WMP event (the kick survives as the pump_wait tier's belt —
  sockwake e2e unchanged).
- **user32 GetMessage**: WAIT over {agent listen fd} ⊕ ring ⊕
  next-timer-deadline. The 25ms chunk is dead — an idle winmine parks
  indefinitely; wmctl agent requests wake it via the listener-readiness
  `_recheckSelects` path (SOCK_CONNECT queues → recheck), WM_TIMER via
  the deadline.
- **term (the opportunistic third consumer)**: was a
  `__setAnimationFrameFunc` frame-loop app polling its pty master at
  60Hz — now an own-main-loop WAIT{master ⊕ ring} parker, zero wakes/s
  idle. This is the first app-class conversion off the scenario-B
  residual (winbox stays a frame-loop app by protocol).

## Gotchas worth remembering

- **Waiter-op namespace collision**: the first cut named the new waiter
  `op: 'wait'` — which waitpid's parked waiter already uses
  (`{op: 'wait', sel, options}`, answered by `_exitProcess`). The
  extended `_recheckSelects` then ran `_selectScan(pcb, undefined,
  undefined)` on any process parked in waitpid → TypeError → kernel
  crash on boot (hush is ALWAYS parked in waitpid). The new e2e passed
  because nothing in it waitpids while readiness changes; `test_os_boot`
  caught it at the first `ls /`. Renamed to `'uwait'`. Lesson: waiter
  ops are a flat string namespace — grep `op: '` before naming one.
- **GetMessage's timer deadline must honour the hwnd/range filters**
  exactly like `timer_scan`: a due timer that the current filter
  excludes would otherwise pin the WAIT timeout at 0 and hot-spin the
  loop. `timer_next_ms(hf, mn, mx)` mirrors the scan's eligibility.
- **FS_WAIT is brokered-only** like every 0x04xx op (no-fs kernels answer
  ENOSYS → `__wait` returns -2, consumers keep a chunked-poll fallback).
  The first e2e draft booted a no-fs kernel and got -2 everywhere —
  the test now boots over a MemoryByteStore BlockFS like the sockets
  e2e, which is how wm.c/user32 actually run.
- **The claimed-signal check→park gap (term's nested-session hang)**: a
  WAIT park covers its declared sources plus UNCLAIMED signals. State
  DERIVED from a claimed signal is not a wake source: term's SIGCHLD was
  dispatched at an import return inside frame_cb (after its
  waitpid(WNOHANG) had already run), which CLEARED SIGPEND — the next
  `__wait(-1)` then parked forever past the zombie, and
  test_term_e2e's typed-`exit`-orphans-the-child leg hung (the direct
  child was a zombie, the orphan grandchild kept the master EOF from
  ever firing; strace showed `--- SIGCHLD ---` as the last line before
  silence). Fix shape: the handler sets a flag, and the main loop
  re-runs frame_cb instead of parking when the flag is up — signals
  dispatch ONLY at import returns, so a pure-wasm flag check
  immediately before the park has no gap a handler can slip into.
  Hold this pattern for any future WAIT consumer that reaps children
  or folds other handler-derived state into its loop condition.
- The recorded vsync escape hatch stays recorded: neither trigger fired
  (0169's Dekker pair held; kernel entry is still head-of-line behind
  compiles), so vsync remains a raw futex broadcast.

## Proof

`tests/kernel/test_wait_e2e.js` (18 legs): fd wake prompt, entry-scan
atomicity (select-then-WAIT returns immediately), pure timeout, ring wake
out of an INFINITE park with the event already in the SDL queue at import
return, signal-EINTR in <500ms with the C handler already run (the
chunk-boundary latency era is over), post-EINTR re-park.

Gates, all green: `tests/run.js host blockfs kernel` (67 kernel files —
os_boot's 139-failure first run was the waitpid/'wait' waiter-op
collision, fixed before anything landed), term/pty/repl reruns after the
term conversion, `tests/flake.js` (wm_service/term/os_apps/comp_park ×3
under load + os-compositor/os-doom/os-term ×3 — all 0% flake), the full
25-file browser sweep.

idlemeter after (20s wall, SwiftShader): **A. idle desktop 8.8% total /
0.2% gpu — identical to Stage 4** (the idle-zero acceptance holds under
the consolidation); B. 4 windows 463.9% total (449.9% at Stage 4 —
SwiftShader noise band), renderer bucket 4.4% → 3.9% with term+fileman
now WAIT parkers; B stays pinned BY PROTOCOL (winbox ×2 are frame-loop
apps arming vsync — the recorded app-class residual, not wait policy).
