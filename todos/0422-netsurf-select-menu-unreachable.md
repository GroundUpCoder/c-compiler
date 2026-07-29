# 0422 — netsurf: a `<select>` click does nothing in gucOS (no select menu)

- **Status**: open
- **Design**: —

## Goal

A `<select>` in the gucOS browser does not open. The user can see the widget and its
current option, but a click has no effect, so no page with a drop-down list is usable.

Found while writing the `todos/0412` coverage. NetSurf offers a select menu two ways, and
gucOS takes neither:

- The CORE menu. `interaction.c` opens it only when `nsoption_bool(core_select_menu)` is
  true. The option is `false` by default (`desktop/options.h`) and
  `vendor/netsurf/gucos/options.h` does not set it, so the core menu is dead code in the
  OS build.
- The FRONTEND menu. Without the option, the click broadcasts `CONTENT_MSG_SELECTMENU`,
  which `browser_window.c` sends to `guit->window->create_form_select_menu`. The gucOS
  window table (`gucos/gui.c`) does not supply that entry, so `gui_factory.c` installs its
  empty default.

The same gap makes `<input type="file">` inert: `file_gadget_open` is also unset, so
`CONTENT_MSG_GADGETCLICK` reaches an empty default.

## Plan

1. Choose the menu. The core menu is the cheaper one — it draws in the content and needs
   no window furniture — and `todos/0412` already made every one of its screen-coordinate
   reads correct. Set `core_select_menu` in the gucOS options. Note that
   `nsoption_bool(core_select_menu)` also changes the select's LAYOUT
   (`layout.c` sizes the box against the option list), so the widget itself changes size.
2. Cover it: open, scroll, choose, dismiss, and the multi-select case.
3. Decide the file gadget separately. It needs a file dialogue, which is a frontend
   window, not a content popup.

## Notes

An open menu cannot survive a live re-conversion, and this is by construction, not an
oversight: `box_select` empties and refills the option list on every pass, and
`form_select_clear_options` destroys the menu OBJECT with it. `html__reconvert` therefore
dismisses the menu at the start of the window, and `box_select` clears
`visible_select_menu` before it clears the options (`todos/0412`). A page that re-boxes
under an open drop-down closes it. Carrying the menu across the swap needs the treatment
the focus got in `todos/0407` — a DOM node snapshot re-bound after the swap — plus an
option list that is diffed rather than rebuilt. Decide whether that matters once the menu
exists at all.

## Acceptance

- A click on a `<select>` in the gucOS browser opens a menu, and choosing an option
  changes the displayed value.
