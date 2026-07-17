# 0261 — gucman Slice 1: the package manager, headless-proven (punes pulled out)

- **Status**: done
- **Design**: the locked gucman design (external roadmap; ticket #68). Locked
  decisions honored, not relitigated: name `gucman`, first-party `os/gucman/`,
  install target `/opt/<name>` + tracked `/usr/local/bin` symlinks, v1 payload
  `tar+gzip` (index `payload.format` reserves the sealed-image Option B), FULLY
  DECLARATIVE manifest (bin/openwith/menu in control.json; install records the
  exact planted list in `/var/lib/gucman/<name>.json`, remove replays it in
  reverse), DOOM stays baked, punes is the first pulled package.

## Goal

Pull optional apps OUT of the baked /usr blob into runtime-installable
packages served as static assets from the same origin, with a general,
declarative, crash-safe install/remove engine — proven end to end headless
with punes (the NES emulator) as the first package.

## What landed

- `packages/punes.json` — the package definition (image.json file vocab +
  declarative bin/openwith/menu). punes carries its Games menu entry so an
  install reproduces the full pre-split UX (the 0259 menu-tree union makes
  /etc/menu entries additive).
- `tools/mkpkg.js` — assembles the package tree via the SAME
  seedEntries/buildProject/createCcDriver pipeline as the bake (byte-identical
  by construction), emits a deterministic ustar+gzip payload (sorted members,
  mtime 0), content-addressed `pool/<name>_<ver>_<sha256pre16>.pkg.tar.gz`,
  and `index.json` (schemaVersion/baseVersion/minBase/deps/payload{format,
  url,size,sha256}) under `dist/packages/` (gitignored). Per-package input
  freshness (narrow closure scan) skips rebuilds.
- `os/gucman/` — `/bin/gucman` (curl veneer + zlib inflate + cJSON +
  fileops.h): `install` = fetch index → minBase gate vs os-release →
  depth-first deps (cycle → refuse) → fetch payload → **sha256 verified
  BEFORE extraction** → tar members validated in FULL (reject `..`, absolute,
  non-file/dir types, anything outside `opt/<name>/` + control.json) → staged
  extract `/opt/.staging.<name>` → **atomic rename** `/opt/<name>` → plant
  symlinks/openwith keys/menu entries → **DB record written LAST**
  (crash-safe; a recordless /opt entry or stale staging dir is swept by the
  next install). `remove` replays the DB in reverse (menu → openwith →
  symlinks → files → dirs, tolerating ENOENT so a crashed remove re-runs),
  deleting the DB record last. `list` prints the installed set. A
  control.json carrying postinst/prerm is refused loudly (the escape hatch is
  reserved, not implemented).
- Repo config: `/etc/gucman/repos` > baked `/usr/share/gucman/repos`
  (origin-relative `/packages` default; serve.js maps `/packages/*` →
  `dist/packages/*`).
- **Minimal vs fat images**: a plain `mkimage` bake is now MINIMAL (punes
  absent); `--packages=all|a,b` folds packages back in (os-common
  `foldPackages` — tree under /usr/opt/<name>, /usr/bin symlinks, menu links,
  openwith lines: mechanically the exact entries image.json used to carry).
  The folded set is recorded as os-release `PACKAGES=` (`bakedPackages`, the
  0118-overlay-style identity axis). boot.js gained `--packages=` (default
  `all` — dev/test parity) with identity-aware reuse/fixture gates;
  image-fixture + serve.js bake fat, so the whole existing estate stays green
  with ZERO test changes. Image v120 → v121.
- `tests/kernel/test_gucman_e2e.js` — boots the minimal blob
  (`--packages=none`): asserts punes truly absent; a 1-byte-corrupted payload
  (second serve.js over a mutated repo copy) is refused with nothing written;
  install plants everything + launches punes windowed from /usr/local/bin;
  the install persists across reboot; remove replays exactly (including the
  /etc/menu dirs gucman itself created); re-remove fails loud. 38 checks.

## Acceptance

- kernel suite 85/85 (new file registered; estate untouched), browser sweep
  28/28, compiler.js untouched.
- Deliberately out of Slice 1 (follow-ons): the browser/deploy leg (comguc
  build step + `_headers`), pulling the remaining apps (Quake+pak0, mgba,
  mgp/sent, REPLs, winmine…), `gucman update/info/gc`, postinst/prerm, and
  the marquee-demo public-pre-install policy (open user decision — surface,
  don't decide).
