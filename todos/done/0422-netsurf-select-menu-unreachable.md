# 0422 — netsurf: a `<select>` click does nothing in gucOS (no select menu)

- **Status**: done
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

## Resolution (2026-07-30)

Took the core menu, per the plan: `nsoption_set_bool(core_select_menu, true)` in
`gucos/main.c set_defaults` (the `enable_javascript` precedent — Choices and the
command line read over it). Image v196. Register L62 retired.

One real defect surfaced beyond the option flip: the gucOS mutation bridge
(`DOMSubtreeModified` → reconvert) destroyed the open menu under every
multi-select toggle, because `form__select_process_selection`'s own
`set_selected` write-back fires synchronous attribute-mutation events. Fixed
with the `html_content.form_selfmutation` guard (the TEXTAREA/INPUT value-edit
precedent) — the form code renders its own writes, so the bridge skips the
re-box exactly while they run. JS-originated `option.selected` writes keep the
reconvert path, so the menu-dies-under-reconvert deferral in the Notes above is
unchanged — and now that the menu exists, whether to fund the carry-across
treatment (0407-style snapshot + diffed option list) is a decision for the
coordinator.

Coverage: `tests/kernel/test_netsurf_select_e2e.js` — open, scroll (exact 96px
via six scrollbar-arrow presses + the re-mapped row pick), choose (`change`
listener paints an index-encoding colour; widget text repaints), dismiss
(outside click, no event), multi-select (toggle on/on/off with the menu held
open, final DOM state read after dismissal), and the layout half: the widget is
exactly `SCROLLBAR_WIDTH` wider than a `--core_select_menu=0` control window,
whose click still paints nothing. Menu geometry is measured from the
selected-row highlight band, then replayed with computed client coordinates.
