# 0091 — Right-click context menus (popup primitive + core surfaces)

- **Status**: open
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
