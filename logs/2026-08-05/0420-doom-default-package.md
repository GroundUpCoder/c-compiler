# #420 — doom becomes a default package (first real `defaultPackages` member)

Ticket #420, on the #419 mechanism (merged `52cb0298`). doom leaves the baked
image and becomes `packages/doom.json`, named in `os/image.json
defaultPackages` — the first non-empty member the mechanism has ever carried.

## What landed

- **`packages/doom.json`**: `doom-bin` (vendor/doom/bin.json), `doom1.wad`
  (committed shareware WAD, 4,196,020 B), a launcher, `bin`/`desktop`/`menu`
  keys — the quake package shape.
- **`os/image.json`**: the four baked doom entries removed (`/usr/bin/doom`,
  `/usr/share/menu/Games/doom`, `/root/Desktop/doom`, `/root/doom1.wad`);
  `defaultPackages: ["doom"]`. `version` untouched (bumps at ship).
- Zero doom-shaped special cases anywhere in the mechanism. gucman.c and
  mkpkg untouched; the one os-common change is the general packagesDir seam
  fix described under "Gate round 1 fallout" below.

## The one real design decision — the launcher is NOT quake's cd pattern

Quake's launcher `cd`s to the package dir because its basedir IS the CWD.
Copying that for doom failed a red-control leg in a way worth recording:
doom's `configdir` defaults to `"."` (m_config.c `GetDefaultConfigDir`), so at
startup it `mkdir`s `./.savegame/` and on exit writes `default.cfg` into the
CWD. With a cd-launcher that means:

- installed (`/opt/doom`): unrecorded litter inside the package dir —
  `gucman remove`'s exact DB replay leaves `/opt/doom` behind (caught live:
  the e2e's OPT-GONE leg went red);
- baked (`/usr/opt/doom`): EROFS — savegames silently broken on the fat image.

doom, unlike quake, takes `-iwad <absolute path>` (d_iwad.c `D_FindIWAD`), so
the launcher keeps the **caller's** CWD — config and saves land in `$HOME`
exactly as the baked doom behaved — and hands the WAD over explicitly with the
known-prefix probe (todos/0444): `/opt/doom` installed, else `/usr/opt/doom`
baked. Our `-iwad` sits AFTER `"$@"` so a user's own `-iwad` wins
(`M_CheckParm` returns the first match). Still variable-free (#296), still no
`exec` (the pkill contract).

## First-real-member fallout (the #419 paths nothing had ever walked)

`defaultPackages` non-empty ⇒ every bake now writes
`/usr/share/gucman/defaults` ⇒ **every boot in the estate spawns
`gucman sync-defaults`**:

- Fat image (all tests, dev serve.js): doom is baked-as-package
  (`PACKAGES=`), so the sync takes its silent fast path. Only delta: the
  status file `/run/gucman-sync.status` now exists on every boot.
- Minimal image, headless: the baked repo default is origin-relative
  `/packages` — unreachable, so the sync fails legibly (3 stderr lines on the
  boot console) and retries next boot. 17 minimal-boot tests tolerate this;
  the one that could not, `test_defaults_sync_e2e`, pinned the `[]`-era
  ("shipped manifest bakes no defaults file") and was rewritten to pin the
  new reality instead. Its real seam — /etc wholesale override — unchanged.
- Minimal image, browser with a served repo (`os-minimal.mjs`, and the REAL
  deploy): first boot genuinely auto-installs doom. That is the feature.

**Desktop-icon delta, deliberate and worth knowing**: desktop shortcuts at
install time are gated on the opt-in `desktop_shortcuts` flag (Q5/#90,
default OFF), and folded packages get icons only via the ctx-menu "Add
Default Icons" (Lane D). So doom no longer has a Desktop icon on a virgin
boot — parity with quake/winmine/every other packaged app, recoverable via
Add Default Icons, and the Games menu entry is planted unconditionally. Not
a mechanism defect; recorded here because it is the one user-visible UX
regression of the un-baking.

## Evidence

- Red control `tests/kernel/test_gucman_doom_e2e.js` committed first; on the
  unconverted tree it fails for two named reasons (absence legs trip on the
  still-baked doom; `ensurePackages(['doom'])` refuses). Green after: 26/26,
  including offline-legibility (status `failed` + `failed doom`), zero-action
  install on the networked reboot, in-OS `sha256sum` byte-exact WAD, a real
  "DOOM Shareware" window, clean tombstoned remove.
- **Blob grep, not manifest** (deploy-shaped `mkimage.js --out` bakes, base
  `8ab310ae` vs this branch): signatures `DOOM Shareware`/`doom1.wad`/`IWAD`
  hit 2/1/9 in the before-image (positive controls) and **0/0/0 after**. The
  bare string `doom` survives 3× after: the defaults-file line + two prose
  comments in baked headers — exactly the expected residue.
- **Byte delta on the baked image: −469,808 B** (16,725,080 → 16,255,272;
  headroom under the 26,214,400 B Cloudflare file cap: 9.49 MB → 9.96 MB).
  The WAD itself was never blob mass — it was a user-section seed fetched as
  a separate static file at first boot; it now ships inside the doom package
  payload (~1.9 MiB compressed) instead.

## Test churn (the quake deploy-leg precedent)

os_apps (WAD path → `/usr/opt/doom/doom1.wad`), fileman (row indices + the
`5 object(s)` status-bar count), wm_service (selection subject doom →
ctlpanel), ctxmenu (teal witness → calc), desktop_defaults (phase-1 link
subject → term), os-shell (column-0 probe → calc), defaults_sync (session 1
rewritten as above). Icon geometry needed nothing — `deskEntries()` derives
from the manifest (the 0166 rule doing its job).

## Gate round 1 fallout (first-real-member, all found by the full gate)

Round 1 went red in exactly five kernel files, every one a path #419 had
never walked with a non-empty set:

1. **A real mechanism seam gap** (fixed in os-common.js + mkimage +
   boot.js): foldPackages validates `defaultPackages` against the OVERRIDDEN
   `packagesDir`, so the sanctioned throwaway-definitions seam
   (mkimage/boot.js `--packages-dir`, driven by test_seed_e2e) threw
   `unknown package 'doom'` before baking. Round 2 taught the fix its final
   shape: an implicit skip-when-overridden silenced #419's own red controls
   (test_default_packages exercises the validation THROUGH the packagesDir
   seam), so the opt-out is an EXPLICIT flag — `--no-default-packages` /
   `opts.noDefaultPackages` — declared by the throwaway bake; every other
   fold, packagesDir-overridden or not, validates exactly as #419 shipped.
2. **Surprise installs**: ensurePackages builds the FULL base set, so any
   test that declares `/etc/gucman/repos` and reboots got doom genuinely
   auto-installed under its asserts (test_gucman_e2e). Fixed with the
   mechanism's own /etc wholesale-override opt-out.
3. **Console-byte cleanliness**: the offline sync prints one stdout line,
   which broke `parsePPM(stdout, 0)` cat-sessions (symbolfont, fontpkg —
   same /etc opt-out) and test_os_boot's positional `/etc is empty` capture
   on the factory-reset boot (switched to a `test -z` marker; the reset
   wiping /etc means the shipped set is LIVE there by design).

Sweep 51/51 was green on round 1 — including os-minimal.mjs, where doom now
genuinely auto-installs over HTTP on the deploy-shaped minimal boot.
