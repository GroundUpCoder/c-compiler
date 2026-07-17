# gucman Slice 1 — the package manager exists (todos/0261, image v121)

The committed next major project after the menu build: **gucman**, the gucOS
package manager. Slice 1 is the headless end-to-end proof — punes (the NES
emulator) pulled out of the baked /usr blob and installable at runtime from
static assets on the same origin. Design was locked ahead of time (ticket
#68): `/opt/<name>` + tracked `/usr/local/bin` symlinks, tar+gzip payloads
(the index's `payload.format` field reserves a sealed-image format later),
fully declarative manifests, DB-replay uninstall, DOOM stays baked.

## The shape

Three pieces, all general (nothing punes-specific in any engine path):

1. **`tools/mkpkg.js`** builds `packages/<name>.json` into
   `dist/packages/pool/<name>_<ver>_<sha16>.pkg.tar.gz` + `index.json`. The
   key move: the package tree is assembled by running os-common's
   `seedEntries` (with `buildProject`/`createCcDriver`) over an in-memory
   BlockFS — the SAME code path the image bake uses — so packaged-vs-baked
   binaries are byte-identical by construction, and every image.json file
   vocab (`project`/`bin`/`text`/`content`/`c`) works in a package for free.
   `link` entries are refused (a v1 tarball carries files and dirs only; bin
   symlinks are the `bin{}` mechanism's job). Payloads are deterministic
   (sorted ustar members, mtime 0, fixed gzip level) → content-addressed
   pool names are stable across rebuilds with unchanged inputs.

2. **`os/gucman/gucman.c`** (`/bin/gucman`), first-party, linking the 0173
   libcurl veneer + vendored zlib (in-process gzip inflate — no shell-out;
   the tar walker is embedded precisely so the SAFETY rules are ours, not
   busybox's) + cJSON + fileops.h's `fo_delete`. Install pipeline and its
   invariants:
   - fetch index → `minBase` gate vs os-release VERSION_ID → deps
     depth-first (exact names; already-installed check resolves diamonds,
     an in-progress set turns cycles into loud refusals);
   - **sha256 (self-contained FIPS 180-4 impl) verified BEFORE extraction**
     — a corrupted payload refuses with nothing written anywhere;
   - **every tar member validated before the first write**: reject `..`,
     absolute paths, unsupported member types, anything outside
     `opt/<name>/` + the one top-level control.json;
   - staged extract into `/opt/.staging.<name>` → **atomic rename** to
     `/opt/<name>` → plant declarative surface (symlinks; `/etc/openwith`
     per-key delta-writes riding the cfgstore overlay; `/etc/menu` entries,
     additive since the 0259 menu-tree union) → **DB record LAST**
     (`/var/lib/gucman/<name>.json`, tmp+rename).
   Crash story: the DB record's existence IS "installed". A crash anywhere
   earlier leaves a staging dir or a recordless `/opt/<name>`, both swept by
   the next install; a crash mid-remove re-runs (ENOENT tolerated during
   replay); the DB record is deleted last. Any plant failure unwinds what
   was planted. `remove` replays the recorded lists in exact reverse —
   including only those `/etc/menu` dirs gucman itself created.

3. **The minimal/fat image split.** A plain bake is now MINIMAL (the future
   deploy artifact); `--packages=all` folds `packages/*.json` back in via
   os-common `foldPackages` — mechanically reconstructing the exact entries
   image.json used to carry (tree at `/usr/opt/<name>`, `/usr/bin/<cmd>`
   symlink, `/usr/share/menu` links, the `nes\t/bin/punes` openwith line),
   recorded as an os-release `PACKAGES=` line (`bakedPackages`, the second
   identity axis after the 0118 `OVERLAYS=` precedent — a fat and a minimal
   blob share a VERSION_ID, so version alone can't gate). image-fixture,
   serve.js and boot.js's default all want the fat set, so the ENTIRE
   existing estate (test_punes_e2e byte-for-byte, incl. its literal
   `nes\t/bin/punes` assert and pixel legs) stayed green with zero test
   changes; `boot.js --packages=none` is the minimal-boot mode the new e2e
   uses. serve.js also grew the `/packages/*` → `dist/packages/*` route, so
   the baked origin-relative repo default (`/usr/share/gucman/repos` =
   `/packages`) already works against the dev server.

## Test

`tests/kernel/test_gucman_e2e.js` (38 checks): boots the minimal blob and
proves absence (bin/menu/openwith all gone) → corrupted-payload refusal (a
SECOND serve.js instance serving a repo copy with one byte flipped
mid-payload; asserts refusal exit code, the "sha256 mismatch" diagnostic,
and that /opt, staging, and the DB are all untouched) → install → asserts
every planted artifact + the DB contents → **launches punes windowed from
/usr/local/bin** (the loader really is location-agnostic — an `/opt` wasm
binary through two symlink hops spawns like any baked one) → reboot
persistence → exact-replay removal → re-remove and post-removal launch fail
loud. Repo servers are literally `serve.js` pointed at the static dirs
(their root has no os/image.json, so serve's own image gate self-skips) —
spawned as children because `driveBoot` is a blocking `spawnSync`.

## Decisions & notes

- **punes keeps its menu entry, now via the package** (control.json
  `menu[]`). The slice scope said openwith+bin suffice, but the baked image
  had a Games/punes entry — dropping it on install would regress the UX the
  fat fixture preserves, and the M4 menu union made package menu entries
  first-class. This also gives the menu-planting engine real test coverage.
- gzip decompress is in-process zlib rather than shelling to busybox
  gunzip: the payload is in memory anyway (sha256 first), and the embedded
  tar walker is where the path-safety rules live — shelling out would have
  handed those rules to busybox's sanitizer (silent, not ours).
- mkpkg reuse + the minimal-blob cache (`build/test-fixtures/
  os-system.min.img`) keep the e2e warm-run cheap (~6s); cold runs pay one
  minimal bake + one punes compile, same class as test_os_boot.
- Deliberately NOT in Slice 1 (surfaced, not silently cut): the
  browser/deploy leg (comguc build step, `_headers`), pulling the other
  apps (Quake+pak0 is the fat-data case with its own follow-on), `gucman
  update/info/gc`, the postinst/prerm escape hatch (a payload carrying one
  is REFUSED loudly rather than half-honored), multi-repo/versioned-dep
  resolution, and the marquee-demo public-pre-install policy (an open user
  decision).

Gate: kernel 85/85 (test_gucman_e2e new), browser sweep 28/28, image v121
sealed, compiler.js untouched.
