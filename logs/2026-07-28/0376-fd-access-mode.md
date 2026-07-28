# 0376 — fds now carry their access mode (write-on-O_RDONLY was silent corruption)

Ticket: `todos/0376` (P0 #1, decider ruling: fix, no waive). Provenance: the
libc env-divergence review (`logs/2026-07-28/review-libc-env-divergence.md`),
row **D3**. Branch `0376-fd-access-mode`, serialized behind 0375 because the
fix lands in the same `FS_OPEN` arm 0375 rewrote.

## The defect

Neither gucOS fd layer stored `open()`'s access mode, so `write()` on an
`O_RDONLY` fd silently mutated the file (the corruption half — defensive
read-only opens protected nothing) and `read()` on an `O_WRONLY` fd disclosed
it. Env N (Node passthrough) enforced correctly; Env B (in-process BlockFS)
and Env R (brokered kernel OFDs) did not.

## The fix — one mechanism, both layers

- **host.js `BlockFS.open`** stores `flags & O_ACCMODE` on the fd entry (file
  and dev branches). `read()` refuses `accmode === 1` (O_WRONLY), `write()`
  refuses `accmode === 0` (O_RDONLY), both EBADF. dup/dup2/F_DUPFD share the
  entry object, so the mode rides every duplicate — POSIX
  open-file-description semantics, for free, by the existing sharing.
- **`ftruncate()`** on a read-only fd is EINVAL (POSIX; the same corruption
  class — it mutates through a fd that was never opened for writing). The
  fd-mode check precedes the readonly-volume flag, like read()/write(): a
  readonly volume only hands out O_RDONLY fds, so its ftruncate is EINVAL
  (Linux agrees; EROFS is truncate(2)'s path-op errno), and the kernel's
  FS_FTRUNCATE arm answers the same — local/brokered identity.
- **Pipe ends** now refuse the wrong direction in Env B (write on the read
  end / read on the write end → EBADF). Env R always enforced this
  (`o.end !== 'read'`); Env B shared one buffer both ways. Same defect class
  — the direction is just an access mode fixed at `pipe()` — so it rides the
  same commit rather than a new ticket.
- **kernel.js**: both `_makeOfd('file')` sites (the `FS_OPEN` arm and the
  spawn fd-action OPEN arm) record `accmode`; `FS_READ`/`FS_WRITE` refuse
  wrong-mode file OFDs at the RPC layer and `FS_FTRUNCATE` is EINVAL.
  Belt-and-braces over the BlockFS check by design: the kernel OFD is the
  layer a non-BlockFS embedder `fs` would rely on. `FS_DUP`/`FS_DUP2`/spawn
  DUP2 share OFD ids, so the mode travels. The RemoteFS RO-fd brokered-twin
  promotion already reopens O_RDONLY on the immutable volume — consistent
  with the fds it twins (write-intent /usr opens never go local).

## Errno ordering worth recording

`write()` on a read fd of a **readonly volume** is now **EBADF, not EROFS**,
and `ftruncate()` there is **EINVAL** (test_readonly.js, kernel
test_mounts.js and test_rofs.js updated — the last one both locally and
brokered, keeping the RO-fd zero-RPC identity): the only fd a readonly
volume can hand out is O_RDONLY, and POSIX/Linux put the fd-mode check ahead
of the mount flag on fd-based ops. EROFS remains the answer for write-intent
*opens* and path mutations. The old EROFS-on-write belt-and-braces in
`BlockFS.write` stays as a pure backstop with its comment rewritten — its
"write() doesn't check the open mode" premise is dead.

## Tests (red first, then green)

Red recorded before the fix (commit `948a0ebc`):

- `tests/blockfs/test_posix.js` (Env B): 5 new tests FAILED — write on
  O_RDONLY returned 4 bytes, read on O_WRONLY returned 4, mode absent across
  dup/dup2/F_DUPFD, ftruncate returned 0, wrong-end pipe ops succeeded.
- `tests/kernel/test_fs_e2e.js` (Env R): 3 new expected lines FAILED —
  `romode w=4 e=0`, `womode r=4 e=0`, and the spawn fd-action O_RDONLY child
  left the file as `[EVILGOOD]` (the corruption, verbatim in the log).

Green after (fix commit `7b699124`): test_posix 25/0, test_fs_e2e PASS.

Two pre-existing tests **encoded the defect** and were corrected, not
quieted: `test_blockfs.js` 'write past end extends file' and 'dup creates
new fd' both opened with bare `O_CREAT` (= O_RDONLY) and wrote through the
fd — a real OS refuses exactly as the fix now does; they open `O_RDWR` now.

D11 (`access(path, mode)` ignores mode) and D9 (F_GETFL fabrications) stay
on `todos/0378` per the ticket — deliberately untouched here.
