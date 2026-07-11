# DISK-IMAGE.md — the read-only system image & upgrade discipline

Design, 2026-07-08 (queued: `todos/0040`; subsumes the old unnumbered
`tools/mkimage.js` entry). Builds on 0026's MountFS split. The question
this answers: how do upgrades replace system content without ever
touching user data, and where may users put things without colliding
with the system?

**Prior art this deliberately copies**: macOS's sealed read-only system
volume + writable data volume; Android/ChromeOS image-swap (A/B)
upgrades; the FHS `/usr/local`-is-the-admin's contract; systemd's
"stateless system" convention (vendor defaults under /usr, /etc holds
only user overrides, an EMPTY /etc must boot). Overlayfs-style
copy-up was considered and rejected: a user's upper-layer copy shadows
every future system update of that file — the exact conflict class this
design exists to eliminate.

## Decisions (settled 2026-07-08 — don't re-litigate without new evidence)

1. **System content ships as ONE pre-baked, read-only volume blob.**
   `tools/mkimage.js` runs the existing `os-common.js` seed pipeline
   (image.json → cc-compiled sources, vendor builds, blobs) OFFLINE
   under Node against a fresh image file. The blob is a normal BlockFS
   image — independently fsck-able, mountable read-only. No build-step
   change of philosophy: sources are still compiled by our own cc, just
   at bake time instead of first boot.

2. **Upgrade = swap the blob. Nothing else.** No reseed, no version-gate
   merge dance, no copying into place beyond materializing the blob
   (browser: one byte-copy into OPFS; headless: it's just a file). The
   writable volume is never touched by an upgrade. Rollback = keep the
   old blob. `/etc/.image-version` and the seed-gate logic die with
   this; the blob carries its own version (file inside the image or
   superblock label — decide in-item), which also becomes the natural
   cache key for the 0037 wasm module cache.

3. **The mount layout flips: writable volume at `/`, read-only system
   volume at `/usr` (merged-usr).**
   - Root (user) volume owns `/` — so `/etc`, `/var`, `/tmp`, `/root`,
     `/dev`, `/run` are writable for free, with no extra volumes and no
     multi-prefix aliasing. It gains devNodes (its `/dev` IS /dev now);
     the system volume mounts `noDevNodes`-equivalent (it has no /dev).
   - System volume owns `/usr`: `/usr/bin` (everything now in /bin),
     `/usr/share` (vendor defaults: menu, fonts, factory skeletons).
   - **`/bin` is a symlink → `/usr/bin`** on the root volume, resolved
     by the existing full-namespace symlink-escape machinery (0026) —
     every `/bin/sh`, `/bin/cc`, PATH=/bin reference keeps working
     unchanged. Zero new walk logic.

4. **The admin's territory is `/usr/local` → `/var/local` (baked
   symlink).** `/usr` is read-only, so `/usr/local` inside it is a
   symlink pointing back into writable territory — again pure existing
   escape machinery. `PATH=/usr/local/bin:/bin`: user-installed
   binaries deliberately win over system ones; upgrades can never
   conflict with them because upgrades never write outside the blob.
   Users who shadow `/bin/foo` do it by *choice of PATH order*, not by
   overwriting system files (which now EROFS).

5. **/etc is systemd-style: user overrides only, defaults elsewhere,
   empty /etc boots.** Vendor defaults live under `/usr/share/…`;
   programs look in `/etc` first and fall back:
   - wm.c menu: `/etc/menu` if present, else `/usr/share/menu`
     (first-existing-dir wins, no union merge — simplicity over
     drop-in semantics until something needs more).
   - term font: `/etc/fonts/mono.ttf`, else
     `/usr/share/fonts/mono.ttf`.
   - The same rule applies to future config consumers: check `/etc`,
     fall back to `/usr/share`, NEVER require /etc to exist.
   `/etc` starts empty on a virgin boot. **Factory reset = wipe /etc
   (and /var)** — the system must boot identically afterward. Upgrades
   never write /etc, so user edits never conflict.

6. **Read-only is enforced, not conventional.** A `readonly` option on
   the volume (BlockFS open flag honored by MountFS routing): any
   mutating op → `EROFS`. This is what makes "users manually put stuff
   in /bin" a non-event — the fs refuses, and the error points at the
   discipline (`/usr/local/bin`).

## Boot flows (end state)

- **Virgin boot**: materialize the system blob (browser: fetch/copy
  into OPFS once; headless: `--system-image=` path), format a fresh
  writable root volume (cheap — it starts near-empty: skeleton dirs,
  /bin and /usr/local symlink targets, devNodes), mount, go. No
  compilation on the boot path at all.
