# 0221 — Presentations restructure: tutorial subfolder + POSIX-on-WebAssembly talk deck

- **Status**: done (2026-07-16) — three commits (tutorial nested into
  Presentations/MagicPoint Tutorial/; the 13-page posix-on-wasm.mgp talk
  deck seeded master+rw-copy with present/openwith e2e legs; image v101
  bump + close-out). Gates: fresh sealed bake (18.6 MiB), openwith-e2e
  ALL OK, present-e2e PASSED, projects 26/0, kernel 73/0 (482.8s),
  browser sweep 27/0 (456.2s), real-browser visual pass
  (tools/os-drive-scripts/posix-deck-shots.mjs, shots in os/media/).
  Dev log: logs/2026-07-16/presentations-posix-deck-0221.md
- **Design**: vendor/magicpoint/README.md (0119 port + descopes), todos/done/0202 (tutorial series + masters/rw-copies precedent), todos/done/0185 (Presentations showcase)

## Goal

Restructure the desktop "Presentations" folder and add a new deck:

1. **Nest the 0202 tutorial** — the ten `NN-*.mgp` decks sit loose in
   `/root/Desktop/Presentations/`; group them into a
   `Presentations/MagicPoint Tutorial/` subfolder (rw copies re-pathed in
   the `user` manifest section; the `/usr/share/mgp/tutorial/` masters and
   the Demos ▸ learn-mgp entry stay put — present-e2e pins them there).
2. **New talk deck** — "POSIX on WebAssembly (or: what is an OS anyway?)",
   a real `.mgp` authored from the user's draft (what an OS does; the
   gucOS DO / DON'T / DON'T-NEED-TO split; why not emulation; prior art),
   using only directives this port renders (0202 whitelist). Source at
   `vendor/magicpoint/decks/talks/posix-on-wasm.mgp`, master baked to
   `/usr/share/mgp/talks/`, rw copy seeded to
   `Presentations/POSIX on WebAssembly/` (the 0202 masters+copies rule:
   Desktop decks must be editable for the right-click-Edit → reload loop).

## Plan

- `os/image.json`: `user.dirs` grows the two subfolders (parents listed
  first — seedEntries mkdirs in array order); the ten Desktop deck entries
  re-path under `MagicPoint Tutorial/`; `system` grows
  `/usr/share/mgp/talks` + the baked master; version bump for the bake.
- Author the deck to the tutorial house style (mono tfont, `%default`
  title template, TAB bullets, 48-`%` page separators, tab-1 ≤ ~50 chars).
- Tests: `test_openwith_e2e.js` navigates the new tree (Presentations
  lists the subfolder; tutorial deck 01 still Opens; the talk deck Opens
  from its own subfolder); `test_present_e2e.js` grows a TALKS page-through
  entry (crash gate over every page).

## Acceptance

- Booted OS: Presentations shows the two subfolders; tutorial deck 01
  double-click-opens the viewer from fileman; the talk deck opens from
  fileman Open AND a desktop dblclick; right-click Edit opens deck text in
  notepad (the standing 0202 flows, now over the nested paths).
- Fresh bake at the bumped version; present/openwith e2es green; kernel
  suite + browser sweep green as the integration gate.
