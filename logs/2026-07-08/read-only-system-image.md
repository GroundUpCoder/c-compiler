# 0040 lands: the read-only system image (mkimage + the layout flip)

Implements `todos/DISK-IMAGE.md` end to end in one round: the OS now boots
from a **sealed, read-only system blob mounted at /usr** over a **writable
root volume at /**, and an upgrade is literally "replace one file".

## What landed

1. **host.js `readonly` volume flag** — `createV4(store, {readonly: true})`
   mounts an existing v4 image read-only: every mutating op returns EROFS,
   the store is wrapped in `ReadOnlyStore` (throw-on-write backstop), an
   unformatted store throws instead of formatting. Plus `sealVolume`/
   `verifySeal` (superblock flags bit 1 + SHA-256 of everything after the
   superblock at offset 36; WebCrypto, async) and an independent recheck in
   `fsck_v4.js`.
2. **The bake pipeline** (`os/os-common.js`): `seedImage` → `seedEntries`
   (the `/etc/.image-version` gate is DEAD), `bakeSystemImage` (replays the
   runtime mount layout with a throwaway root volume so manifest paths and
   cc diagnostics are full-namespace; plants `/usr/local → /var/local` and
   `/usr/share/os-release`, then seals), `bakedVersion` (the staleness
   gate), `initRootVolume` (skeleton dirs + `/bin → /usr/bin`), and
   `NodeFileStore` moved here from boot.js (mkimage shares it).
3. **`tools/mkimage.js`** — offline bake to `os/os-system.img` (gitignored),
   post-verifies seal + version. ~7s wall for the full v26 image (2.3 MiB:
   hush, coreutils, doom, quake, gameboy, term, wm…).
4. **The flip in both embedders** — boot.js: bake-on-stale (strictly
   `bakedVersion < manifest.version`; a NEWER blob is kept — that's the
   upgrade), root volume as `-root.img` sibling, user seed only on a
   freshly created root volume. kernel-worker.js: OPFS `os-system.v5.img` +
   `os-root.v5.img` (pre-flip v4 images orphaned, the 0026 precedent);
   materialize prefers fetching a prebaked `os-system.img` served beside
   the page (superblock-last copy so a crash mid-copy reads as stale), else
   bakes in-worker. `PATH=/usr/local/bin:/bin` everywhere.
5. **systemd-style /etc** — `image.json` v26 splits `system`/`user`;
   menu + fonts moved to `/usr/share`; wm.c reads `/etc/menu` if the dir
   exists else `/usr/share/menu` (first-existing-dir, no union merge) and
   resolves bare menu argv[0] through `/usr/local/bin` first; term.c falls
   back `/etc/fonts/mono.ttf` → `/usr/share/fonts/mono.ttf`. An EMPTY /etc
   boots; factory reset = wipe /etc + /var.

## Decisions made in-item (recorded in DISK-IMAGE.md)

Blob version = `/usr/share/os-release` `VERSION_ID` (written LAST in the
bake → crash-safe staleness); user assets seed once on a fresh root volume
(no version gate, ever); live-seed survives as the automatic bake fallback
(no dev flag); seal = flags bit + SHA-256 at superblock offset 36.

## Gotchas hit

- **EROFS guards must run AFTER the path walk.** First cut guarded at the
  top of each op and `/usr/local/bin/x` (a path that only LOOKS like it's
  on the RO volume) failed EROFS instead of escaping to `/var/local`. The
  fix places every guard after `_walkPath` — which is also exactly the
  repo's existing "walk all components before mutating" ordering. Locked
  in by `tests/blockfs/test_readonly.js` (escaping-mutator leg).
- **Aliased two-path ops are EXDEV**: `mv` inside `/usr/local` rewrites
  only the escaped argument, so the pair routes to different volumes.
  Pre-existing MountFS lazy-resolution behavior, not a readonly
  regression; busybox mv falls back to copy+unlink. Documented, tested.
- The legacy v3 read-only view now refuses writes with clean EROFS errno
  instead of a thrown Error (strictly better; two blockfs tests updated).
- `write()` never checked the fd's open mode — on a RO volume a
  read-only fd could have written. Guarded in `write`/`ftruncate` too.

## Test surface

- New `tests/blockfs/test_readonly.js` (11 legs); fsck_v4 seal check;
  kernel `test_mounts.js` 0040-layout legs (EROFS over the RPC surface,
  /bin symlink, /usr/local escape).
- `test_os_boot.js` rewritten around the new contract: bake + user-seed
  logs, `ls /` = `bin dev etc root run tmp usr var`, EROFS via /bin and
  /usr, a REAL upgrade leg (mkimage bakes v(N+1) against a bumped
  manifest, swap, boot: kept, user files/etc-override/admin tool all
  survive), factory reset boots identically, `--fresh-system` re-bakes.
- `os-shell.mjs` gains the `/etc/menu` override-wins leg (one-entry menu).
- Green: unit 697✓, blockfs suite✓ (incl. fuzz), full kernel suite✓,
  browser sweep (serial) — see thread notes.

## Follow-ons enabled

0037's module cache gets its cache key for free (`VERSION_ID` of the
sealed blob). The prebaked-blob fetch path means a hosted os.html can boot
with zero compilation; publishing a blob next to the page is all it takes.
