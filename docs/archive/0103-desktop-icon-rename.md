# 0103 — desktop icon rename-in-place

- **Status**: DONE (2026-07-11). Landed in `os/wm.c`: F2 on a single-selected
  icon (and the icon context menu's new **Rename** row) opens an inline editor
  over the label — a sunken white box + black text + caret; printable keys
  insert, Backspace deletes, Enter commits `rename(2)` on `/root/Desktop`, Esc
  cancels, a desktop click-away or focus-loss commits (Win95). Empty / `/`-bearing
  names and an existing target (EEXIST — both files kept) leave the editor open;
  the `.icons` placement is carried to the new name (`desk_icons_rename`). The
  Recycle Bin is not renamable. A `desk_edit_armed` flag gates the focus-loss
  commit so the transient focus-fall when the icon menu dismisses (the Rename
  path) can't close the editor early. Image v62→**v63** (seeded `wm.c`). Tests:
  `test_wm_service_e2e.js` rename leg (F2 rename, EEXIST-keeps-both, Esc-cancel,
  icon-menu Rename) + `os-shell.mjs` browser leg (editor box renders, grid
  relabels); geometry bumps in `test_ctxmenu_e2e.js` / `test_recycle_e2e.js`
  (icon menu 120x96→120x116). Dev log
  `logs/2026-07-11/0103-desktop-icon-rename.md`. Descoped by design: the
  click-pause-click trigger (an alternative gesture for the same achieved
  capability — F2 + menu Rename fully cover the rename-in-place intent).
- **Design**: `todos/WM.md` "The desktop shell" (desktop-icons block,
  todos/done/0029). Filed by the 0076 parity sweep; 0077 explicitly
  non-goals rename ("scope separately") — this is that scope. Sequenced
  after 0077: it needs the single-selection state 0077 introduces.

## Goal

Desktop icons can't be renamed: the Win95 affordance (select, then F2 or
click-pause on the label → inline edit box → Enter commits) has no
counterpart, and the only rename path in the OS at all will be fileman's
0092 context-menu rename. The desktop is /root/Desktop, so this is just
`rename(2)` plus an inline editor on the icon label.

## Plan

- **Trigger** — F2 with a selected icon (0077's selection set, size 1);
  optionally the click-pause-click gesture (distinct from double-click —
  reuse the 0029 timestamp discipline, a second click LATER than the
  dblclick window starts editing). Right-click → Rename arrives free
  once 0091's icon menu exists — wire it then.
- **Editor** — wm.c draws an edit box over the label cell (the desktop
  layer already repaints per frame): text buffer + solid caret,
  printable keys insert, Backspace deletes, Enter commits, Esc cancels,
  click-away commits (Win95 behavior). No EDIT control — wm.c is not a
  win32 app; ~40 lines of key handling, the 0078 run-dialog precedent.
- **Commit** — `rename("/root/Desktop/old", "/root/Desktop/new")`;
  refuse `/` and empty; EEXIST keeps the editor open (beep-equivalent:
  leave text selected). The ~1s readdir watch picks up the new name; a
  0077 `.icons` position entry (if present) is carried to the new name.
- Launcher symlinks rename like any file (the link *name* is the label).

## Acceptance

- Headless (`test_wm_service_e2e.js`): select an icon, inject F2 + typed
  name + Enter → readdir shows the new name, old gone; Esc leaves the
  file untouched; renaming onto an existing name keeps both files.
- Browser (`os-shell.mjs`): the inline editor renders over the label and
  the grid relabels after commit.
