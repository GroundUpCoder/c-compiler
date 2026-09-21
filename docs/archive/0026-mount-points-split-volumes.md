# 0026 — mount points: split system / user volumes

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/mount-points.md`)
- **Depends**: — (touches host.js symlink walk + both embedders; no open
  item overlaps)
- **Design**: `todos/OS.md` ("Reference build" → first-boot/seeding notes).
  Motivation: first boot — and EVERY image-version bump — recompiles the
  whole seeded world (busybox, doom, quake, gameboy, cc, wm…) because
  system files and user files share one BlockFS store, so the image can
  never be discarded wholesale. Split them and "upgrade" becomes *discard
  and reseed (or blob-write) the system volume, never touch the user
  volume* — the image-merge problem dissolves instead of being solved,
  and a pre-baked `os-system.img` (`tools/mkimage.js`, OS.md's parked
  distribution convenience) becomes trivially safe as a follow-on.

## Goal

A **`MountFS`** wrapper (host.js) delegating by longest-prefix match to N
BlockFS volumes — reference build mounts two: `/` → system volume,
`/root` → user volume. Zero kernel.js changes: the kernel already funnels
every fs access through one object (`_fsRpc` closes over `this._fs`;
`_pathFor` yields absolute paths), and the surface is small — ~26 path/fd
methods plus `_resolvePath`/`_lastError`. `Kernel({fs: mountfs})` just
works; `seedImage` writes through whatever fs it's handed, so
`os-common.js` is unchanged. Each volume stays a complete, independently
fsck-able BlockFS image (fsck/fuzzer need zero changes).

## Plan

- **MountFS** (host.js): mount table, longest-prefix routing with prefix
  strip; own fd namespace mapping fd → `{volume, volFd}` (kernel 'file'
  OFDs already treat the fd as opaque). Path ops delegate; readdir of a
  mount parent needs no synthesis (the mount-point dir exists in the
  outer volume).
- **POSIX edges**: cross-volume `rename`/`link` → `EXDEV` (busybox `mv`
  already falls back to copy+unlink); `rmdir`/`unlink`/`rename` targeting
  a mount point → `EBUSY`.
- **Symlink escape** (the one real design decision, decided at design
  time): absolute symlink targets inside a non-root volume must resolve
  in the FULL namespace, not the volume's. `mountPrefix` option on
  BlockFS: `_walkHops` (host.js:2529), on an absolute target, strips its
  own prefix and continues, or returns an "escaped to `<path>`" sentinel
  that MountFS catches and re-walks on the owning volume (~15–20 lines;
  keeps the single-volume fast path). Component-wise VFS namei rejected —
  re-implements tested walk logic and slows every path op.
- **Embedders**: `os/kernel-worker.js` and `os/boot.js` open two
  workspaces (`os-system.v4.img`, `os-user.v4.img`) and wrap them;
  `/etc/.image-version` lives in the system volume. Migration for
  existing single-store images: none — fresh stores seed the split
  layout; an existing `os.v4.img` keeps working only if we keep the
  single-volume path as a fallback (decide in-item; simplest is
  version-bump + fresh image names, old image left orphaned).
- **Follow-on unlocked (not this item)**: system-volume reseed skips the
  version-gate merge dance entirely; then `tools/mkimage.js` bakes
  `os-system.img` for one-blob virgin boots + fast test fixtures.

## Acceptance

- `tests/kernel/test_mounts.js`: prefix routing (open/stat/readdir across
  both volumes), fd ops on each volume, `EXDEV` on cross-volume
  rename/link, `EBUSY` on the mount point, absolute-symlink escape in
  both directions (user-volume link → `/bin/...` resolves; system-volume
  link → `/root/...` resolves), `_lastError` propagation.
- blockfs suite: `mountPrefix` walk case; both volumes pass `fsck`
  independently after a mixed workload.
- OS boots (headless + browser) on split volumes: seeded /bin content on
  the system volume, hush history / user files under /root on the user
  volume; a version bump reseeds /bin while `/root` files survive
  untouched (the acceptance test for the whole point of the item).
