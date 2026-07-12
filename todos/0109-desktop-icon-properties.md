# 0109 — desktop icon Properties popup (the 0092 tail)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WM.md` (desktop shell), `todos/done/0092`. Filed by
  the 0092 closeout audit: fileman got stat()-facts Properties, the
  desktop icon context menu deliberately did not (wm.c has no dialog
  furniture), leaving the Win95 parity gap unowned. Sequenced after 0103
  (icon rename) — both grow the same icon-menu tail, and 0103 builds the
  wm.c inline-editor furniture this can reuse patterns from.

## Goal

Right-click a desktop icon → Properties should show what fileman's
Properties box shows (name, location, type, size, mtime from stat(2)) —
today the icon menu ends at Open/Cut/Copy (0092) plus Delete once 0093
reroutes it and Rename once 0103 lands.

## Plan

- Add a PROPERTIES row to wm.c's icon context menu (below a separator,
  Win95 order: Open / Cut / Copy / Delete / Rename / --- / Properties as
  the rows accumulate across 0093/0103/this).
- Popup: a small borderless top-layer window (the run-dialog/peek
  furniture pattern — wm.c is not a win32 app, no MessageBox): stat facts
  rendered with draw_text, dismissed by Esc / focus-leave / an OK strip,
  one at a time like the other popups.
- Reuse fileman's fact list verbatim (type told by S_ISLNK/S_ISDIR/
  ow_is_runnable — "Shortcut (symlink)" for the launcher links).
- Goldens: the icon menu height moves again (120x76 → +sep+20); the
  ctxmenu tests' move-together rule applies (test_ctxmenu_e2e.js +
  os-ctxmenu.mjs).

## Acceptance

- Headless: right-click a desktop icon → Properties → the popup surface
  exists and a `wmctl shot` shows rendered text; Esc dismisses; the facts
  match `stat` (drive by creating a file of known size/mtime).
- Browser: the popup composites over the desktop and dismisses on
  outside click.
