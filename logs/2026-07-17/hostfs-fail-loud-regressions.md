# 0252 — two regressions in the createFileSystem fail-loud cleanup (CD4/CD5)

An adversarial review of yesterday's 0233 code-debt commits found two HIGH
regressions in host.js's native-fs flavor — both cases of a fix over-rotating:
the cure (block / fail loud) applied to a case where POSIX wants the opposite.

## R1 — zero-length pipe read deadlock (regression on CD5, ae775da)

CD5 correctly made the pipe read BLOCK on an empty buffer with a live writer
(the spurious-EOF/stream-truncation fix). But `read(fd, buf, 0)` — the
classic feature-probe — enters the same wait loop: empty + writer-open →
parks on the waiter list until an unrelated write/close. POSIX: a
zero-length read returns 0 IMMEDIATELY.

Fixed as a class, not a line: `count === 0` early-returns 0 at the top of
the pipe branch AND at the top of `readImpl` — the stdin path had the exact
same gap (empty `stdinBuf`, no EOF → parked on `stdinWaiters`; it also
never needs to touch `process.stdin` for a probe). The two `fs.readSync`
paths already returned 0 for a zero-length view; they now skip the syscall
too. Elsewhere: BlockFS's same-instance pipe read is synchronous 0-on-empty
(the deliberate CD5 exemption — fine), but the KERNEL-brokered path
(`_streamRead`, tty `FS_READ`) parks count-0 reads the same way — that's
kernel.js, out of this item's scope, filed as todos/0253.

## R2 — O_APPEND reported a COMMITTED write as failed (regression on CD4, a80949d)

CD4 replaced the swallowed post-append-write resync failure with "fall
through to the outer catch → -1". But the sequence is `writeSync` (bytes
COMMITTED) then `fstatSync` (position resync): a throw in the second step
turned a successful write into a reported failure. A caller that retries —
the normal reaction to a failed write — appends the data twice.

The invariant: never report a committed write as failed. The append branch
now keeps the committed `n` and marks the entry `positionUnknown`; a new
`ensurePosition(entry)` gates EVERY consumer of `entry.position` (positioned
read, positioned write, SEEK_CUR) — it lazily re-fstats (a transient failure
self-heals; correct for an append fd, whose tracked position is EOF-synced
by definition) or fails loud with the fstat errno. SEEK_SET/SEEK_END and a
successful resync clear the flag.

Deliberately NOT reused: the `position === null` sentinel. That means "not
seekable" — lseek answers ESPIPE and reads go unpositioned — which would
silently flip a regular file into pipe-shaped semantics. Broken-position is
a distinct, recoverable state.

Sibling sites audited clean: the open-time append fstat fails the OPEN
before anything commits (CD4's fix, correct); the positioned write's throw
means no bytes were reported committed; SEEK_END's fstat has no commit in
flight; BlockFS's append write positions off `ino.dataSize` synchronously —
no post-commit stat exists to fail.

## Tests

Both 0233 regression tests grew the new legs (red pre-fix, green post):
`test_pipe_read_block.js` — count-0 on empty-pipe-live-writer HUNG pre-fix,
returns 0 now; `test_append_fstat_fail.js` — its old leg 2 asserted the
buggy -1 and was rewritten to the invariant (write returns n; SEEK_CUR and
positioned read fail loud on the broken position, resync once fstat
recovers, and readSync is proven never to run with a stale offset).

Gate: unit + host + blockfs + kernel, all green foreground. host.js runtime
only — no image, no os/ C, no codegen (no SameBoy interlock).
