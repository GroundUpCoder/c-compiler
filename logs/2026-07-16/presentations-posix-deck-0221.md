# Presentations restructure + the "POSIX on WebAssembly" talk deck (todos/0221)

Two asks in one item: nest the 0202 MagicPoint tutorial into its own
subfolder, and add a brand-new deck — "POSIX on WebAssembly (or: what is
an OS anyway?)" — as a real `.mgp` presentation in a sibling subfolder.

## What changed

- `/root/Desktop/Presentations/` no longer holds ten loose deck files: the
  0202 rw copies moved to `Presentations/MagicPoint Tutorial/` and the new
  talk lives in `Presentations/POSIX on WebAssembly/posix-on-wasm.mgp`.
  Manifest-only for the tutorial (user-section re-path; the
  `/usr/share/mgp/tutorial/` masters and Demos ▸ learn-mgp stay put — the
  present-e2e page-through pins the masters, so nothing under /usr moved).
- The new deck follows the 0202 masters+copies rule: source at
  `vendor/magicpoint/decks/talks/posix-on-wasm.mgp`, master baked to
  `/usr/share/mgp/talks/`, rw Desktop copy so the right-click-Edit →
  reload loop works honestly (a /usr deck would EROFS on save).
- Image v100 → v101 (fresh sealed bake, 18.6 MiB).

## Deck notes

13 pages, tutorial house style (mono tfont, `%default` title template,
TAB bullets, 48-`%` separators), only 0119-port-supported directives.
Content is the user's draft kept in their voice: the "OS = talks to
hardware" framing, the emscripten yes-and-no, then the OS job list sorted
DO / DON'T / DON'T-NEED-TO (one slide each, DON'T-NEED-TO split in two),
emulation trade-off (tinyemu/v86), prior art (Browsix/Wasix/emulators/JIT
emulators). Background `#301848` — a hex not used by any other deck, so
its present-e2e dominant-background assert stays unambiguous. Longest
title kept ≤27 chars ("Isn't emscripten POSIX?" dropped "already" — the
proven-rendering title budget across the corpus is ~29 chars at size 9).

## Gotchas / decisions

- **Folder names with spaces are fine end-to-end** — activate(),
  openwith's `ow_build`, and fileman all pass the path as ONE argv element
  (no shell). The only care needed was hush-level quoting in the e2e
  driver scripts (`wmctl settext EDIT:0 "/root/.../MagicPoint Tutorial"`).
- **Desktop grid model untouched**: `deskEntries` (drive.js + the browser
  harness twin) counts direct `/root/Desktop` children only, so nesting
  below Presentations shifts no icon cells and no test geometry.
- **seedEntries mkdirs in `dirs`-array order** — the two subfolders are
  listed after their parent; files' parents must pre-exist.
- The openwith e2e's fileman legs are order-sensitive: the new talk-deck
  leg navigates away, so it re-enters the tutorial folder before the
  row-0 Edit leg (which expects `01-welcome.mgp - Notepad`).

## Verification

- `test_openwith_e2e.js` — ALL OK (new asserts: Presentations lists the
  subfolder; the talk deck Opens from its subfolder; all standing 0202
  view/Edit flows over the nested paths).
- `test_present_e2e.js` — PASSED; new TALKS entry page-throughs all 13
  pages (crash gate) + title bg/glyph pixel asserts.
- Fresh `tools/mkimage.js` bake at v101, sealed.
- `tests/run.js` diff plan: projects 26/0, kernel 73/0 (482.8s), browser
  sweep (serial, full) green — numbers in the close-out.
- Real-browser visual pass via `tools/os-drive.mjs` +
  `tools/os-drive-scripts/posix-deck-shots.mjs` (committed): desktop
  dblclick → fileman at Presentations (two subfolders), deck opens from
  fileman in the viewer (title + DO slide render), nested tutorial deck 01
  still opens, right-click Edit → notepad shows the deck text. Shots in
  gitignored `os/media/0221-*.png`.
