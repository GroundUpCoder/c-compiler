# 0008 — networking: AF_UNIX first

- **Status**: queued
- **Depends**: 0003 (pipe/waitqueue machinery to build on)
- **Design**: `todos/OS.md` (Phase 4)

## Goal

Sockets, starting where no relay infrastructure is needed: AF_UNIX as named
rendezvous in BlockFS over the kernel's pipe machinery — unlocking IPC for
the WM protocol and multiplexers. AF_INET (WebSocket/WebTransport relay)
and a fetch()-backed HTTP convenience API come after, as separate items.

## Acceptance

- socket/bind/listen/accept/connect/send/recv over AF_UNIX between two
  spawned processes; socketpair; poll/select integration.
