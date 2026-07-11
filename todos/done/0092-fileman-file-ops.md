# 0092 — File manager operations — rename/delete/copy/cut/paste/properties

- **Status**: DONE (2026-07-11). fileman grew the full op set over a new
  shared `os/fileops.h` core (copy/move/delete/paste-dest/new-dest +
  the clipboard file-list, one implementation for fileman AND wm.c) behind
  shell32's `SHFile*` veneer exports: a right-click context menu (Open /
  Open With / Cut / Copy / Rename / Delete / Properties on a row; Paste /
  New Folder / Refresh on the pane) over the 0091 TrackPopupMenu, F2/Del/
  ^C/^X/^V accelerators (listbox-focus-gated so the path EDIT keeps its
  own text chords), a rename dialog, delete confirm + Properties
  MessageBoxes, and clean EROFS surfacing. The wm.c desktop menus grew
  icon Cut/Copy + desktop Paste over the SAME format-2 clipboard file
  list, so cut/copy/paste crosses fileman↔desktop. Delete is permanent
  until the Recycle Bin (0093) reroutes it; multi-select/details is 0106;
  desktop-icon rename is 0103; DnD is a recorded non-goal — all already
  queued. Fell out: user32's agent AQ_CLICK now prefers an ENABLED match
  (modal-over-modal is drivable) and `AppendMenuA` / `CreateAcceleratorTableA`
  / `LB_ITEMFROMPOINT` landed. Image v52→v53. Tests: new
  `tests/kernel/test_fileman_ops_e2e.js` (22 checks) +
  `tests/browser/os-fileman.mjs`; ctxmenu goldens moved (desktop menu
  120x116, icon menu 120x76). Dev log `logs/2026-07-11/0092-fileman-ops.md`.
- **Design**: `todos/WIN32.md`. Grows `os/win32/fileman.c` from a
  navigator/launcher (0048) into a real Explorer. Uses the 0090 clipboard for
  cut/copy/paste and the 0091 context menu as the primary trigger; delete
  routes to the Recycle Bin (0093) once that lands.

## Goal

fileman today is navigate-and-launch only — the 0073 sweep flags it: "no
rename/delete/copy — it is a navigator/launcher only." A file manager you
can't manage files with is the biggest gap between this and a real desktop.
Add the standard file operations.

## Plan

- **Operations** — rename (F2 / in-place edit), delete (Del), copy (Ctrl+C),
  cut (Ctrl+X), paste (Ctrl+V), new folder, Properties. Implement over POSIX
  (`rename`, `unlink`, `mkdir`, `stat`, a copy loop) behind a
  `SHFileOperation`-style helper in `os/win32/shell32.c`.
- **Clipboard integration** — cut/copy put a CF_HDROP-style file list on the
  0090 clipboard; paste reads it. Cut then paste = move; copy then paste =
  duplicate with "Copy of…" on name clash.
- **Context menu** — right-click a file (0091) → Open / Open with (0072) /
  Cut / Copy / Rename / Delete / Properties; right-click empty pane → Paste /
  New Folder / Refresh.
- **Confirmation + errors** — MessageBox confirm on delete; surface EEXIST/
  EACCES via MessageBox (the RO /usr volume, 0040, is read-only — fail
  cleanly, don't crash).
- **Properties dialog** — name, size, type, mtime from `stat`.

## Non-goals (record, don't build)

- Drag-and-drop move *within* fileman panes — keyboard/menu ops first; DnD is
  a follow-up.
- Multi-pane / tree view — single-pane navigator stays; a tree is separate.
- Search — not here.

## Acceptance

- Headless: create/rename/copy/paste/delete a file under `/root` via injected
  commands and verify the resulting `readdir`/`stat`; delete on the RO volume
  fails with a clean error, no crash.
- Browser (`os-shell.mjs`): right-click a file → Rename, type a name, Enter →
  the icon relabels; Copy then Paste duplicates it; Delete (with 0093) sends it
  to the Recycle Bin.
