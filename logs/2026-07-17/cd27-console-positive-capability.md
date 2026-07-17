# CD27 — console fast path becomes a positive capability (todos/0248)

The stdio "console fast path" — the routing that sends a never-redirected
fd 1/2 write to the terminal and serves fd 0 from the stdin buffer/ring —
was detected by the ABSENCE of fields: `entry.type === undefined &&
entry.inoId === undefined` (BlockFS close/write and toWasmEnv's fd-1/2
write import) and `entry.position === null` (BlockFS read, __select_impl's
stdin scan). Negative detection forces every OTHER fd backend to opt out
by decoration: kernel.js RemoteFS planted `{type:'remote'}` decoys on fds
0/1/2 whose only stdio purpose was to NOT look like the console. Forget
the decoy in a new backend and redirected stdout/stderr silently lands on
the console — data corruption with no error, the same fragility class as
CD5's dead-end branch.

## The fix

- One creation site, one marker: BlockFS's three default fd 0/1/2 entries
  (the ctor) now carry `console: true`; every console fast path tests
  `entry.console === true`. Absence means "not console" — the safe
  default. Five sites converted: close (fd<3 no-op keep), read (stdin
  branch), write (fd 1/2 swallow-for-external), toWasmEnv's write import
  (writeOut/writeErr), and __select_impl's stdin-readiness scan.
- The marker rides dup naturally: `_dupEntry` returns the SAME object for
  non-pipe entries, so hush's fd-save dance (dup(1) → dup2(file,1) →
  dup2(saved,1)) restores a still-marked console entry. No per-call
  sprinkling anywhere.
- toWasmEnv's write import also dropped its `!e → console` branch (no
  entry at fd 1/2 used to leak to the console; now it falls through to
  `this.write` — BlockFS swallows, RemoteFS sends the FS_WRITE RPC). That
  branch was the reason the decoys were load-bearing.

## What was deleted vs kept in RemoteFS (verify-first)

- DELETED: the three `{type:'remote'}` decoys on fds 0/1/2. Traced every
  reader of `RemoteFS._fdTable` in shared code: toWasmEnv's write import
  (now positive), `__fcntl3` F_GETFL (short-circuits at `fd <= 2`), and
  `__select_impl`'s scan (replaced by `rfs.selectImpl` in
  process-worker.js). RemoteFS's own methods only write/delete entries or
  presence-guard (`registerPipeRing`). The `{type:'remote'}` markers on
  REAL kernel fds (open/dup/pipe/socket results) are untouched — those
  are positive presence records, not decoys.
- DELETED: `this._pipeBroker = null` (reads live only in BlockFS.prototype
  methods RemoteFS replaces wholesale) and `this._sigcheck = null`
  (toWasmEnv assigns it unconditionally right after construction; its
  reads sit in BlockFS._readStdinSab and toWasmEnv's __select_impl, both
  unreachable/replaced for RemoteFS).
- KEPT: `this._stdinSab = null` — it IS read over RemoteFS as an
  always-null guard by toWasmEnv's `__tcsetattr`/`__tty_setattr` (and
  isatty before the process-worker override), and the null is the
  todos/0011 contract ("guard on _stdinCtrl, NOT _stdinSab"). Kept
  `_stdinCtrl` too, which is plainly live (winsize words).

## Red→green

`tests/host/test_console_capability.js` drives toWasmEnv over a
RemoteFS-shaped backend with an EMPTY fd table — the forgotten-decoy
scenario. At the pre-fix HEAD the fd-1 bytes landed in the captured
console (`out="to-the-backend"`) and never reached `backend.write`;
post-fix they route to the backend with the console untouched. The same
file pins the preserved semantics: default fd 1/2 → console, redirect →
byte-exact file content, dup/dup2 restore, close(1) no-op, stdin
buffer/redirect reads.

Gate: host + blockfs + kernel (76 files — every e2e's stdout now flows
through the decoy-less path) + browser sweep (27 files), all green,
foreground. No compiler.js/os-C/image change — pure host.js/kernel.js
runtime routing, no bake, no SameBoy interlock.