- **Upgrade boot**: new blob present → swap it in as `/usr`; root
  volume untouched. Old blob kept = rollback.
- **Dev loop**: `mkimage` is fast enough to be the dev path too (it IS
  today's seed, run under Node); whether boot-time live-seeding
  survives behind a dev flag or dies entirely is decided in-item —
  tests currently lean on the seed pipeline and can lean on mkimage
  instead.

## In-item decisions (landed with todos/0040, 2026-07-08)

The design above left five things to decide in-item; here is what landed:

1. **Blob version location**: a FILE inside the blob —
   `/usr/share/os-release` (`NAME=gucOS` + `PRETTY_NAME` since todos/0114,
   `VERSION_ID=<n>`, blob-root
   path `/share/os-release`), written LAST in the bake so a crashed
   half-bake reads as "no version" and re-materializes. Readable in-OS
   (`cat /usr/share/os-release`); the natural 0037 module-cache key.
   `os-common.js bakedVersion()` is the one reader.
2. **Staleness gate**: `bakedVersion < manifest.version` re-bakes
   (headless) / re-materializes (browser). Strictly `<`: a NEWER blob
   than the repo manifest is kept as-is — that's what makes "swap in
   blob v(N+1)" an upgrade rather than something boot.js undoes. Same
   discipline as before: editing a seeded source without bumping
   `image.json version` leaves a stale blob.
3. **Virgin-boot user assets** (doom1.wad, pak0.pak, Desktop links,
   hello.c): `image.json` split into `system` / `user` sections; the
   `user` section seeds exactly ONCE, when the root volume is freshly
   created (no version gate — later manifest additions deliberately do
   NOT reach existing user volumes; that territory is the user's).
   `/etc/.image-version` and the seed-gate died with this.
4. **Live-seed as a dev flag**: no flag. Headless bake-on-stale IS the
   dev loop (boot.js bakes in-process, same pipeline as
   `tools/mkimage.js`); the browser tries a prebaked `os/os-system.img`
   (mkimage output, gitignored, fetched beside the page — zero
   compilation on the boot path) and falls back to baking in-worker.
5. **Seal**: superblock flags bit 1 (`SB_SEALED_BIT=2`) + SHA-256 of
   every byte after the superblock at offset 36. `BLOCK_FS.sealVolume/
   verifySeal` (WebCrypto, async); `tests/blockfs/fsck_v4.js`
   recomputes it independently. Runtime mounts don't verify — the
   `readonly` flag (EROFS from the op, after the walk so escaping paths
   retry on their owner) plus the ReadOnlyStore wrap prevent mutation;
   the seal is the offline tamper check.

One documented edge: two-path ops (`rename`/`link`) where BOTH args go
through the `/usr/local` alias get `EXDEV`, because MountFS rewrites only
the escaped argument and the pair then routes to different volumes —
pre-existing lazy-resolution behavior, not a readonly regression; busybox
`mv` falls back to copy+unlink, and direct `/var/local` paths work.

## Migration notes (in-item detail, recorded here so they aren't lost)

- Today's layout is inverted (system at `/`, user at `/root`,
  `/etc`+`/tmp`+`/dev` on the SYSTEM volume). The flip moves /root's
  contents onto the new root volume; existing v-series OPFS images are
  orphaned by new image names (the 0026 precedent) rather than
  migrated.
- wm.c spawns children with `PATH=/bin` and cwd `/root` — PATH becomes
  `/usr/local/bin:/bin`; cwd unchanged.
- image.json paths stay authoritative for the BAKE; entries that
  seeded `/etc/*` move to `/usr/share/*` (menu, fonts). `optional`
  binary-asset entries (ROMs, pak0.pak) keep their semantics at bake
  time; per-user assets stay user-volume concerns seeded on virgin
  boot only (doom1.wad at /root — decide exact mechanism in-item).
- fsck: read-only volumes are still plain BlockFS images — fsck runs
  unchanged; add a check that a blob marked RO was not mutated
  (superblock dirty bit or content hash — in-item).
- MUST-MATCH: none of the WMP/ring layouts are touched; the only
  cross-file contract added is the `readonly`/EROFS flag between
  host.js and the embedders.

## What this does NOT change

- The posix_spawn model, kernel-owned fds, RemoteFS, the standalone
  single-volume path (non-OS embedders keep private in-process fs).
- MountFS mechanics: still longest-prefix + strip, EXDEV, EBUSY,
  symlink escape — the flip is configuration, not machinery (plus the
  readonly flag).
- The repo discipline that all system binaries come from sources
  compiled by this repo's cc — mkimage just moves WHEN.
