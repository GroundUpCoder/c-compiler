# todos/0180 — the sealed /usr serves itself process-side

Second of the three single-writer-rule items (0179 vDSO → **0180 RO /usr**
→ 0181 SPSC pipes; KERNEL.md "What may leave the kernel"). The insight from
the item: the `/usr` blob is a SEALED, IMMUTABLE BlockFS image and host.js
already contains a complete BlockFS reader — nothing about reading immutable
data needs the kernel's single lane.

## Shape

- **host.js**: `SabByteStore` (read-only byte store over a SharedArrayBuffer;
  `getBytes` copies out because TextDecoder rejects SAB-backed views — the
  directory-name decode would throw) + `storeToSab(store)` (chunked copy).
  No BlockFS core change.
- **kernel.js**: `Kernel({roImage: {prefix: '/usr', sab}})` → forwarded in
  every `procSpec.ro`. `RemoteFS(client, {roFs, roPrefix})` grows the local
  branch; `wrapSpawnHooks` wraps `spawn()` for the fd-action crossing.
- **Embedders**: kernel-worker.js and boot.js build the SAB right after the
  system store exists; process-worker.js and BOOT_SOURCE build the local
  volume and hand it to RemoteFS. Kernels without `roImage` (all existing
  tests, standalone) are byte-identical to before.

## The three design points worth recording

**1. Escape handling reuses the MountFS hooks verbatim.** The process-local
volume gets `_mountPrefix`/`_mountOwns` wired exactly as MountFS would wire
them, so an in-volume symlink resolves in the full namespace and a foreign
target (`/usr/local` → `/var/local`) throws `__mountEscape` — which the
fast path catches and turns into "retry the ORIGINAL path brokered". The
kernel's walk then owns the escape like it always did (the 0040
EROFS-after-walk ordering is untouched because write-intent opens never
take the fast path at all). Local errors are FINAL — the sealed volume is
complete, so ENOENT under /usr is real and costs zero RPCs.

**2. The fd-space split and the promotion.** Local fds are
`RO_FD_BASE (0x100000) + volumeFd`, tracked in a Map (membership check, not
a numeric range test, so a pathological kernel fd in that range still
routes brokered). The kernel never sees them — which is fine until one must
cross: hush's NOMMU redirect journal (`cmd < /usr/share/x`) really opens
the file in the parent (pv_open3), then journals `dup2(fd → 0)` as a spawn
DUP2 file-action whose source the kernel would EBADF. `wrapSpawnHooks`
promotes: open a brokered O_RDONLY twin of the recorded full-namespace
path, seek it to the local offset (immutable volume ⇒ same file by
construction), rewrite the action, close the twin parent-side after the
spawn. A CLOSE action for the twin is appended child-side — but ONLY when
no other action targets that fd number (an action landing at the twin's
number means the fd there is no longer the twin; closing it would destroy
the caller's redirect). Same promotion serves in-process `dup2(local, 0)`.

**3. What deliberately stays brokered.** Relative paths (the kernel owns
the cwd — tracking it process-side is shared mutable state, exactly what
the single-writer rule forbids), every mutator (rename/unlink/chmod/... —
the kernel's EROFS and EXDEV semantics stay authoritative), and any path
whose walk starts outside the prefix (`/etc/fonts/mono.ttf` as a root-volume
symlink into /usr would need a kernel-side "this open landed on the RO
volume" hint to fast-path — noted as a possible piggyback on the FS_OPEN
reply, not built: the default font path IS `/usr/share/fonts/mono.ttf`, and
correctness-first says don't guess).

Bonus finding while testing: BlockFS `dup`/`_dupEntry` reuses the SAME fd
entry object, so file dups share their offset like kernel OFDs — the header
comment initially claimed the opposite; fixed before landing.

## Proof

- `strace cat /usr/share/os-release` in the booted OS is now **FS_WRITE +
  EXIT** — not a single fs RPC for the open/read/close.
- `bench_fs.js` grew the RO leg: /usr reads 496 → **1345 MB/s** (2.7×),
  open+read+stat 71k → **602k ops/s** (8.5×), same C workload.
- `test_rofs.js`: fast-path mechanics vs a fake RPC recorder (zero-RPC
  reads incl. both symlink flavors, final ENOENT, every brokered fallback,
  dup family, both promotion sites, appended-close suppression, no-RO
  identity).
- `test_rofs_e2e.js`: real C under a real kernel — the RPC-op counter
  shows zero fs RPCs for /usr traffic; EROFS after the walk; /usr/local
  escape write lands on /var/local; a posix_spawn DUP2 action on a local
  fd feeds the child's stdin.
- Mixed-workload identity: boot.js and kernel-worker.js now enable the
  fast path globally, so the entire existing kernel + browser estate runs
  over it.
