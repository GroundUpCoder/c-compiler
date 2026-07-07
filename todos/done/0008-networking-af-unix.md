# 0008 — networking: AF_UNIX first

- **Status**: DONE (2026-07-07)
- **Depends**: 0003 (pipe/waitqueue machinery to build on)
- **Design**: `todos/KERNEL.md` "AF_UNIX sockets"; `todos/OS.md` (Phase 4)
- **Log**: `logs/2026-07-07/af-unix-sockets.md`

## Goal

Sockets, starting where no relay infrastructure is needed: AF_UNIX as named
rendezvous in BlockFS over the kernel's pipe machinery — unlocking IPC for
the WM protocol and multiplexers. AF_INET (WebSocket/WebTransport relay)
and a fetch()-backed HTTP convenience API come after, as separate items.

## Acceptance

- socket/bind/listen/accept/connect/send/recv over AF_UNIX between two
  spawned processes; socketpair; poll/select integration.

## Outcome

All acceptance criteria met — `tests/kernel/test_sockets.js` (65 protocol
checks) + `test_sockets_e2e.js` (real C client/server through the wasm
libc; a parked accept woken by a cross-process connect, poll + select,
socketpair, S_IFSOCK stat). Shape: a connection is two pipe-shaped
directions; the pipe read/write/notify/select machinery was factored into
`_streamRead`/`_streamWrite` and reused verbatim. New opcode block 0x05xx
(control plane only — data rides FS_READ/FS_WRITE). bind creates a real
S_IFSOCK node via the existing generic mknod (no format change; open() on
one is ENXIO). v1 non-goals recorded in KERNEL.md: SOCK_DGRAM, abstract
namespace, SCM_RIGHTS, O_NONBLOCK, MSG_PEEK, blocking connect.
