# 0103 — desktop icon rename-in-place

- **Status**: open
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
