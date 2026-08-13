# #652 — BlockFS conformance trio: reproduce-or-refute, then fix what survived

Three claims from the deep-stack audit's lower-confidence list. All three were
run against the base tree (`4f165a33`) before any change, per the ticket's
reproduce-or-refute rule. Verdicts: **1 reproduced and fixed, 1 refuted as
already fixed (#641 landed after the audit ran), 1 reproduced with a scope
finding and fixed.**

## Claim 1 — `ftruncate(fd, 0)` retains its extent: REPRODUCED, FIXED

Base-tree observation (256K file, then `ftruncate(fd, 0)`):

```
[claim1] before: extentOffset=4632 extentCapacity=262144 dataSize=262144
[claim1] after:  extentOffset=4632 extentCapacity=262144 dataSize=0
[claim1] O_TRUNC twin: extentOffset=0 extentCapacity=0 dataSize=0
```

The mechanism: ftruncate's shrink branch is gated on `size < ino.dataSize &&
size > 0 && size < extentCapacity / 4` — the `size > 0` conjunct means
truncate-to-**zero** matches no branch at all. Size goes to 0, the whole
extent stays allocated. Meanwhile the O_TRUNC arm of `open()` (the twin
operation, #641's territory) frees the extent outright and zeroes
offset/capacity. The two truncation paths disagreed; the fd-based one leaked.

**Fix**: a `size === 0` branch in `BlockFS.prototype.ftruncate` that mirrors
the O_TRUNC arm — `_alloc.free(extentOffset)` (when present), then zero
`extentOffset`/`extentCapacity`. The `size > 0` conjunct on the shrink branch
became redundant and was dropped (zero is handled one branch earlier).

**Why the release is safe against a concurrent reader on the same inode** —
the ticket's named concern:

- Every `read()`/`write()` re-reads the inode through the store on entry (the
  read-through invariant, CLAUDE.md "the store is the single source of
  truth"). A reader that arrives after the truncate sees `dataSize 0`, takes
  the `n <= 0` EOF return **before** ever dereferencing `extentOffset`. A
  writer sees `newEnd > extentCapacity (0)` and grows a fresh extent. There is
  no cached extent pointer anywhere to go stale — fd entries hold only
  `inoId` + `position`, never extent geometry.
- This is not a novel exposure: the O_TRUNC arm has freed extents out from
  under open fds since it existed, and the existing shrink branch's `realloc`
  already *moves* extents while other fds are open. Same class, same
  invariant, already load-bearing.
- Cross-instance (two live BlockFS over one store): same answer — the inode
  is re-read through the store per call, and the allocator free-list is
  store-resident. The known cross-instance limitation (per-instance open
  refcounts, documented at the `_openInodes` comment) is unchanged by this.

**fsck**: pinned in the new test — `fsck_v4` clean after the release, and the
blockfs fuzzer (model-differential, fsck after every op, dual-instance mode)
passed 15/15 over the change. The free is allocator-consistent, so no corpus
remediation is owed: pre-fix images merely carry retained-but-owned capacity,
which fsck correctly never flagged (capacity ≥ size is legal) and which
self-heals on the file's next truncate-to-zero or delete.

Note on the leak's true shape: a truncate-and-**rewrite** cycle reuses the
retained extent, so a single file's retention is bounded by its historical
maximum size. The accruing case is files truncated to zero and *left* empty —
each retains its full old extent indefinitely. Either way a 0-byte file
owning 256K of image is wrong-shaped, and now it isn't.

## Claim 2 — truncate omits ctime: REFUTED (already fixed by #641)

Base-tree observation (v4, injected clock advanced +5000 ms between stat and
`ftruncate(fd, 10)`):

```
[claim2] before: mtime=1000000000 ctime=1000000000
[claim2] after:  mtime=1000000005 ctime=1000000005  (ctime bumped=true mtime bumped=true)
```

ctime **is** marked. The audit ran 2026-08-11 (ticket created the same day);
`#641` commit `a58189a9` ("pin open(O_RDONLY|O_TRUNC) = truncate; bump ctime
on truncate") landed on both the O_TRUNC arm and ftruncate after the audit's
snapshot. The behavior is already pinned by an existing test —
`test_posix.js` "O_TRUNC and ftruncate bump ctime as well as mtime (v4,
injected clock)" — so no new test is owed. The claim was true when the audit
looked and is not true now; recorded as refuted-by-supersession, no change.

## Claim 3 — `fsync()` accepts invalid descriptors: REPRODUCED (in-process path only), FIXED

Base-tree observation:

```
[claim3] fsync(999) [never opened] = 0 lastError=null
[claim3] fsync(3) [closed] = 0 lastError=null
[claim3] fsync(-1) = 0 lastError=null
```

Scope finding worth recording: the defect lived **only in the in-process
BlockFS path**. The other two transports already validated —

- kernel.js `FS_FSYNC` arm: `ofdOf(req.fd)` miss → `EBADF` (and
  `test_fs_e2e.js` already pins `badfsync` = EBADF on the brokered path);
- MountFS.fsync goes through `_fdOp`, which is `EBADF` on a missing fd;
- RemoteFS.fsync on a local RO fd is a deliberate 0 (nothing to flush,
  `test_rofs.js` pins it) and otherwise brokers to the kernel arm.

So an in-OS C program already got EBADF; only standalone/in-process pages
(bare BlockFS, the "two transports, one fs" other half) accepted garbage.

`BlockFS.fsync` carried a comment defending the tolerance: "stdio and
freshly-dup'd fds all land here and must not fail." That rationale is stale —
the fd table has seeded `{console: true}` entries for 0–2 since the console
routing rework (CD27), and `dup`/`dup2`/`F_DUPFD` share entry objects, so
every *live* fd has a table entry. Validating existence breaks nothing that
is actually open.

**Fix**: `BlockFS.fsync` refuses a missing table entry with `EBADF`; any live
entry (file, console, pipe, dev) still succeeds with the whole-store flush —
same shape as the kernel arm ("fsync may flush more than requested"; non-file
kinds are a harmless 0). New test pins EBADF on never-opened / closed /
negative fds **and** the live-fd controls (stdio ×3, pipe ends, live file).

## Tests

`tests/blockfs/test_posix.js` 37 → **39** (+2), red-controlled: pre-fix both
new cases fail on exactly the claimed defects —

```
FAIL ftruncate(fd, 0) releases the extent (...): extent released (offset): 17216 !== 0
FAIL fsync() on a descriptor that is not open is EBADF (...): never-opened fd refused: 0 !== null
```

blockfs suite 15/15 post-fix (fuzzer included, 83 s).

## Image bump: NO — and why

The diff touches `host.js` + `tests/blockfs/` + this log; **zero files under
`os/`**. host.js is a bake *input* (staleness gates re-bake on its mtime) but
its bytes are not baked into the image, and neither fix runs during a bake
(mkimage writes fresh files through `open`/`write`; nothing ftruncates to
zero or fsyncs an invalid fd mid-bake). This is precisely #644's class —
BlockFS behavior change in root host.js, "no image bump (no baked bytes
change)" — and the same call is made here. The kickoff's "touches os/, owes a
bump" premise did not survive contact with the actual diff: the fix landed in
root `host.js`, not under `os/` (the kickoff itself predicted this
possibility, citing #644).
