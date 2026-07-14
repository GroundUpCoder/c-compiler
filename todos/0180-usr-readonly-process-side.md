# 0180 — serve the sealed /usr volume process-side — read-only fs fast path, no RPC

- **Status**: open
- **Design**: KERNEL.md "What may leave the kernel — the single-writer rule".
  Sibling items: todos/0179 (vDSO page), todos/0181 (SPSC pipes).

## Goal

The `/usr` blob is a SEALED, IMMUTABLE BlockFS image (todos/0040) — and
host.js already contains a complete BlockFS reader. Nothing about reading
immutable data needs the kernel: hand every process the system-volume
store as a shared, read-only mapping and route `/usr` opens/reads/stats
locally. Program startup stops paying one RPC per read for fonts
(term/gdi32 freetype), game assets, `#!` script bodies, openwith/menu
config under /usr/share — the chattiest fs traffic in the system.

## Plan

- Kernel-worker: load the system image into (or copy it once into) an
  SAB; ship it in the process-spawn handshake (the wm-sabs precedent).
  boot.js headless twin does the same with its Buffer.
- host.js RemoteFS grows a local branch: paths resolving under the
  read-only prefix open against a process-local
  `createV4(store, {readonly: true})` over the shared bytes; everything
  else keeps the brokered path. Writes under /usr keep failing EROFS
  after the walk (the /usr/local → /var/local escape must still retry
  brokered — that walk-order rule is load-bearing, todos/0040).
- Symlink escapes to the rw volume (the MountFS `__mountEscape`
  continuation) fall back to the brokered path — correctness first, the
  fast path only serves walks that stay inside the sealed volume.
- fd-table semantics: locally-opened /usr fds still need dup/spawn-
  inheritance/select to behave — decide fd-numbering (a reserved local
  range, or register-with-kernel-lazily on first brokered use e.g.
  dup2-into-stdio or spawn fd-actions).
- Perf proof: count RPCs during a doom boot / term start before vs after;
  bench_fs.js grows a read-only-volume leg.

## Acceptance

- A process reading /usr files issues zero FS RPCs for them (strace);
  mixed workloads (read /usr + write /root) behave identically to today.
- /usr/local writes still land on the rw volume; direct /usr writes still
  EROFS; symlinks crossing volumes still resolve correctly.
- blockfs + kernel suites green; the fs e2e surface unchanged.
