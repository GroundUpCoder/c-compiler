# 0412 — netsurf: the remaining gadget consumers still read the un-laid-out box mid-window

- **Status**: open
- **Design**: —

## Goal

`todos/0407` established that `control->box` is NOT the box on screen during a live
re-conversion. Box construction re-binds it to the new tree as it goes, and that box has
no coordinates until the swap reformats. `form_gadget_screen_box()` (declared in
`content/handlers/html/form_internal.h`) returns the displayed box, and 0407 converted
the ONE consumer its acceptance covered: `box_textarea_callback` — the text widget's
damage rectangle, drag owner and caret position.

The other gadget consumers still read `control->box` directly. Each takes screen
coordinates from it, so each renders at the origin, or at zero size, for the whole
window. The window is 1-2 ms on a normal page and the whole tick period on a page that
re-boxes continuously (`todos/NETSURF-JS.md` §12).

Known sites, all in `content/handlers/html/`:

- `form.c` `form_open_select_menu` — `menu->width` from `box->width` (zero) and the font
  from `control->box->style`.
- `form.c` `form_redraw_select_menu` and `form_select_menu_scroll_callback` —
  `box_coords` of the new box places the popup at the document origin.
- `form.c` `form_control_bounding_rect` — `box_bounds` of the new box.
- `form.c` the select and radio repaints through `html__redraw_a_box(html,
  control->box)` — a zero-size damage rectangle repaints nothing.
- `html.c` `gadget->box` in the file-gadget path.

`form.c`'s select-text rewrite (`inline_box = control->box->children->children`) is a
different question, not a coordinate one: it edits the NEW tree's box, so the text is
right after the swap and stale on screen until then. Decide it with the rest.

## Plan

1. Convert each screen-coordinate consumer to `form_gadget_screen_box()`, and handle the
   NULL return the way `box_textarea.c` does — NULL means the gadget has nothing on
   screen.
2. Decide the select-text rewrite case explicitly and record the answer.
3. Add a mid-window arm to the select and checkbox coverage, on the
   `test_netsurf_mutation_e2e.js` pattern: an immediate shot must equal the settled shot.

## Acceptance

- No screen-coordinate read of a gadget's box goes through `control->box`.
- A mid-window shot of a select menu and of a radio group equals the settled shot.
