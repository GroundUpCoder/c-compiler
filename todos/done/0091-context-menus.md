# 0091 — Right-click context menus (popup primitive + core surfaces)

- **Status**: done (2026-07-11). All four planned surfaces landed. wm.c grew
  a two-window popup ("ctxmenu" root + one "ctxmenu2" flyout — the recorded
  v1 depth cap): empty desktop (New ▸ Folder/Text File with Win95
  uniquifier, Sort by ▸ Name = forget `.icons`, Refresh, Display →
  `ctlpanel Display` via new applet-by-name argv), icon (right-click
  selects-alone-unless-in-set + Open through activate(); 0092 file ops grow
  here), taskbar button (Restore/Minimize/Maximize/Close over the chrome
  ops, inapplicable rows grayed and gray rows never fire; Start strip +
  empty bar stay reserved for 0101, title bars for 0102). Same furniture
  rules as the Start menu: top layer, root holds focus, focus-leave/
  outside-click/Esc/EV_SCREEN dismiss, arrows/Right/Left/Enter navigate,
  one popup at a time (the toggle path exposed a focus-fall race — the
  start-menu EV_FOCUS dismissal is now gated on its root echo, the 0078
  run-dialog precedent). user32's EDIT grew the standard WM_CONTEXTMENU
  menu (Undo/Cut/Copy/Paste/Delete/Select All, state-gated per popup;
  Undo stays grayed — no undo buffer, recorded 0048 scope) over the 0068
  TrackPopupMenu primitive, which grew modal keyboard nav
  (Up/Down/Enter/Esc, other keys swallowed) and right-down-outside close;
  fileman's path EDIT gets the menu for free (its file-list menu is 0092).
  Image v51 → v52. Tests: `tests/kernel/test_ctxmenu_e2e.js` (42 checks)
  + `tests/browser/os-ctxmenu.mjs` (real right-clicks + keyboard, VT1
  shell verification). No residue beyond what 0092/0101/0102 already
  carry.
- **Design**: `todos/WIN32.md` (USER32 menus), `todos/WM.md` (borderless popup
  surfaces — the Start menu 0028 and OpenWith picker 0072 are the existing
  pattern to reuse). Implements `TrackPopupMenu`/`CreatePopupMenu` in
  `os/win32/user32.c`; wires the desktop (`os/wm.c`), fileman, and EDIT fields.

## Goal

Right-click does nothing anywhere — the loudest "this is a toy" tell. Win95/7
put a context menu on every surface. Build the reusable popup-menu primitive
once and wire the high-traffic surfaces; this also unblocks several 0076
"Rooms" (desktop New▸/Sort/Refresh, edit-field menus) and pairs with fileman
ops (0092).

## Plan

- **The primitive** — `CreatePopupMenu`/`AppendMenu`/`TrackPopupMenu` in
  `os/win32/user32.c`, rendered as a borderless top-layer surface (same
  mechanism as the Start menu: grabs top layer, dismiss on outside-click/Esc,
  keyboard arrow/Enter nav, separators, checkmarks, disabled items). Returns
  the chosen command id (or posts `WM_COMMAND`).
- **Desktop** (`os/wm.c`) — right-click empty desktop → New ▸, Sort by ▸,
  Refresh, Display Properties (→ ctlpanel Display, 0089). Right-click an icon →
  Open, plus a hook for the file menu once 0092 lands.
- **EDIT control** — right-click a text field → Undo/Cut/Copy/Paste/Select All
  (Cut/Copy/Paste through the 0090 clipboard).
- **Taskbar** — right-click a button → Restore/Minimize/Maximize/Close
  (reuses the existing chrome ops).

## Non-goals (record, don't build)

- Owner-drawn/icon menu items, cascading submenus beyond one level for v1
  (Win7 fly-out depth can come later).
- The Start menu restyle itself — that's 0078 (this just shares the primitive).
- Jump lists (explicit non-goal, 0078).

## Acceptance

- Headless: injected right-click on the desktop opens a menu; `wmctl`-driven
  selection of "Refresh" re-scans the icon grid; right-click a taskbar button →
  Close closes the window.
- Browser (`os-shell.mjs`): right-click desktop, EDIT field, and a taskbar
  button each raise the correct menu; outside-click and Esc dismiss; keyboard
  nav selects.
