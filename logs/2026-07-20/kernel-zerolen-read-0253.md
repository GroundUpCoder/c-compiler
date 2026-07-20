# 0253 — kernel-brokered zero-length reads must return 0, not park

`todos/0253`. Branch `fix-0253-zerolen-read`. Sibling P0 to the 0252 R1 class,
found during that scrub but out of its host.js-only scope.

## The bug

POSIX: `read(fd, buf, 0)` transfers no data and returns 0 immediately — never
blocks. The 0252 R1 fix covered the host.js (in-process) side, but the
**kernel-brokered** path still parked count-0 reads on an empty stream with a
live writer:

- `kernel.js _streamRead` (pipes / sockets / pty master): the guard was
  `avail > 0`, so an empty stream with `wOpen` fell straight into the
  `piperead` waiter enqueue — even for count 0.
- the `tty` branch of `FS_READ`: with no cooked bytes it queued a `ttyread`
  waiter regardless of count.

A brokered process doing a feature-probe `read(fd, buf, 0)` on an empty
pipe/socket/pty/tty hung until unrelated input happened to arrive.

## The fix (kernel.js only — a STATIC asset, no image bump)

Two early short-circuits, each BEFORE any avail-check / waiter-enqueue:

- `_streamRead` top: `if (count === 0) { respondRaw(pcb, []); return; }` —
  one site covers all three stream kinds (pipe, socket, ptm) since they all
  route through it.
- `tty` FS_READ branch: the same guard, placed ahead of the job-control
  (SIGTTIN) check. A zero-length read moves no bytes, so returning 0 without
  touching job control is the simple conforming choice (the plan doc's call;
  Linux permits it).

**Scoped to the stream/tty path — the 0140 regular-file read-fill is
untouched.** Count 0 on a `file` OFD already flows through
`fs.read(bfsFd, buf, 0) → 0` in a separate branch; the two never interact.

## Test

`tests/kernel/test_zerolen_read.js` (registered in `tests/kernel/run.js`) —
fake-worker kernel test (test_pipes/test_pty/test_sockets pattern, no wasm).
For each brokered kind — pipe, socket, pty master (`ptm`), tty (pty slave) —
with an empty stream and a LIVE writer:

- a count-0 FS_READ returns immediately (`!pending()`), 0 bytes;
- a count>0 FS_READ on the same empty stream STILL defers, then wakes on a
  real cross-process write (blocking semantics unchanged).

Gotchas hit while writing it:
- A parked count>0 read and its wake-write must be on DIFFERENT processes (a
  process with a deferred RPC in flight can't issue another — the pipe leg
  needed a child reader with init as the writer; the pty/socket legs already
  had distinct reader/writer procs).
- `kfs.mkdir('/tmp')` before boot — AF_UNIX bind targets need the dir, else
  bind → ENOENT → listen EDESTADDRREQ → accept EINVAL.

Red→green confirmed: against the unfixed kernel the count-0 read hangs forever
(the park); with the fix all 20 checks pass. Full kernel gate green
(97 files; test_os_boot is the slow ~333s+ 3-bake leg).
