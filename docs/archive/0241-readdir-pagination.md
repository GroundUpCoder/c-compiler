# 0241 — arch CS2: paginate FS_OPENDIR so large directories are listable

- **Status**: done (2026-07-17)
- **Design**: —

## Goal

`FS_OPENDIR` reads the ENTIRE directory kernel-side and ships it as ONE
JSON payload. `_respond` silently degrades any payload over
`KP_PAYLOAD_CAP` (~64K) to `{errno:'ENOMEM'}` — so a directory with more
than ~1200–1800 entries (entry JSON is 35–60 bytes) makes `ls`/`find`/
fileman fail outright on every brokered volume. A latent correctness-bug
factory as user data grows; forecloses any large-directory workload.

## Plan

Paginate at the RPC layer so EVERY directory backend (BlockFS, ProcFS,
MountFS routing, brokered fallbacks of the RO fast path) benefits with
zero backend change — all of them already hold stateful dir handles:

- Kernel: `FS_OPENDIR` returns the FIRST page of entries whose measured
  JSON bytes fit under a derived `KP_DIR_PAGE` budget (the 0235
  derived-constant discipline). When the next entry would overflow, the
  open backend handle parks in `pcb.dirRpc` keyed by a cursor id returned
  as `more`, with the overflow entry carried as `pending` (nothing
  re-read or lost). New op `FS_READDIR {dir}` consumes the cursor and
  returns the next page (re-parking as needed). The final page carries no
  `more` and closes the handle. Bad cursor → EBADF. `_exitProcess` closes
  parked handles (fd discipline) so a client death mid-pagination leaks
  nothing. `_respond`'s general oversize guard stays — readdir just never
  trips it now.
- Client: `RemoteFS._opendirBrokered` loops `while (r.more !== undefined)`
  accumulating pages, then snapshots — `readdir`/`closedir`/pos semantics
  unchanged for all callers. Small dirs are byte-identical to today (one
  RPC, no `more` key).

## Acceptance

`tests/kernel/test_readdir_page.js`: a 3000-entry directory (≫ one page)
lists FULLY and IN ORDER over the raw RPC protocol and through the real
`RemoteFS` client loop; small dirs stay single-RPC; ProcFS lists through
the same path; stale cursor → EBADF; no kernel-side handle leak after
exhaustion, and process exit mid-pagination releases the parked handle
(BlockFS `_dirTable` back to baseline).
