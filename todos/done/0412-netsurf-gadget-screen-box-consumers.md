# 0412 — netsurf: the remaining gadget consumers still read the un-laid-out box mid-window

- **Status**: done
- **Design**: —

## Verdict (2026-07-29, branch `0412-gadget-screen-box`)

Done. Every screen-coordinate read of a gadget's box now goes through
`form_gadget_screen_box()`, and each consumer handles the NULL return.

The census is wider than this ticket's list, in two directions. A grep for
`control->box` and `gadget->box` MISSES two sites — `radio->box` and
`html->visible_select_menu->box` — so the census has to be a grep for `->box` over
the whole tree. And two of the sites listed here are one site: `form_redraw_select_menu`
uses its box only for the popup's left border and padding, while `box_coords` of the
new box is `form_select_menu_scroll_callback`'s sibling, `form_select_mouse_drag_end`.
Converted: the select menu's width, font, draw, drag map, damage and hit test; the
public `form_control_bounding_rect`; both `form_radio_set` repaints; the file
gadget's repaint; and `box_textarea.c`'s Tab and Shift+Tab "is this field
displayed" test. Left alone, deliberately: box construction's binds and unbind, the
re-conversion plumbing, and the accessor. `interaction.c`'s checkbox repaint reads
`mas->gadget.box`, which the hit test already took from the displayed tree.

**Step 2 — the select-text rewrite.** Decision: write BOTH boxes. The text is a
cache of `control->data.select`, not a coordinate, so it is derived once
(`form__select_set_box_text`) and written to the screen box AND to the new tree's
box. Reasoning recorded in `todos/NETSURF-JS.md` §13.

**Two lifetime bugs fell out, both fixed at the root.** `box_select` now clears
`visible_select_menu` before `form_select_clear_options`, which destroys the menu
OBJECT — a `visible_select_menu` whose `data.select.menu` is NULL is a popup the
next redraw dereferences. And `html_reconvert_box_done` closes a menu whose gadget
lost its box at the swap. The `html__reconvert` comment blaming the dying box is
replaced: since `todos/0407` that is false, and the real reason an open menu cannot
cross a re-conversion is the option-list rebuild.

**Half of the acceptance is UNOBTAINABLE, and `todos/0422` carries it.** A
mid-window shot of a select MENU cannot be taken, for two independent reasons.
`core_select_menu` is false and the gucOS window table supplies no
`create_form_select_menu`, so a `<select>` click in the OS opens nothing at all.
And even where the menu exists, `html__reconvert` dismisses it at the start of every
window. The converted code is correct and live in the monkey frontend; no gucOS test
can reach it.

The reachable half is gated. `test_netsurf_mutation_e2e.js` grows the GC/GR pair: the
same radio click on a still page and on a page that is mid-re-conversion essentially
always. It reads WHICH radio is selected off the selection blob's row, because an ink
count cannot see a selection MOVE. Red control: reverting only the two
`form_radio_set` lines makes the immediate mid-window shot read the old radio
(`gr1=50` against a settled 130) and fails exactly the two checks that target the bug.

Gate: kernel 129/129, sweep 41/41, projects 29/29, todos 5/5, flake 3/3 at 0 %.
`os/image.json` stays at 193 — this rides the bump `todos/0407` already made.
Retires register `L60`; files `todos/0422` with register `L62`.

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
