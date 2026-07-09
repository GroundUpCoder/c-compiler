# 0046 — strace: per-pid syscall-RPC trace

- **Status**: open
- **Design**: `todos/KERNEL.md` (the kernel brokers every syscall — this
  is mostly formatting), discussion in
  `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

`/bin/strace cmd args...` — every kernel RPC of the child decoded
(opcode name, args, result, errno) to stderr. Near-free given the
architecture, and a big win for the agent-friendly goal (debugging
in-OS programs without instrumenting them).

## Plan

- kernel: a per-pcb trace flag; when set, each RPC appends a decoded
  text line to a kernel-side pipe OFD created at trace-enable (the
  tracer reads it like any pipe).
- spawn-spec field `trace` (the spec grows by field — OS.md), so strace
  spawns the child pre-traced with the trace pipe wired to an inherited
  fd. `-f` (descendants) later if wanted.
- `/bin/strace` (C): spawn traced child, copy trace fd → stderr until
  EOF, propagate the child's exit status.
- Decode table driven by the opcode names kernel.js already carries;
  KERNEL.md's opcode table stays the source of truth.

## Acceptance

- Headless: `strace cat /etc/<some file>` shows open/read/write/close
  and the exit; exit status propagates.
- Zero overhead with the flag off (kernel suite green, no timing
  regressions).
- Trace of a signal-delivering run shows the RPC stream around the
  safe-point claim (sanity, not a format golden).
