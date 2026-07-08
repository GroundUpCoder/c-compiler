# 0026 — mount points: split system / user volumes (MountFS)

**Item**: `todos/0026` (now in `todos/done/`). **Why**: every image-version
bump recompiled the whole seeded world (busybox, doom, quake, cc, wm…)
because system and user files shared one BlockFS store — the image could
never be discarded wholesale. Split them and "upgrade" becomes *reseed (or
discard) the system volume, never touch the user volume*: the image-merge
problem dissolves instead of being solved, and a pre-baked `os-system.img`
(`tools/mkimage.js`) becomes trivially safe as a follow-on.

## What landed

- **`MountFS`** (host.js, exported from `BLOCK_FS`): a mount table over N
  BlockFS volumes — longest-prefix routing with prefix strip, own fd- and
  dir-handle namespaces (`fd → {volume, volFd}`; the kernel's 'file' OFDs
  treat the fd as opaque, so `Kernel({fs: mountfs})` needed **zero kernel
  changes**, as designed). POSIX edges: cross-volume `rename`/`link` →
  `EXDEV` (busybox `mv` falls back to copy+unlink), `unlink`/`rmdir`/
  `rename` on a mount point → `EBUSY`. Mount-point directories are
  materialized in the outer volume at construction, so `readdir('/')`
  lists `root` with no synthesis.
- **Symlink escape** (the one real design decision, decided in the item):
  targets resolve in the FULL namespace. Each volume gets
  `_mountPrefix`/`_mountOwns` hooks; `_walkHops` resolves a symlink target
  through them — in-volume targets strip back to volume-relative and stay
  on the tested single-volume walk (the fast path), foreign ones **throw**
  `__mountEscape` carrying the full-namespace continuation. `_walkPath`
  tags the throw with the path that walk was given (`__mountFrom`);
  MountFS's dispatch loop rewrites the matching path argument and retries
  on the owning volume, bounded by `SYMLOOP_MAX`.
- **Relative targets too**: they're joined under the volume's mount prefix
  before the ownership check, so `/root/rel → ../etc/passwd` correctly
  climbs over the mount root into the system volume (a case the original
  absolute-only sketch would have clamped at the volume root).
- **Embedders**: `os/boot.js` opens `os-system.img` + a derived
  `…-user.img` sibling (`--image=` names the system one; new
  `--fresh-system` discards just the system volume); `os/kernel-worker.js`
  opens `os-system.v4.img`/`os-user.v4.img` workspaces. `os-common.js`
  unchanged — seedImage writes through whatever fs it's handed and the
  routing sends `/root/...` (doom1.wad, pak0.pak, ROMs — most of the image
  by bytes!) to the user volume automatically.
- `createV4(store, {noDevNodes})` + `openWorkspace({noDevNodes})`: the
  user volume skips the `/dev` self-heal — it would surface as `~/dev`
  clutter (hush starts in /root); `/dev` is served by the system volume.
- `image.json` v20 → **v21** so anyone reusing a pre-split image via an
  explicit `--image=` gets a reseed that populates the now-separate user
  volume's seeded files.

## Why throw-and-retry, not VFS namei

Component-wise namei at the MountFS layer was rejected at design time
(re-implements the tested walk, slows every op). The alternative had a
subtlety worth recording: an escape can surface from a **parent-directory
walk** inside a multi-walk op (`open(O_CREAT)`, `mkdir`, `rename` walk
parents separately), so the naive "redispatch the op on the escaped path"
is wrong — the escaped path may be the *parent's* continuation. Two facts
make the retry correct anyway: (1) every BlockFS op walks all its paths
via `_walkPath` **before mutating anything**, so a throw aborts with no
partial state (e.g. `open(O_CREAT)` through a final escaping symlink
would otherwise insert a duplicate dirent); (2) escape splicing is
prefix-stable, so rewriting any op argument that has the escaped walk's
path as a prefix produces exactly what the longer walk would have — the
parent-walk case reduces to a prefix rewrite, and two-path ops (rename
with only one escaping side) settle iteratively, converging on `EXDEV`
when the real locations differ.

## Gotchas / notes

- `openWorkspace`'s legacy-migration default (`v3Name: 'workspace.img'`)
  would have "migrated" a standalone page's workspace into BOTH OS volumes
  on a shared origin; the worker now pins explicit never-existed v3 names.
- Volumes have **duplicate inode numbers** (both roots are ino 1) and
  there's no `st_dev`; nothing in-OS compares inos across volumes today,
  but it's a known sharp edge.
- The per-volume open-refcount limitation (unlink-while-open across two
  live instances) is unchanged — MountFS routes each path to exactly one
  instance, so the split adds no new instance-coherence surface.
- Acceptance: `tests/kernel/test_os_boot.js` now lowers
  `/etc/.image-version` in-OS, reboots, and asserts the reseed runs while
  `/root` files survive — plus the `--fresh-system` variant. Unit
  semantics in `tests/kernel/test_mounts.js`; walk mechanics + both-volume
  fsck in `tests/blockfs/test_mounts.js`.
