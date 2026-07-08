# 0040 — read-only system image: mkimage + the layout flip

- **Status**: done (2026-07-08; dev log
  `logs/2026-07-08/read-only-system-image.md`; in-item decisions
  recorded in `DISK-IMAGE.md`)
- **Depends**: 0026 (landed). Complements 0037 (blob version = module
  cache key). Subsumes the old unnumbered `tools/mkimage.js` entry.
- **Design**: `todos/DISK-IMAGE.md` (decisions settled 2026-07-08 —
  read-only baked system volume at /usr, merged-usr /bin symlink,
  /usr/local → /var/local, systemd-style /etc, swap-the-blob upgrades)

## Goal

Upgrades become "replace one read-only blob": `tools/mkimage.js` bakes
the system volume offline; the mount layout flips (writable root volume
at `/`, RO system volume at `/usr`); /etc goes systemd-style (defaults
under /usr/share, empty /etc boots). All decisions + rationale in
DISK-IMAGE.md — this item is the implementation.

## Plan (stages; split into follow-on numbers if any stage lands alone)

1. `readonly` volume flag in host.js (EROFS on any mutating op) +
   MountFS pass-through; fsck unchanged-blob check. Tests in
   `tests/blockfs/` + `tests/kernel/test_mounts.js`.
2. `tools/mkimage.js` — drive the os-common.js seed pipeline offline
   against a fresh image file; blob carries its own version. Fast test
   fixtures become a side benefit (boot tests mount a prebaked blob).
3. The layout flip in both embedders (kernel-worker.js + boot.js):
   root volume at `/` (devNodes on, skeleton dirs, `/bin → /usr/bin`
   symlink), system blob RO at `/usr`. New image names orphan old OPFS
   images (0026 precedent).
4. /etc convention: wm.c menu (`/etc/menu` else `/usr/share/menu`),
   term font (`/etc/fonts/…` else `/usr/share/fonts/…`); image.json
   /etc entries move to /usr/share; PATH=/usr/local/bin:/bin in wm.c
   spawns; empty-/etc boot verified.
5. Decide in-item (recorded in DISK-IMAGE.md when decided): blob
   version location, virgin-boot user-volume asset seeding (doom1.wad),
   whether live-seed survives as a dev flag.

## Acceptance

- Virgin boot (browser + headless) from a baked blob: no compilation
  on the boot path; empty /etc; everything in the os-shell sweep works.
- Upgrade test: boot v(N), write user files (/root, /etc override,
  /usr/local/bin binary), swap in blob v(N+1) → user files intact,
  /etc override still wins, EROFS on writes under /usr.
- Factory-reset test: wipe /etc + /var → boots identically.
- Full suites green (unit, blockfs incl. readonly/fsck legs, kernel,
  browser sweep serially).
