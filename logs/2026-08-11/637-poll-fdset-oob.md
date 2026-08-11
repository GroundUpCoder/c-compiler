# #637 — poll() / FD_* macros out-of-bounds for fd ≥ FD_SETSIZE

## Reproduced (not just source-confirmed)

The injected `<sys/select.h>` defines `FD_SETSIZE 64` and an `fd_set` of
`unsigned long fds_bits[FD_SETSIZE / (8*sizeof(unsigned long))]`. Measured for
this target: `sizeof(unsigned long) == 4`, so `fds_bits` is **2 words / 8 bytes
/ 64 bits**. The first out-of-range fd is **64** (word index 2 of a 2-word
array). `poll()`'s only fd filter was `if (fd < 0) continue;`, so any fd ≥ 64
indexed `fds_bits` past the end of a **stack-local** struct in both the SET and
the ISSET loop.

A compiled program (driven through this tree's `compiler.js`+`host.js` with a v4
BlockFS, the same env as the `blockFs:true` unit tests) demonstrated all three
failure modes:

- **OOB write** — a pattern-filled `guard[512]` local placed in the same frame
  as `poll()`'s inlined `fd_set`s: `poll(fd=1000)` set `guard[19]`
  (`clobbered_words=1 first_word=19`); the low-fd controls (0/3/63) clobbered
  nothing.
- **OOB read / false ready** — `poll(fd=1000, POLLIN|POLLOUT|POLLPRI)` on an
  fd that was never opened returned `1` with `revents=0x7` (reported the
  non-existent fd as ready for read+write+pri).
- Exit code 0 throughout — the OOB stays inside wasm linear memory, so it
  corrupts adjacent stack rather than trapping. That is what makes it
  dangerous: silent frame corruption, not a crash.

## Reachability (step 2)

Direct `select()` callers in shipped gucOS each poll ONE low fd: `wm.c` (the wm
socket), `term.c` (a pty master), `user32.c` (the agent socket), `gcode.c`
(stdin + a pipe). `poll()` callers: `gcode.c` (2 fds), busybox `shell_common.c`
(1 fd read-timeout), `user32` `agent_poll`. Vendored `cpython`
`selectmodule.c` **self-guards** — `_PyIsSelectable_fd` raises `ValueError`
"filedescriptor out of range in select()" for fd ≥ `FD_SETSIZE`, so the most
likely high-fd consumer never reaches the macros. No shipped program is known
to poll/select an fd ≥ 64 today — **but** fds ≥ 64 are reachable in this runtime
(the BlockFS tests open many), and `poll()` is precisely the primitive ported
POSIX software reaches for *because* it has no `FD_SETSIZE` limit, so an
unenforced limit here silently corrupts a future/ported program's stack.

## Fix — option (a), bounds-check, ABI-preserving

Chosen from the reachability measurement + the cross-side hazard. The three
`fd_set` backends (`host.js:898` Suspending, `host.js:4665` plain,
`kernel.js` `selectImpl`) all hardcode 2 words / `fd<64`. Widening `FD_SETSIZE`
(option b) is a coordinated multi-backend ABI change **and still leaves a cliff**
(at 1024); truly unlimited `poll()` needs a new non-`fd_set` syscall import
(genuinely high complexity — surfaced to the coordinator, not done halfway).

The fix lives where the bug lives — the macros:

- `FD_SET`/`FD_CLR`/`FD_ISSET` bounds-check `(unsigned long)(fd) < FD_SETSIZE`
  (the `(unsigned)` fold rejects negatives too). Out-of-range → a no-op / reads
  0 instead of touching memory past the struct. This makes **both** `poll()` and
  every direct `select()` caller's `FD_SET` memory-safe.
- `poll()` additionally sets `POLLNVAL` in `revents` for an fd ≥ `FD_SETSIZE`
  (POSIX's answer for an invalid fd), counts it, and does not block on it (an
  invalid fd is an immediate event). The header comment now states the limit is
  **enforced**, not merely documented.

Post-fix the repro shows `clobbered_words=0` for every fd and `revents=0x20`
(POLLNVAL) for fd ≥ 64, low fds unchanged.

## Regression

`tests/unit/stdlib/poll_highfd/` — the high-fd line is FIRST and load-bearing:
it asserts `nval=1`, a value the pre-fix ISSET loop **cannot** produce for a
POLLIN request (it only ORs POLLIN/POLLOUT/POLLPRI, never POLLNVAL=0x20). At
base `b2d997aa` the same `.c` (compiled with the base `compiler.js`/`host.js`)
prints `highfd n=1 nval=0 other=1` (exit 0 — a valid red, not a signal); at the
fix it prints `nval=1 other=0`. Includes a low-fd positive control and a mixed
in-range/out-of-range call.

## Gate

25 suites (the `compiler.js` blanket diff rule). All green against baseline:
unit 826/0/3 (+1, my test), kernel 173/173, sweep 59/59, blockfs 15/15, host
exit 0, projects 29/0/1, plus every run.py category. Tip `ab23cb28`.
