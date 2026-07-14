# The vDSO page — publish, don't serve (todos/0179)

First of the three "what may leave the kernel" tier items (KERNEL.md
single-writer rule, the 2026-07-14 design review): kernel state that has ONE
writer — the kernel event loop — no longer needs an RPC round-trip to read.
It gets PUBLISHED on the per-process kernel page and read with atomics, the
Linux vDSO pattern. The `KP_*` vsync/SIGPEND words were already doing this
ad hoc; 0179 makes it a deliberate surface.

## Shape

A 12-word tail block on the existing kernel page (words N-16..N-5, below
the four 0100/0169 vsync words; `KP_PAYLOAD_CAP` now stops 64 bytes short
of the page end — the 0169 payload-cap-arithmetic precedent). Chose the
per-process tail over a separate system page because every candidate field
is either per-process (pid family) or trivially fanned out (screen dims,
boot instant): no new SAB to hand around, no second mapping in host.js,
and spawn already stamps the page before the worker exists.

One SEQLOCK word guards the block: the kernel bumps odd → stores → bumps
even (`_vdsoPublish`, called at spawn, SETPGID, SETSID, reparent-to-init,
wmSetScreen); `KernelClient._vdsoRead` snapshots N words, retrying on an
odd or moved seq. Single writer ⇒ no CAS, no locks — the seqlock only
protects readers from a torn multi-word view. The reader's spin is BOUNDED
(64 tries) and falls back to the RPC, which stays the source of truth; a
seq of 0 means "no kernel ever stamped this page" (standalone/fake pages)
and also falls back. The self-pid check and the value ride the same
snapshot, so a getpgid(0) racing a setpgid can't pair a new pid with an
old pgid.

## What got faster / more correct

- `getpgrp()`/`getpgid(0)`/`getsid(0)` (and the explicit-own-pid forms):
  zero RPCs. Foreign pids still ask the kernel — a per-process page can't
  answer for other processes, and shouldn't try.
- `getppid()`: was a spawn-time STATIC in host.js — stale the moment the
  parent died (the kernel reparents orphans to init; POSIX says getppid
  then returns 1). Now a live page read threaded as an optional `getppid`
  fn through runModule → ctx → createPosix (both flavors), passed by
  process-worker.js and BOOT_SOURCE with the static as the null-fallback.
- Uptime: the kernel's `_bootMs` is published as unsigned lo/hi halves;
  `KernelClient.uptimeMs()` needs no RPC (there was never an uptime RPC to
  retire — /proc/uptime is a file read and stays one; this adds the
  process-side primitive for free).
- Screen dims: published at spawn and fanned out on `wmSetScreen` (a
  handful of atomic stores per process at human rate). `KernelClient.
  screen()` reads it. Deliberately NOT wired into user32's
  GetSystemMetrics — its synthetic 800×500 is policy ("a process can't
  see the real screen"), not a gap.
- libc grew `setsid()` — the SETSID RPC existed since Phase 1 but nothing
  ever declared it C-side; the e2e's mutation-visibility leg wanted it and
  it's plainly useful (daemons). Same `__spawn_*` pattern as its siblings.

## Not taken (recorded so nobody re-litigates casually)

- **fd-flag queries (F_GETFD/F_GETFL)**: a variable-size per-fd table, not
  a fixed word block — different shape, low RPC traffic. Revisit only if
  profiling shows those RPCs mattering.
- **fg pgid (tcgetpgrp)**: per-TTY, not per-process — belongs in the tty
  SAB header next to the winsize words (which already publish TIOCGWINSZ
  zero-RPC, predating this item) if it's ever worth it.
- **wasm multi-memory** for direct C-side reads: imports are nanoseconds;
  the hop this item kills is the cross-worker one, and it's dead.

## Testing notes

`test_vdso.js` runs the fake-worker harness, which bought a structural
proof: the kernel runs on the TEST's thread, so any KernelClient path that
fell through to a real RPC would park the thread forever — the client's
`call` is patched to record-and-return, and "zero RPCs" is then not an
assertion about a counter staying 0 but a property the test can't complete
without. The seqlock-wedge leg (store an odd seq by hand) exercises the
bounded-spin → RPC fallback deterministically, which a genuinely
concurrent writer never could.

`test_vdso_e2e.js` wraps `kernel._dispatchRpc` with an op counter and runs
a real 4-process C program (spawn → setsid → orphan reparent): every
printed value correct, zero GETPGID/GETSID in the whole trace, exactly the
one deliberate SETSID.
