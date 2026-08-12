# #644 — zero-length write past EOF must be a no-op

## The bug

POSIX write(): "If nbyte is zero and the file is a regular file, the write()
function may detect and return errors ... In the absence of errors ... the
write() function shall return zero and have no other results."

`BlockFS.prototype.write` (host.js) computed `newEnd = writePos + count` and
then ran the whole tail unconditionally — extent growth, the past-EOF hole
zero-fill, the `dataSize` update, and the mtime/ctime bump — before ever
looking at `count`. So `lseek(fd, 1M, SEEK_SET); write(fd, buf, 0)` turned a
5-byte file into a 1 MB file (return value 0, deceptively correct).

Dynamic repro, literal sizes:

- **host BlockFS backend (pre-fix)**: `/probe.txt` seeded at **5** bytes →
  lseek 1048576 → `write(fd, buf, 0)` returns 0 → stat size **1048576**.
- **host BlockFS backend (post-fix)**: **5 → 5**, offset still 1048576,
  fsck_v4 clean.
- **kernel-brokered backend (post-fix, real C over the RPC path)**: the
  test_fs_e2e.js line is literal — `zw pre=5 off=1048576 ret=0 fsize=5
  pos=1048576 pipe0=0 perr=0`.

Why it matters beyond conformance: the file's size and content hash change
with no content change — the exact non-determinism class #633/#639 removed
from the package pipeline, in the filesystem every in-OS build writes through.

## Where the fix landed (five sites, one decision)

The codebase had already decided this shape on the READ side (`_streamRead`'s
0252 R1 short-circuit, host.js `readImpl`, the env pipe read, the kernel tty
read at FS_READ). The write side had none of them. All write paths now answer
consistently:

1. **host.js `BlockFS.prototype.write`, regular-file path** — `count === 0`
   returns 0 after the error checks (EBADF / accmode / EROFS / dead inode —
   POSIX explicitly permits error detection) and before any mutation: no
   extent growth, no hole fill, no dataSize, no mtime/ctime, offset untouched.
2. **host.js `BlockFS.prototype.write`, pipe branch** — 0 before the
   EPIPE/broker path (see the pipe argument below).
3. **host.js env-level pipe write** (`result[ENV_KEY].write`, the in-process
   toWasmEnv pipe) — 0 before the `closed.read` EPIPE check.
4. **kernel.js `Kernel.prototype._streamWrite`** (brokered pipes AND connected
   AF_UNIX sockets) — respond `{n: 0}` before the EPIPE+SIGPIPE check and
   before the space check. Two real defects here, not one: a zero write to a
   FULL pipe used to PARK the writer behind `free === 0`, and a zero write to
   a reader-less pipe used to EPIPE + SIGPIPE (default action kills).
5. **kernel.js `RemoteFS.prototype.write`, SPSC fast-pipe loop** — 0 before
   the PR_FAST loop, mirroring _streamWrite ("the brokered _streamWrite
   rules, verbatim" is that function's own contract): never FS_WAIT on a full
   ring, never the PRF_RGONE EPIPE/SIGPIPE kick.

`Kernel._fsRpc`'s FS_WRITE 'file' arm needed no change: it delegates to
`fs.write` (site 1), and its `dirty`/FSW_MODIFY side effects were already
gated on `wn > 0`.

## The pipe argument (not swept into the regular-file branch)

POSIX is explicit that "shall return zero without attempting any other
action" applies to REGULAR files only; for everything else nbyte==0 is
"unspecified". So the pipe/socket answer is a choice, and gucOS takes
Linux's:

- **Pipes**: fs/pipe.c's `pipe_write` opens with the literal comment "Null
  write succeeds" — `if (unlikely(total_len == 0)) return 0;` BEFORE the
  `!pipe->readers` EPIPE/SIGPIPE check and before any ring-space wait. So on
  Linux a zero write to a broken or full pipe is 0, no signal, no block.
  gucOS now matches on all three pipe transports (in-process ByteQueue,
  brokered _streamWrite, SPSC fast ring).
- **AF_UNIX sockets**: `unix_stream_sendmsg`'s shutdown/EPIPE checks live
  inside the `while (sent < len)` loop, which never iterates for len 0 —
  a zero send returns 0 even peer-closed. Sockets share _streamWrite here,
  so the same early return gives the same Linux-shaped answer. This is why
  sites 2–5 are one shared rule rather than an accident of code sharing.
- The nonzero behaviour is pinned by control legs: a 1-byte write to the
  same reader-less pipe still gets EPIPE (+SIGPIPE at DFL, killing the
  writer), and a full pipe still defers a nonzero writer.

## The device argument (deliberately unchanged)

Devices are also "unspecified" under POSIX, and the existing paths already
take zero-cost, state-free answers, so no code change:

- `_writeDev`: DEV_NULL/ZERO/RANDOM/URANDOM return `count` (= 0) with zero
  state change. DEV_FULL keeps returning ENOSPC even for nbyte==0 — that
  matches Linux, whose /dev/full write handler returns -ENOSPC
  unconditionally (the vfs does not short-circuit zero writes to devices).
- Kernel tty/out/ptm kinds: respond `n: 0`; the empty `_onOutput` chunk /
  `tty.input(empty)` are no-ops. `_ptySlaveWrite` answers EIO when the
  master is gone (device-class error detection, permitted) and a zero write
  can never park there (`buf.length + 0 <= cap` always holds).

## fsck / corpus check (acceptance item)

The pre-fix growth rode `_growExtent` + a normal inode write, so the store
stayed self-consistent: the pre-fix repro's image fscks CLEAN at size
1048576. There is no such thing as an "orphaned extent from the old
behaviour" in any existing corpus image — the damage class was wrong
size/mtime/hash (non-determinism), never store corruption. Nothing to
remediate; the new tests still run fsck_v4 after the repro to pin it.

## Tests

- `tests/blockfs/test_posix.js` +1 case (36 → 37): no-op on regular file
  (size/mtime/ctime/offset, injected clock), O_APPEND flavor, nonzero write
  still hole-fills (hole byte reads 0), in-process pipe null write vs EPIPE
  control, fsck_v4 clean. Red-controlled: pre-fix fails
  `size unchanged: 1048576 !== 5`.
- `tests/kernel/test_fs_e2e.js` +1 section/expect line (section 12, in-file
  checks 21 → 22): the brokered twin with literal sizes, plus the pipe null
  write surviving with SIGPIPE at default disposition.
- `tests/kernel/test_pipes.js` +7 checks (in-file checks 34 → 41): full-pipe
  zero write does not defer, returns 0, fill intact; reader-less zero write
  returns 0 with no SIGPIPE bit; nonzero EPIPE/SIGPIPE control. (Gotcha
  re-learned: one raw RPC payload caps at KP_FS_CHUNK = 60000, so fill and
  drain go in two calls — the existing full-pipe section's shape.)

No image.json bump: no baked bytes change (host.js/kernel.js are served
files, not blob content).
