# 0180 — serve the sealed /usr volume process-side — read-only fs fast path, no RPC

- **Status**: done (2026-07-14) — the embedder copies the sealed system
  image into ONE SAB (`BLOCK_FS.storeToSab`; new `SabByteStore` — getBytes
  copies out, TextDecoder rejects SAB views) and hands it to
  `Kernel({roImage: {prefix: '/usr', sab}})`; every spawn forwards it
  (`procSpec.ro`) and the worker mounts it locally (createV4 readonly).
  RemoteFS serves absolute paths lexically under the prefix in-process:
  zero RPCs for open/read/lseek/fstat/close, stat/lstat/access/readlink,
  opendir/readdir — `strace cat /usr/share/os-release` is now FS_WRITE +
  EXIT. Cross-volume symlink escapes reuse the MountFS `__mountEscape`
  hooks and retry brokered; write-intent opens, mutators, and relative
  paths stay brokered (the kernel keeps EROFS-after-the-walk and the cwd);
  local errors are final. Local fds live at `RO_FD_BASE` (0x100000, Map
  membership routing) and PROMOTE to a temporary brokered O_RDONLY twin at
  the same offset at the two kernel crossings: in-process dup2-to-low-fd
  and spawn DUP2 file-actions (`wrapSpawnHooks` — hush's `cmd < /usr/...`
  vfork journal; the child-side twin gets an appended CLOSE action unless
  another action targets that fd number). Documented limits: un-actioned
  local fds are effectively close-on-exec; select/WAIT can't name one
  (number exceeds FD_SETSIZE; regular files always ready). Found & fixed
  en route: nothing — but recorded that BlockFS `_dupEntry` SHARES the fd
  entry (POSIX OFD offset sharing), contrary to first assumption. Perf
  (bench_fs.js's new RO leg): /usr reads 496→1345 MB/s, open+read+stat
  71k→602k ops/s. Wired everywhere: kernel-worker.js, boot.js,
  process-worker.js, BOOT_SOURCE — the whole existing estate now runs over
  the fast path. Not taken, recorded: a kernel hint on FS_OPEN replies so
  root-volume symlinks INTO /usr (e.g. a hypothetical /etc/fonts link)
  could fast-path after one RPC — the default font/config paths are
  already direct /usr/share paths, so it buys little today. Tests:
  `test_rofs.js` + `test_rofs_e2e.js`. Dev log:
  `logs/2026-07-14/rofs-fastpath.md`.
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
