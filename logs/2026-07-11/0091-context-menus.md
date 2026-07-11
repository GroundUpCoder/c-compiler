# 0091 — Right-click context menus (popup primitive + core surfaces)

Right-click did nothing anywhere — the loudest "this is a toy" tell. This
lands the Win95 answer on all four planned surfaces: the wm.c popup
(desktop / icon / taskbar-button menus) and the user32 EDIT menu over the
0068 TrackPopupMenu primitive. Item: `todos/done/0091-context-menus.md`.

## What landed where

**os/wm.c** — a two-window popup: root "ctxmenu" + at most ONE "ctxmenu2"
flyout (the recorded v1 depth cap). Deliberately NOT the Start-menu column
machinery: menus here are fixed item lists (`ctx_ent` tables with
SEP/GRAY/SUB flags), not directory scans, and the taskbar/icon menus carry
per-open state (the acted-on sid, the clicked icon index). What IS reused
is the furniture pattern: borderless windows parked at their EV_CREATED
echo, top layer, root holds kernel focus (a flyout hands it back at its
echo — the 0078 rule), dismissed on focus-leave/outside-click/Esc/
EV_SCREEN, drawn every frame from the same 5x7 font + fill helpers.

- **Empty desktop**: New ▸ (Folder / Text File with the Win95 uniquifier
  "New Folder", "New Folder 2", …), Sort by ▸ Name (= unlink `.icons`;
  auto-flow IS the sorted 0029 layout), Refresh (desk_load now, not at the
  coarse tick), Display (→ `ctlpanel Display`).
- **Icon**: right-click selects it alone unless already in the selection
  set (the Win95 rule), then Open through the one activate() path. The
  0092 file ops (Cut/Copy/Rename/Delete/Properties) grow here.
- **Taskbar button**: Restore/Minimize/Maximize/Close over the chrome ops
  this process already owns (WMP_FOCUS restore, WMP_MINIMIZE,
  title_activate for maximize, WMP_CLOSE_REQ — request-close, like the
  'x' box). Inapplicable rows gray at open (state snapshot — the popup is
  transient by design); a gray row never fires and leaves the menu open.
  The Start strip and the empty bar deliberately raise NOTHING — that
  menu is 0101's; window title bars are 0102's.

**os/win32/user32.c** — the EDIT control's standard WM_CONTEXTMENU menu
(Undo/Cut/Copy/Paste/Delete/Select All), built fresh per popup with state
gating: Cut/Copy need a selection, Paste needs clipboard text + rw,
Select All needs content, Undo is ALWAYS grayed (no undo buffer — the
recorded 0048 scope; PORTS.md already carries the demand). The 0068
popup primitive grew what it was missing: modal keyboard nav
(`menu_route_key` — Up/Down walk enabled rows, Enter fires, Esc closes,
everything else swallowed; an open menu is modal for the keyboard like it
already was for the mouse) and right-button-down-outside closes. Popup
items were already agent targets (`popupmenu` in `wmctl tree`, click by
label) — the EDIT menu inherits that for free, which is exactly how the
headless test drives it.

**os/win32/ctlpanel.c** — `ctlpanel <Applet>` opens that applet alongside
the hub (case-insensitive icon-label match), so the desktop menu's
Display item is just an argv spawn. Image v51 → v52.

## The one bug the tests caught

"One popup at a time" (menu_toggle → ctx_dismiss) exposed a focus-fall
race: destroying the focused ctxmenu makes kernel focus fall to an app
window, and that EV_FOCUS arrived BEFORE the fresh Start menu's create
echo — the 0028 dismissal rule (`mdepth > 0 && !menu_owns_sid`) killed
the menu it had just opened. The fix is the gate the run dialog (0078)
and the ctx menu itself already used: dismissal only once the root echo
has landed (`mcol[0].sid`). The hazard window closes at EV_CREATED, which
precedes any create-focus echo.

## Test traps worth remembering

- `wmctl list` is Z-ORDERED — "the winbox row" is not the first match
  when several are up; pick by lowest sid for the oldest window.
- `wmctl tree` dumps the menu BAR of every window before the `popupmenu`
  section — scope item-state asserts to the text after the `popupmenu`
  line or you assert against notepad's bar Edit menu.
- Browser: the VT2 switch can queue one more screen-resize whose
  EV_SCREEN dismisses popups (screen_changed) — quiesce ~1.5s after the
  settle predicate before the first right-click. The settle predicate
  passes early because `__osScreen` already matches from boot.
- Playwright right-click just works: os.html forwards raw DOM buttons and
  suppresses `contextmenu`; compositor.js maps DOM→SDL (+1).

## Tests

`tests/kernel/test_ctxmenu_e2e.js` — 42 checks: geometry goldens for all
three wm menus + both flyouts (anchor + work-area clamp), Esc/outside-
focus/one-popup-at-a-time dismissal, mouse + keyboard flyout cascades,
New Folder / New File / Sort-by-Name / Refresh side effects, icon-menu
Open (winbox +1), Display → ctlpanel argv, EDIT menu state gating +
agent-click Paste of the 0090 clipboard, taskbar menu grayed-RESTORE /
minimize/restore/maximize/close, and pixel goldens (menu face, groove,
flyout arrows, selection strip). `tests/browser/os-ctxmenu.mjs` — the
same skeleton over REAL browser input (page.mouse right-clicks,
page.keyboard nav), with VT1-shell verification (`test -d`, `wmctl
gettext`). Both pass; kernel suite + browser regression legs run at
close (see `build/test-kernel/summary.json`).
