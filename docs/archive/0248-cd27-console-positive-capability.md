# 0248 — CD27 — console fast path: positive capability, decoys deleted

- **Status**: done (2026-07-17) — console routing keys on `entry.console ===
  true`, set ONLY on BlockFS's three default fd 0/1/2 entries; all four
  detection sites converted (BlockFS close/read/write + toWasmEnv's fd-1/2
  write import, plus __select_impl's stdin scan); RemoteFS's
  `{type:'remote'}` decoys on 0/1/2 and the dead `_pipeBroker`/`_sigcheck`
  ctor inits deleted (`_stdinSab = null` KEPT — read as an always-null guard
  by toWasmEnv's tty imports, todos/0011);
  `tests/host/test_console_capability.js` red→green; host+blockfs+kernel+
  sweep green
- **Design**: —

## Goal

Close code-debt scan CD27 (2026-07-17): the stdout/stderr/stdin "console
fast path" was duck-typed on the ABSENCE of fields — `entry.type ===
undefined && entry.inoId === undefined` (host.js close/write,
toWasmEnv's fd-1/2 write import) and `entry.position === null` (read,
select). Because detection was negative, every foreign fd backend had to
plant DECOYS to opt OUT: kernel.js RemoteFS set `{type:'remote'}` on fds
0/1/2 purely so those entries wouldn't match the absence check. A new
backend (or new fd-creating path) that forgot the decoy silently routed
redirected fd 1/2 to the console — data-level corruption, no error (the
CD5 negative-detection fragility class).

## Plan

- POSITIVE marker: the three default console entries (the one creation
  site, BlockFS ctor) carry `console: true`; every console fast path tests
  `entry.console === true`. Absence now means "not console" — the safe
  default. `_dupEntry` shares the entry object, so the marker survives
  hush's dup/dup2 fd-save dance for free.
- toWasmEnv's write import also drops its `!e → console` branch: a missing
  fd 1/2 entry falls through to `this.write` (BlockFS swallows; RemoteFS
  routes the FS_WRITE RPC) instead of leaking to the console.
- Delete the RemoteFS decoys on 0/1/2 (the positive `{type:'remote'}`
  presence markers on REAL kernel fds stay — they route/guard elsewhere)
  and the verified-dead `_pipeBroker`/`_sigcheck` ctor inits. `_stdinSab`
  stays: toWasmEnv's `__tcsetattr`/pre-override `isatty` read it as a guard
  over RemoteFS, and its null is the todos/0011 "no ring path" contract.

## Acceptance

- `tests/host/test_console_capability.js`: a decoy-less RemoteFS-shaped
  backend's fd-1 write reaches `backend.write` (pre-fix: leaked to console
  — the red proof); default fd 1/2 still hit the console; dup2-redirected
  fd 1 lands byte-exact in the file and restores to console; close(1)
  no-op keeps the slot; default/redirected fd 0 reads route correctly.
- No `type === undefined && inoId === undefined` console inference left
  anywhere; host + blockfs + kernel + browser-sweep suites green.
