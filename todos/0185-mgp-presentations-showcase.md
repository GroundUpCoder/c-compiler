# 0185 — MagicPoint showcase: Presentations desktop folder + sample decks

- **Status**: open
- **Design**: vendor/magicpoint/README.md (the 0119 port + its descopes), todos/SDL3.md

## Goal

mgp (0119) ships exactly ONE deck — `/usr/share/mgp/demo.mgp` behind a single
Demos ▸ mgp menu entry. Build a showcase: a **Presentations** folder on the
desktop holding several sample decks, each demoing a distinct slice of what
mgp can do in this port (text sizing, colors, alignment, bullet/icon lists,
images, backgrounds/gradients, pause/build effects).

## Plan

**Prerequisite — desktop folders must open.** Today a real directory on the
desktop falls through `activate()` to openwith (`S_ISREG` fails, no
extension) → `default.gui` → notepad opens a directory path. Same wart for
the ctx-menu "New Folder". Minimal fix in wm.c `activate()`: an `S_ISDIR`
branch (stat follows links, so a link-to-dir behaves like the grid's
`is_dir`) spawns `/bin/fileman <path>` — the Recycle Bin script precedent,
without the script. Start-menu dirs are flyout GROUPS and never reach
`activate()`, so the branch only fires for desktop folders (and fileman
already navigates into dirs natively). Give `is_dir` desktop icons a folder
glyph (tab + body) so folders read as folders; center-pixel probes keep
seeing navy.

**Decks.** Authored for this port (only `mono.ttf` exists; only `demo.gif`
is seeded; `%system`/`%filter`/EPS/JPEG/animation are recorded descopes and
`%lcutin`/`%rcutin` create X child windows like the stubbed page list — all
avoided). Sources live at `vendor/magicpoint/decks/*.mgp` (ours, like
`demo.mgp`; upstream `sample/` stays verbatim), seeded to `/usr/share/mgp/`:

- `text.mgp` — sizes 1–9, %vgap/%hgap, %prefix, %cont line joining
- `colors.mgp` — %fore/%back X11 names + grayNN ramp, %bar, %ccolor
- `align.mgp` — %left/%center/%right/%leftfill, %area drawing regions
- `bullets.mgp` — tab-depth lists, %icon box/arc/delta/dia at several sizes
- `images.mgp` — %newimage demo.gif: natural, -zoom, -xyzoom, -rotate
- `backgrounds.mgp` — %bgrad directions/palettes (adapted from the ideas in
  upstream `sample/gradation.mgp`), %bar framing
- `effects.mgp` — %pause builds, %mark/%again column layout

**Desktop folder.** `image.json` user section: `/root/Desktop/Presentations`
dir + one symlink per deck (including demo.mgp) into `/usr/share/mgp/` —
single source, EROFS-protected, and the `.mgp` link name keeps the openwith
extension key, so fileman/desktop opens launch `/bin/mgp` end-to-end.

## Acceptance

- Double-clicking Presentations on the desktop opens fileman at the folder;
  the decks are listed; opening a deck launches mgp and it renders.
- Each deck renders non-blank and visibly distinct (headless `wmctl shot`
  assertions in the kernel e2e; the present sweep stays green).
- One image-version bump shared with 0184; os-shell/wm goldens updated once.
