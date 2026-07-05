# 0009 lands: the kernel owns the fds, processes share a real filesystem

Implemented the fd/data-plane amendment same-day. The shape that made it
tractable: **reuse, twice.**

1. **OFDs are BlockFS fds.** A 'file' open file description is backed by
   one fd of the kernel's single BlockFS instance — its position IS the
   shared offset, and BlockFS's tested unlink-while-open refcounts become
   system-global for free. The kernel adds only the two-level indirection
   (per-PCB fd maps → OFD table) and per-process cwd (it prefixes relative
   paths; BlockFS normalizes).
2. **The process-side env is toWasmEnv itself**, `.call()`ed over a
   RemoteFS whose ~30 methods mirror BlockFS's JS surface as RPCs (same
   null + _lastError conventions). Only two env entries needed overriding
   (isatty, __select_impl — they consult in-process state). No 600-line
   env duplication, no import-name drift.

Other pieces: raw-payload RPC kind (KP_RPC_KIND word — read/write bytes
cross as one memcpy each way, no JSON); full POSIX fd inheritance +
OPEN/DUP2/CLOSE fd_actions applied kernel-side at spawn (the kernel IS the
parent fd table — the 0003 translation problem never existed in this
design); brokered-mode tty reads as deferred RPCs served from the line
discipline's cooked buffer (EINTR via the existing krpc-intr, zero new
machinery); FS_SELECT deferred kernel-side with readiness + timeout;
pcb.waiter generalized to one-deferred-RPC-of-any-kind.

## Proof (test_fs_e2e.js, 14 checks)

`log=[AAABBBCCC]` — parent writes AAA, child writes BBB on the inherited
fd, parent writes CCC: **shared open file descriptions across processes**,
the thing the old architecture could never do. Plus: OPEN-action stdout
redirect lands in the file; ghost read of an unlinked file via an
inherited fd; per-process cwd; directory listing through the broker; and
the headline upgrade — **SIGKILL a hog holding an unlinked-open file, then
fsck the store: clean**. The Phase-1 "accepted leak" is retired, verified
by the independent checker.

## Benchmark gate (bench_fs.js, recorded per the acceptance criteria)

Same C workload, brokered vs in-process private fs:

| | write 8K chunks | read 8K chunks | open/write/close/stat |
|---|---|---|---|
| brokered (kernel RPC) | 559 MB/s | 482 MB/s | 96.6K ops/s |
| in-process (private) | 1327 MB/s | 1163 MB/s | 698K ops/s |

≈10µs per RPC round-trip (postMessage + futex park + SAB memcpy). The
2.4×/7× relative cost is real but the absolute numbers dwarf interactive
needs (a shell command is hundreds of syscalls; sqlite-scale is
thousands — sub-ms either way). Atomics.waitAsync remains the recorded
pure-SAB upgrade path if a workload ever cares.

## Gotchas for the record

- tests/blockfs has TWO fscks: fsck.js guards v3, fsck_v4.js is the
  current-format one (returns an array of problem strings, not a report
  object). The kernel test uses fsck_v4.
- A fresh createV4 image ships a /dev directory — root listings start at 1
  entry, not 0.
- Suites: kernel (7 files) green, units 694/0, spawn parity, BlockFS —
  all green; standalone paths untouched by construction (the brokered
  branch only activates via Kernel opts.fs).

Next: `todos/0003` — pipes + job control, now genuinely small: a pipe is
just another OFD kind behind the same read/write/select RPCs.
