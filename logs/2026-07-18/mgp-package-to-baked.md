# mgp: gucman package → back into the base image (ticket #80, image v125)

Reverses the **mgp portion** of the #72 deploy-leg split (bcac37e /
todos/0262). Coordinator decision: MagicPoint is always-available base
software, like DOOM — not a runtime install. Everything else #72 did
(quake/mgba/winmine/cairodemo/sqlite3/lua/micropython/sent/punes as
packages, comguc shipping /packages) stands.

## What moved back, exactly

The reversal is the exact inverse of #72's mgp hunks, plus the deck-ref
revert that #72's layout forced:

- **image.json** (v124 → v125): `/usr/bin/mgp` (vendor/magicpoint/bin.json),
  the 21 share files back at `/usr/share/mgp/` (demo.mgp, demo.gif, SYNTAX,
  7 showcase decks, tutorial/01–10, talks/posix-on-wasm.mgp), the
  `/usr/share/menu/Demos/{mgp,learn-mgp}` launcher scripts
  (`mgp /usr/share/mgp/…` — no cd needed, see below), and the
  `mgp→/bin/mgp` key in the `/usr/share/openwith` seed.
- **Deck image refs reverted to ABSOLUTE** (`/usr/share/mgp/demo.gif`):
  #72 converted demo.mgp, decks/images.mgp, tutorial/07+08+10 to relative
  `demo.gif` refs because the package layout has no stable absolute home
  (`/opt/mgp` installed vs `/usr/opt/mgp` fat-baked) — every launch had to
  cd into the package `share/`. With a fixed baked home the absolute refs
  are strictly better: mgp's image lookup is CWD then `Paths[]` (the deck's
  own dir, mgp.c:457), and the `/root/Desktop/Presentations` rw copies
  (0202 masters+copies) have **no demo.gif beside them** — relative refs
  render imageless from the Desktop copies, absolute refs work from
  anywhere. Half-keeping the relative refs would have half-baked the
  restore.
- **packages/mgp.json deleted** — foldPackages/mkpkg enumerate `packages/`
  dynamically, so mgp drops out of the fold set, the index, and comguc's
  pool with zero list edits (9 packages remain).
- **mkpkg.js grew a general orphan prune**: the per-package "superseded
  payload" cleanup never removed a *deleted* package's payload, and comguc
  copies the whole pool dir — the stale `mgp_1.13a_….pkg.tar.gz` would have
  shipped forever. After writing the fresh index, anything in `pool/` the
  index doesn't reference is unlinked (also catches crashed `.tmp-*` files).

## Consumers unaffected

The FS_WATCH live-reload wiring (#75 Consumer A) is *in the binary* —
baked-vs-packaged is irrelevant to it; `test_mgp_livereload_e2e` builds its
own deck under /root and passed unchanged. The Demos menu entry names
(`mgp`, `learn-mgp`) are identical in both worlds, so the wm_service /
os-shell DEMOS lists needed nothing.

## Test churn (mechanical, the #72 paths reversed)

- `test_present_e2e.js`: all 19 mgp launches back to
  `mgp /usr/share/mgp/<deck> &` (cd-to-share gone); sent legs untouched
  (sent stays a package).
- `os-present.mjs`: `mgp-demo &` → `mgp /usr/share/mgp/demo.mgp &`.
- `test_openwith_e2e.js`: the tutorial-deck cp source path.
- fileman/os_apps/wm_service churn from #72 was quake-only — untouched.

## comguc (committed separately)

- build.mjs: the magicpoint asset cross-check now scopes to the manifest's
  **user section** (the only entries fetched over HTTP at first boot) —
  the restored system-section vendor refs are baked into os-system.img at
  build time and must not be demanded in dist/. Package-list comments +
  README updated (mgp out).
- Full build + verify re-run: minimal image v125 bakes **with mgp in it**,
  9 payloads, cross-check 11 user-side assets ✓, in-browser quake install
  PASS.

## Gate

Bake v125 sealed. Kernel 90/90 (present 202s — all 18 decks page through
against the baked layout; gucman + gucman-quake green with the 9-package
set). Browser sweep 29/29 (os-present, os-gucman, os-shell). Headless
`--packages=none` minimal boot shows /usr/bin/mgp + the full
/usr/share/mgp tree + menu script + openwith key. compiler.js UNTOUCHED.
