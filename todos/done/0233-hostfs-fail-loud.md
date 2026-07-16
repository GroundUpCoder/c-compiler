# 0233 — host.js fs fail-loud: --block-fs read clobber, O_APPEND fstat swallow, pipe spurious EOF

- **Status**: done (2026-07-17) — 9999481 (CD1) + a80949d (CD4) + ae775da (CD5); three regression tests in the host suite; unit/host/blockfs/ast green, xfail preserved
- **Design**: —

## Goal

Close the three silent-data-loss / silent-wrong-data bugs in host.js's
filesystem layer found by the 2026-07-16 code-debt scan (CD1, CD4, CD5) —
make each FAIL LOUD instead of silently losing or corrupting data, per the
repo's "failure must point at its cause" doctrine.

- **CD1** — the `--block-fs=path` CLI path swallows ANY `readFileSync`
  failure, falls through to a fresh empty image, and the `writeFileSync`
  at exit OVERWRITES the original. A transient EACCES/EIO on startup
  destroys the user's image. Fix: catch ONLY ENOENT (the legitimate
  new-image case); anything else → loud stderr + exit(1) before a store
  is ever created.
- **CD4** — `createFileSystem`'s O_APPEND open swallows fstat failure via
  an uncommented empty catch, leaving `entry.position = 0`: "append"
  reads/seeks operate from offset 0 — silent wrong data. (The repo's other
  empty catches are commented deliberate teardown swallows — untouched.)
  Fix: fstat failure fails the open (setErrno, closeSync, -1); the
  post-write position resync surfaces its failure too.
- **CD5** — the native-fs pipe read returns 0 ("EOF") on an empty buffer
  while the write end is still open — a reader racing a writer silently
  truncates its stream (the 0171 bug class). Fix: mirror the stdin waiter
  pattern — block on a per-pipe waiter list resolved on write/close;
  return 0 only when `pipe.closed.write`.

## Plan

- Fix all three in host.js (host-side only — NO image bake).
- Regression tests in tests/host/: CD1 = unreadable image errors loudly +
  original bytes survive, ENOENT still creates; CD4 = O_APPEND open fails
  when fstat fails (no write at offset 0); CD5 = read on an empty pipe with
  a live writer blocks until data/close instead of spurious EOF.

## Acceptance

- `node tests/run.js` all green, xfail counts preserved.
- New tests red on the pre-fix host.js, green after.
