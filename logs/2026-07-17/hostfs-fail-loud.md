# host.js fs fail-loud triple: --block-fs clobber, O_APPEND fstat swallow, pipe spurious EOF (todos/0233)

Closed the three silent-data-loss / silent-wrong-data bugs the 2026-07-16
code-debt scan filed against host.js's filesystem layer (CD1, CD4, CD5).
Common thread: each swallowed an error and degraded into *wrong data with
zero diagnostic* — the exact anti-pattern the test-sync doctrine bans
("failure must point at its cause"). All three now fail loud; the
legitimate degrade paths (new-image ENOENT, real pipe EOF) are preserved.

## CD1 — `--block-fs=path` CLI clobbered the image on ANY read error

**Failure scenario**: `readFileSync` on the image path failed for any
reason (transient EACCES, EIO, EISDIR…) → the catch was empty → host.js
proceeded with a fresh empty MemoryByteStore → the unconditional
`writeFileSync` at exit **overwrote the user's image with the empty one**.
Real, unrecoverable data loss from a transient startup error.

**Fix**: only ENOENT (the one legitimate "create a new image" case) falls
through; any other errno prints `BlockFS: cannot read image <path>: <why>`
to stderr and exits 1 *before a store is ever created* — matching the
existing `BlockFS init failed:` loud path right below it (which already
covered corrupt-but-readable images).

**Test** (`tests/host/test_blockfs_cli_clobber.js`): the unreadable leg
uses a **write-only (0200)** file, not 0000 — with 0000 the exit-flush
would coincidentally fail too and mask the clobber; 0200 reproduces the
exact pre-fix scenario (read fails, write succeeds → original destroyed).
Asserts exit 1, stderr names the path, the program never ran, and the
original bytes survive; the ENOENT leg asserts a missing image still runs
and materializes at exit. Red pre-fix (4 failures), green now.

## CD4 — O_APPEND open swallowed fstat failure → "append" at offset 0

**Failure scenario**: `__open_impl` with O_APPEND fstats the fresh fd to
position at EOF; the catch was an *uncommented* empty swallow (the repo's
other empty catches are commented deliberate teardown swallows), leaving
`entry.position = 0` on an fd marked append. Writes were saved by the
native O_APPEND flag, but every positioned read and SEEK_CUR then operated
from offset 0 — silent wrong data.

**Fix**: a failed fstat fails the open — `setErrno`, close the native fd
(no leak), return -1. The second swallow (the post-append-write position
resync at the write path) now falls through to write's existing
errno/-1 catch: the bytes landed but the fd is broken, and a silently
stale position would corrupt every later read/SEEK_CUR.

**Test** (`tests/host/test_append_fstat_fail.js`): drives
`createFileSystem` directly with a NodeFS-shaped fake fs whose fstatSync
throws EIO — the documented "fs module or compatible subset" seam;
`createFileSystem` gained a test export (the existing BLOCK_FS test-export
convention) since a real fstat can't be made to fail on a live fd.
Positive control pins position-at-EOF when fstat works. Red pre-fix
(5 failures: open returned a live fd, no errno, fd leaked, resync write
reported 3), green now.

## CD5 — native-fs pipe read returned spurious EOF with the writer open

**Failure scenario**: the pipe-aware read patch returned 0 on an empty
buffer even when `pipe.closed.write` was false ("non-blocking for now") —
0 is indistinguishable from EOF, so a reader racing its writer exited
early and silently truncated the stream (the 0171 bug class).

**Fix**: mirror the readImpl stdin pattern the same function already uses
— the handler was already `WebAssembly.Suspending`. Reads park on a
per-pipe `waiters` list; `pipeWake` resolves them on write and on the
write end's last-duplicate close (BOTH close sites: the patched close
import and dup2's inline close-of-newfd). EOF (0) only when
`closed.write` with the buffer drained, so real EOF and buffered-drain
semantics are unchanged. A single-threaded program reading its own empty
pipe now blocks — which is what POSIX does; the old instant-0 was
EOF-semantics for anyone who observed it.

**Test** (`tests/host/test_pipe_read_block.js`): stubs
`WebAssembly.Suspending` to identity in its own process so the async read
is callable from JS, then pins: empty-pipe-with-live-writer parks (does
not resolve in 30ms), a write wakes it with the data, a write-end close
wakes a parked reader with real EOF, and buffered bytes still drain
before EOF. Red pre-fix (first read resolved 0 instantly), green now.

## Gates

- `node tests/run.js unit` — 757 passed, 0 failed, **8 xfailed** (count
  preserved), 3 skipped.
- `node tests/run.js host blockfs ast` — all green (host 120s includes the
  three new tests; blockfs 88s; ast green).
- `tests/spawn/test_spawn_host.js` (standalone spawn over the native-fs
  env, the nearest pipe consumer) — PASS.
- **No mkimage bake, no kernel suite, no browser sweep**: the changes are
  host-side only — CD1 is the Node CLI entry, CD4/CD5 live in
  `createFileSystem`, the *standalone* (no-kernel) fs flavor; kernel
  processes use RemoteFS/toWasmEnv (the 0x04xx RPC path) and kernel.js's
  own pipe machinery, neither of which is touched. No codegen touched →
  no SameBoy interlock needed.
- Red→green verified by running all three tests against the pre-fix
  HEAD host.js (plus only the test export) in a throwaway dir.

## Commits

- `9999481` CD1, `a80949d` CD4, `ae775da` CD5 (one per fix, each with its
  regression test; the per-fix host.js chunks were reconstructed from a
  verified snapshot — final bytes hash-identical to the gated tree).
