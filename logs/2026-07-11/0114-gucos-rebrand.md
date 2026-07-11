# 0114 — Rebrand the OS as gucOS (groundupcoder OS)

The OS shipped under the placeholder name **wasm-os** since 0004. This sweep
names it **gucOS** everywhere a user or agent sees a name; the compiler/repo
keeps its own identity. Historical material (`logs/`, `todos/done/`) is
deliberately NOT rewritten — the journal keeps the old name as the record.

## What was renamed

- **Boot page** (`os/os.html`): `<title>gucOS</title>`, the boot-locked
  guard ("gucOS is already running in another tab"), the no-WebGPU guard.
- **os-release** (`os/os-common.js`): `NAME=gucOS` plus a new
  `PRETTY_NAME="gucOS (groundupcoder OS)"` line, VERSION_ID unchanged.
  Safe for both consumers: `bakedVersion()` matches `VERSION_ID=` with a
  line-anchored regex, and ctlpanel's System applet just renders every
  line (so PRETTY_NAME shows up there as a bonus).
- **/proc/version** (`kernel.js`): builder token only — `(cc gucos)`. The
  `Linux version 6.6.0-wasm …` prefix stays: busybox procps parses Linux
  formats (0043), and uname sysname stays for the same compat reason.
- **protoshell banner** (`os/protoshell.c`): "gucOS protoshell …".
- **Boot lock** (`os/kernel-worker.js`): `BOOT_LOCK = 'gucos:' + images`.
  One-time skew: a pre-rebrand tab and a post-rebrand tab do NOT contend
  (different lock names). Same-build tabs still exclude each other;
  accepted, per the item.
- **Start-menu sidebar band** (`os/wm.c`) and the **marquee saver default**
  (`os/saver.h` `SV_DEF_TEXT`, plus the seeded `/usr/share/screensaver` in
  `image.json`): "WASM OS" → "gucOS". These three were NOT in the item's
  inventory — the grep pattern there was `wasm-os`, and these carry the
  space-separated form. NB the 5x7 font uppercases (A–Z only), so both
  render "GUCOS" — the Win95 all-caps sidebar look; source keeps the
  brand casing.
- **Docs**: `todos/OS.md` placeholder note rewritten, `todos/DISK-IMAGE.md`
  os-release line, `vendor/busybox/README.md` "for gucOS", CLAUDE.md os/
  section header + intro (README.md already carried the name from the
  0114 queueing commit).
- **Tests**: `NAME=wasm-os` literals in `tests/kernel/test_ctlpanel_e2e.js`
  and `tests/browser/os-shell.mjs` → `NAME=gucOS`.

## Mechanics

`image.json` version 58 → 59 (os-release content changed; persistent
browser OPFS images only re-fetch on a version bump). Prebaked
`os/os-system.img` deleted to force the fixture rebake. OPFS image
filenames (`os-*.v5.img`) unchanged — the store format didn't change, and
renaming them would orphan every user's root volume for zero benefit.

Acceptance grep: `grep -rn 'wasm-os\|WASM OS'` now hits only `logs/`,
`todos/done/`, and the 0114 item's own inventory prose.

## Verification

- `node tests/kernel/run.js` — full suite pass (includes the ctlpanel
  os-release leg, /proc reads via procps applets, os_boot's
  VERSION_ID upgrade leg over the v59 bake).
- `node tests/browser/os-sweep.mjs` — full sweep pass (os-shell.mjs
  asserts `NAME=gucOS` through the System applet; os-boots' guard-screen
  legs run against the renamed strings via state probes, not text).
