# Designing kernel.js — the process control plane

With the north star recorded (`todos/OS.md`), picked the next architectural
work: not the shell itself, but the kernel it needs. Landed `todos/KERNEL.md`.

## The finding that shaped the design

Surveying host.js for the design revealed something the docs never said out
loud: **the kernel is not in this repo.** host.js defines seams — spawnHooks,
the optional pipeBroker, the live-stdin SAB (which already carries
SI_TERMIOS/SI_COLS/SI_ROWS), `__on_sigdisp` disposition mirroring — and the
one real owner-side implementation lives in the external c/ app. In-repo,
only a test fixture implements the hooks. Meanwhile more groundwork exists
than expected: select() with futex parking, partial termios (3-bit mode word
published for the *page* to implement line discipline), full libc
signal/sigaction/raise with synchronous self-delivery, and a pgid field in
the spawn spec that nothing consumes.

Four ad-hoc owner↔worker channels (spawn block-RPC, stdin ring, pipe broker,
termios word), no process table, no async signal delivery. That's the thing
to consolidate before the shell lands on it.

## Key decisions (rationale in KERNEL.md)

- **Separate `kernel.js`**, not a host.js section. Cardinality argument:
  host.js is per-process (inlined into every emitted page); the kernel is
  per-system. Single-program pages keep their no-kernel degenerate case; the
  OS becomes self-contained in-repo with external embedders as consumers.
- **Control plane only** — BlockFS data plane stays in-process over the
  shared store (the existing, correct architecture). Brokers never sit on
  syscall-frequency paths.
- **One doorbell futex per process** in a per-process kernel-page SAB
  (doorbell, SIGPEND, SIGBLOCK, flags, RPC region). Every blocking libc op
  becomes the same check-condition/check-signals/Atomics.wait loop → uniform
  EINTR, and Ctrl-C can interrupt any blocked read. This unification is the
  heart of the design.
- **Signals**: kernel owns routing + default actions (terminate/stop/cont
  classes), process owns handlers (libc tables already exist). Safe-point
  delivery at syscall entry; compute loops uncatchable in v1 (SIGKILL =
  worker.terminate is the backstop); `--signal-polls` loop-back-edge checks
  recorded as a future compiler flag, not v1.
- **tty as a kernel object**: today's page-side line discipline is inverted —
  the page can't turn VINTR into SIGINT because it knows nothing about
  processes. Full termios, canonical-mode editing, echo, control-char →
  fg-pgroup signals all move kernel-side; the tty SAB is an evolution of the
  existing stdin SAB.
- **Exit becomes an ordered RPC handshake** (flush → EXIT → kernel drains
  rings → zombie → SIGCHLD → terminate worker), structurally fixing the
  stdout-truncated-at-exit class from CONFORMANCE-REMAINING.md.
- **Accepted v1 limitation, recorded**: SIGKILL leaks unlinked-but-open
  BlockFS inodes (open-refcounts are per-instance in-memory); fsck already
  detects it; honest fixes are format changes (orphan list) deferred.
- **WM headroom**: 0x1xxx opcode space reserved; focused-surface : input ::
  fg-pgroup : tty is the same routing problem, so the per-process page and
  doorbell are process-generic on purpose.

Five implementation phases, ending with the busybox shell port as the
acceptance test: "if the shell needs a kernel workaround, the kernel design
was wrong."
