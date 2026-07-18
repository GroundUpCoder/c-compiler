# 0262 — gucman deploy-leg: split-list apps to packages + comguc wiring

- **Status**: done (2026-07-18; dev log logs/2026-07-18/gucman-deploy-leg.md)
- **Design**: todos/done/0261 (Slice 1), the gucman roadmap's "comguc deploy" leg

## Goal

Make gucman real: pull the rest of the locked split list OUT of the baked
image into runtime-installable packages, and wire the public Pages deploy
(comguc) to ship the minimal image + the package repo. DOOM stays baked
(the no-install game). This is packaging + wiring on the Slice 1 engine —
no gucman.c/mkpkg.js re-engineering.

## Plan

- packages/<name>.json for quake (+pak0.pak — the fat-data case), mgba,
  winmine (+.res), cairodemo, sqlite3, lua, micropython, sent (+demo deck),
  mgp (+all decks); remove their baked image.json entries (+ menu links +
  openwith lines + quake's /root/id1 and Desktop-link user seeds); v122.
- Apps whose data rides beside the binary get self-locating `#!/bin/sh`
  launchers (readlink-chase `$0`, cd to the package dir) — quake's basedir
  is the CWD, mgp/sent open deck image refs CWD-relative (decks converted
  to relative refs).
- user32 res_ensure chases argv0 symlinks before appending `.res` (the
  sidecar lives beside the REAL binary; /usr/local/bin + fold links
  otherwise break winmine).
- comguc build.mjs: minimal bake into dist/, mkpkg + /packages/{pool,index}
  copy, pool immutable / index must-revalidate headers; verify.mjs installs
  quake in-browser through the baked origin-relative repo default.
- NOT here (held): the public deploy itself and the fresh-boot pre-install
  (marquee) policy — open user decision. ROM-launchers stay baked (see
  close-out notes: copyrighted payloads can't ship in the public pool; no
  desktop[] planting vocab yet).

## Acceptance

- mkpkg builds all 10 packages; the fat fixture (--packages=all) keeps the
  whole estate green with the pulled apps folded back.
- tests/kernel/test_gucman_quake_e2e.js (red→green): minimal boot, install
  the ~8.6 MiB quake package, in-OS sha256 proves the 18.7 MB pak byte-exact,
  the game launches from /opt, remove replays clean.
- comguc build + verify pass (minimal image, /packages served, in-browser
  gucman install quake).
