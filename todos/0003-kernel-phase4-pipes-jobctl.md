# 0003 — kernel Phase 4: pipes + job control

- **Status**: queued
- **Depends**: 0002, **0009** (the fd/data-plane amendment — resequenced
  ahead of this after the 2026-07-06 difficulty analysis: with kernel-owned
  fd tables, pipes are just another OFD kind, fd_action translation
  disappears, the shared-offset deviation disappears, and select/poll
  readiness unifies kernel-side)
- **Design**: `todos/KERNEL.md` (Pipes and cross-process blocking; Signals
  stop/continue classes; the fd/data-plane amendment)

## Goal

Cross-process pipes with real blocking (kernel-side buffers + wait queues,
EPIPE + SIGPIPE), and job control: stop/continue signal classes (cooperative
stop at safe points), SIGTTIN, WUNTRACED/WCONTINUED wait states.

## Plan sketch

- Fold the host.js `pipeBroker` seam into 0x02xx kernel opcodes; blocked
  readers/writers register on kernel wait queues, any state change rings
  their doorbells.
- fd_actions finally applied at spawn (they already ride procSpec verbatim).
- STOP flag in KP_FLAGS + park-at-safe-point; CONT clears + rings; parent
  notification via SIGCHLD + WUNTRACED/WCONTINUED.

## Acceptance

- tests/kernel: cross-worker blocking pipe read woken by write; EOF on
  close; `yes | head`-shaped SIGPIPE death; stop/cont round-trip observable
  via WUNTRACED; fd_actions wire a pipe across posix_spawn.
