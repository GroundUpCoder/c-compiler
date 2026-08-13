# #647 — stopped pipe readers: the tty guard applied to _pipeNotify, the strand closed in _contProcess

## The claim, and what the probe actually showed

The ticket (audit-harvest, GLM) claimed a SIGSTOPped process parked in a pipe
read could "consume then lose" bytes: `_pipeNotify` serves waiters without the
stopped-state check `_ttyNotify` has, and stop does not cancel pipe waiters —
so a write to the pipe hands bytes to a process that is not running,
"data destroyed, not merely delayed".

Dynamic probe (fake-worker harness, the test_pipes.js plumbing; control leg
first proved the harness sees bytes in the good case):

- **The data-loss half is REFUTED for the single-reader case.** Pre-fix, the
  stopped reader's RPC *was* served while stopped (reply landed on its kernel
  page, pipe drained), and after SIGCONT the bytes came back intact
  (`read result: "GONE?"`). This is the documented job-control design
  (kernel.js job-control header: "if the RPC completes while stopped, the
  worker runs to the next safe point and parks there") — the real worker is
  blocked in Atomics.wait on the RPC doorbell, which stop does not touch, so
  it wakes, completes the read into its own memory, and parks at the next
  safe point. Delayed in the reader's own hands, not destroyed.

- **The tty-parity steal is REAL.** With two readers sharing the read end
  (dup-across-spawn — the pipeline shape), the STOPPED reader parked first
  consumed the bytes while the RUNNING reader behind it in the FIFO stayed
  parked. That is byte-for-byte the bug the tty guard exists for (a Ctrl-Z'd
  `cat` stealing the shell's next typed line, test_jobctl_tty_e2e). On Linux
  the stopped reader's sleep is signal-interrupted (-ERESTARTSYS; the syscall
  restarts at continue), so a running reader always wins. And the loss IS
  reachable through this shape: stop the reader, write, `kill %1` — the bytes
  the stopped process consumed die with it, where Linux would have left them
  in the pipe for the surviving reader.

## The comparison (the deliverable), pinned at 3e2fd4ed

- **tty**: `_ttyNotify` (kernel.js:7194) walks `tty.waiters` by index and
  skips `STATE_STOPPED` entries — `kernel.js:7201`
  `if (pcb.state === STATE_STOPPED) { i++; continue; }  // parked, not a consumer`.
- **pipe**: `_pipeNotify` (kernel.js:7417) walked `pipe.readWaiters` head-only
  (`while (pipe.readWaiters.length)` on `[0]`) with NO state check — a stopped
  waiter at the head was served (kernel.js:7428-7444 pre-fix).
- **stop**: `_stopProcess` (kernel.js:8153) cancels nothing — correct; the
  waiter must survive the stop to be servable at resume.
- **cont**: `_contProcess` (kernel.js:8164) rang the process but re-ran NO
  serve loop — for the tty this is a latent strand that the next human
  keystroke self-heals; for a pipe nothing ever re-notifies.

## The fix

1. `_pipeNotify`'s readWaiters loop is now the `_ttyNotify` shape: index walk,
   `STATE_STOPPED` ⇒ skip (parked, not a consumer). Stale-entry pruning and
   FIFO order for eligible waiters unchanged.
2. `_contProcess` re-runs the resumed waiter's serve loop
   (`piperead`/`pipewrite` → `_pipeNotify(w.pipe)`, `ttyread` →
   `_ttyNotify(w.tty)`) so data or EOF that arrived during the stop is served
   at resume. This is the half that makes the guard safe against the ticket's
   named hazard — a guard without it trades data loss for a permanent hang.
   It also closes the pre-existing tty strand (cont with cooked data present
   and no further keystroke).

Deliberate scope decisions:

- **Writers are NOT gated.** A parked write's bytes were committed at the
  write() call (already copied into `w.data`); completing it while stopped
  loses nothing, matches the writer's already-returned success elsewhere, and
  unblocks running readers. Gating writers would only delay a live consumer.
  (Linux would hold the writer too, but the difference is unobservable except
  as extra latency for the running reader — and "serve committed bytes" is
  the better answer for a cooperative-stop kernel.)
- **select/uwait waiters stay served while stopped** (`_recheckSelects` has no
  state check): those replies carry readiness, not data — nothing is consumed,
  so nothing can be lost or stolen. The resumed process re-checks honestly.
- **FAST-ring pipes are out of reach by construction**: reads there are
  process-side memcpy with no kernel serve loop; a stopped process is parked
  at a safe point and issues no reads. Same cooperative-stop caveat as
  signals/pure-compute — nothing to guard kernel-side.
- `_streamRead` needs no dispatch-time guard: a stopped process issues no new
  syscalls (KernelClient parks at RPC entry, kernel.js:1320).

## SIGCONT ordering note

`_deliver` calls `_contProcess` (which now serves the parked read) and then
falls through to the disposition mirror for a CONT handler. If the process
has a SIGCONT handler, the read may complete with data while the handler bit
is pending — the handler runs at the next safe point. Linux would restart the
read after the handler; either order is a legal race outcome (data arriving
just before vs. just after cont), and no bytes move to an ineligible process.

## Tests

`tests/kernel/test_pipes.js` 41 → 53 checks (+12), red-controlled at the base:
pre-fix, "stopped reader consumes nothing" FAILs (the RPC completed while
stopped) and the steal leg FAILs then deadlocks at the running reader's
`finish()` — the deadlock itself is the pre-fix data-mislocation made visible.
Post-fix all 53 green. New legs: stop/write/cont round-trip (no strand, bytes
intact), the two-reader steal (running reader served past the stopped one;
resumed reader parked on the drained pipe, served by the next write), and
EOF-arriving-during-stop (the `!wOpen` leg of the cont re-notify).

No image bump: kernel.js is not a baked byte (it is the kernel host, not a
`/usr` payload); zero `os/` files touched.
