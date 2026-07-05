# 0009 — kernel-owned fd table + brokered filesystem

- **Status**: in progress
- **Depends**: — (amends the data-plane decision; MUST land before 0003)
- **Design**: `todos/KERNEL.md` ("The fd/data-plane amendment", 2026-07-06)

## Goal

For the OS, the kernel owns the fd layer: per-process fd tables →
system-wide open file descriptions (offset/flags/refcount) → the ONE
BlockFS instance living in the kernel worker. Process fs syscalls become
RPCs on the kernel-page transport. Standalone pages keep the in-process
path untouched (two transports, one BlockFS).

This dissolves 0003's hardest parts (fd_action translation, the shared-
offset deviation), fixes documented limitations for the OS (cross-process
unlink-while-open, SIGKILL fd/inode leak), sidesteps the OPFS
exclusive-handle portability problem, and finally gives spawned processes
a SHARED filesystem (Phase 1's private-fs-per-process placeholder retires).

## Plan

- kernel.js: OFD table (kind file|tty|out, backed by BlockFS fds of the one
  instance — reusing its tested position/refcount/pipe semantics), per-PCB
  fd maps, per-process cwd resolution (kernel prefixes relative paths),
  fs RPC handlers (raw-byte payloads for read/write via a new
  KP_RPC_KIND word; JSON elsewhere), full fd inheritance + OPEN/DUP2/CLOSE
  fd_actions at spawn, OFD deref on exit/kill, tty reads as deferred RPCs
  served from the line discipline's cooked buffer (EINTR via krpc-intr),
  select as a deferred RPC with kernel-side readiness + timeout.
- host.js: RemoteFS — the process-side client whose wasm env mirrors
  toWasmEnv's import surface with RPC stubs; BOOT_SOURCE selects it in
  brokered mode.
- Kernel constructor gains the fs: `new Kernel({ fs: blockFsInstance, … })`.

## Acceptance

- Two spawned processes see one filesystem (write in A, read in B).
- A dup2-inherited fd SHARES its offset with the parent (POSIX open file
  description) — parent/child interleaved appends land correctly.
- fd_actions: `posix_spawn` with OPEN (redirect stdout to a file), DUP2,
  CLOSE all work; the redirected child's output lands in the file.
- Unlink-while-open holds ACROSS processes; SIGKILL leaks nothing (fsck
  clean after kill — upgrade of the Phase-1 accepted leak).
- tty e2e semantics hold in brokered mode (canonical read, ^C→EINTR, raw).
- **Benchmark gate**: brokered vs in-process throughput measured (bulk
  read/write in stdio-sized chunks + a stat/open/close loop) and recorded
  in the dev log; interactive use must be unaffected.
- All existing suites stay green (standalone paths untouched).

## Non-goals

- Pipes as OFDs land in 0003 (they become straightforward here).
- The pure-SAB syscall fast path (Atomics.waitAsync, no postMessage) is a
  recorded upgrade, not v1.
- O_CLOEXEC bookkeeping arrives with the shell port if needed.
