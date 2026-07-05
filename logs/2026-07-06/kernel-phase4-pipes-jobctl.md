# kernel Phase 4 — pipes + job control (todos/0003)

The last kernel phase before the shell port. Landed same-day as 0009, and
that resequencing decision proved itself: **pipes needed exactly one new
opcode** (`PIPE_CREATE`, 0x0201). Everything else — inheritance, fd_actions,
read/write/close/dup, select, exit cleanup — was already generic over OFDs.
The design doc's `PIPE_REF/PIPE_CLOSE/PIPE_WAIT/PIPE_NOTIFY` opcodes were
never built; OFD refcounts + FS_* RPCs + the doorbell subsumed all four.

## Pipes

- A pipe is `{buf, cap 64KiB, rOpen, wOpen, readWaiters, writeWaiters}` with
  two OFDs (`kind:'pipe'`, `end:'read'|'write'`) over it. `_ofdUnref` on the
  last ref of an end flips `rOpen`/`wOpen` and notifies — EOF and EPIPE fall
  out of refcounting, including on SIGKILL (exit releases every fd, which is
  also why the fs e2e's "no OFDs survive the halt" check keeps holding).
- Blocking read/write are the deferred-RPC pattern from 0009's tty reads:
  `pcb.waiter = {op:'piperead'|'pipewrite', pipe, ...}` + a FIFO pid queue on
  the pipe; `_pipeNotify` serves both queues until a pass makes no progress
  (reads free space, writes supply data), then re-checks deferred selects.
  This closes the pre-kernel `pipeBroker`'s structural hole: a cross-worker
  blocking pipe read finally has a wake path.
- POSIX corners: writes ≤ `PIPE_ATOMIC` (512) never split — they defer whole
  when they don't fit; bigger writes land partially (callers loop, stdio
  amortizes). Write to a reader-less pipe = EPIPE response + SIGPIPE through
  the normal `_deliver` path, so DFL kills the writer — the `yes | head`
  death — while a handler sees EPIPE + the pending bit.
- `RemoteFS.write` became interruptible (`krpc-intr` → EINTR) since it can
  now defer; for files it responds immediately, so the flag never fires.

## Job control

- Stop is cooperative, exactly like signal delivery: `_stopProcess` sets
  `KP_FLAGS.STOP` + rings; the process parks in `KernelClient._stopWait()`.
  SIGCONT clears + rings; `waitpid` grew WUNTRACED/WCONTINUED with
  once-per-transition reporting (`pendingStop`/`pendingCont` on the PCB).
  SIGCONT resumes regardless of disposition (POSIX); SIGSTOP never consults
  the mirror; DFL-terminate signals kill even a stopped process (Linux
  semantics). kill()/killpg now target stopped processes too.
- **Gotcha that the e2e caught**: the first stop-park lived only in
  `sigpoll`, but host.js's `deliverSignals` short-circuits when the module
  exports no `__sig_dispatch` (any program that never touches signal()) — so
  a handler-less ticker kept ticking while "stopped". The fix: `_stopWait()`
  also runs at **RPC entry** (`KernelClient._finish`), i.e. at every
  brokered syscall. That's the honest safe-point family — a stopped process
  issues no new syscalls — and the e2e now proves output freezes and
  resumes. Corollary (documented): in brokered mode any syscall is a stop
  point; standalone processes stop only at kernel-RPC boundaries; pure
  compute stops never (same caveat as signals; SIGKILL backstops).
- SIGTTIN moved kernel-side rather than the doc's libc-compares-pgid sketch:
  the brokered tty FS_READ already lands in the kernel, which owns fgPgid.
  Background reader → SIGTTIN to its pgroup + EINTR; ignored/blocked →
  EIO per POSIX.
- `_onWorkerMessage` now accepts messages from STOPPED processes — a krpc
  can race the stop, and dropping it would deadlock the parked worker.
- libc: `WIFCONTINUED` added to `<sys/wait.h>` (status `0xffff`; encodings
  already matched Linux).

## Tests

- `test_kernel.js` + new `test_pipes.js`: fake-worker protocol tests (34
  pipe checks; stop/cont/wait semantics). Test-harness lesson recorded in
  both files: a process with a deferred RPC in flight is parked and cannot
  issue another RPC — triggers must come from another process or the
  embedder `kernel.kill()`; violating this corrupts the single RPC slot.
- `test_pipes_e2e.js`: real C — parked read woken cross-worker, EOF,
  fd_actions-wired child|child pipeline (consumer exit code = byte count),
  `yes | head` SIGPIPE death. One expectation bug worth remembering: a pipe
  read returns *available* bytes, not the requested count — the "head" loop
  must accumulate.
- `test_jobctl_e2e.js`: real C ticker; asserts the output byte-stream
  actually halts while stopped and resumes on SIGCONT, plus the
  WUNTRACED/WCONTINUED/WIFSIGNALED waitpid sequence.
- Suites: kernel 9/9 files, spawn parity, BlockFS 12/12, units 694/0.

Next: `todos/0004` (os/ reference page + protoshell) — the kernel is now
feature-complete for `todos/0005`, the busybox-ash acceptance gate.
