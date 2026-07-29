# 0412 — every gadget consumer reads the box on screen

Branch `0412-gadget-screen-box`. Closes `todos/0412`. Files `todos/0422`.

## Why

`todos/0407` found that `control->box` is not the box on screen during a live
re-conversion. Box construction re-binds the pointer to the new tree as it walks the
document, and the layout pass does not touch that new box until the swap. Each
coordinate read from it is therefore zero. 0407 corrected one consumer and added
`form_gadget_screen_box()`. The other consumers stayed on `control->box`.

## The census, and what each site is

A read of a gadget's box is one of two things. A SCREEN read asks where the gadget is,
how large it is, or which pixels to repaint. A STRUCTURAL read binds or unbinds the
pointer. Only a screen read must change.

Screen reads, all converted:

- `form.c` — the select menu's width and font (`form_open_select_menu`), its draw
  (`form_redraw_select_menu`), its drag map (`form_select_mouse_drag_end`), its damage
  (`form_select_menu_callback`), the public bounds (`form_control_bounding_rect`), and
  both repaints in `form_radio_set`.
- `html.c` — the file gadget's repaint.
- `interaction.c` — the open menu's hit test.
- `redraw.c` — the open menu's placement.
- `box_textarea.c` — the Tab and Shift+Tab test for "is this field displayed".

Structural reads, left alone: the binds in `box_special.c`, the unbind in
`box_construct.c`, the re-conversion plumbing in `html.c`, and the accessor itself.
`interaction.c`'s checkbox repaint reads `mas->gadget.box`, which the hit test took from
the displayed tree, so it is already correct.

Two sites the first grep missed: `radio->box` and `html->visible_select_menu->box`. A
grep for `control->box` and `gadget->box` finds neither. The census must be a grep for
`->box` over the tree, then a read of each hit.

## The select text is not a coordinate question

`form__select_process_selection` writes the text a `<select>` displays. That text is a
cache of `control->data.select`, so the decision is which box gets the cache, not which
box has the coordinates. The answer is BOTH, and the reasoning is in
`todos/NETSURF-JS.md` §13. In short: the screen box must show the click at once, and the
new tree's box must hold the text too, because box construction derives it from the DOM
at a moment that can fall either side of the click, and no later step corrects it.

## Two lifetime bugs fell out

`box_select` empties and refills the option list on every pass, and
`form_select_clear_options` destroys the MENU object with it. A `visible_select_menu`
whose `data.select.menu` is NULL is a popup that the next redraw dereferences. So
`box_select` now clears `visible_select_menu` first, and `html_reconvert_box_done` closes
a menu whose gadget lost its box at the swap.

This also answers a question the ticket left open. An open select menu cannot cross a live
re-conversion, and the cause is the option-list rebuild, not the box. The comment in
`html__reconvert` said the gadget's box was dying. Since 0407 that is false, and the
comment now names the real cause.

## The select menu does not exist in gucOS

`nsoption_bool(core_select_menu)` is false by default and the gucOS frontend does not set
it, so the core menu never opens. Without the option the click broadcasts
`CONTENT_MSG_SELECTMENU`, which reaches `guit->window->create_form_select_menu` — an entry
the gucOS window table does not supply, so `gui_factory.c` installs its empty default. A
`<select>` click in the gucOS browser therefore does nothing at all. The same gap makes
`<input type="file">` inert.

Every select-menu path above is correct now, and it is live in the monkey frontend and in
any frontend that sets the option. No gucOS test can reach it. This is `todos/0422`,
register `L62`.

## What the coverage can and cannot say

The acceptance asked for a mid-window shot of a select menu. That shot is not obtainable,
for two independent reasons: the menu does not exist in gucOS, and even where it does
exist `html__reconvert` dismisses it at the start of the window. The coverage delivers
the reachable part.

The new arms are `GC` and `GR`. Both click the same radio on a page that holds a select,
a radio group and 6000 fillers. The fillers are ZERO height, so they widen the window
without pushing the gadgets off screen — this is what lets a click land mid-window on a
gadget the test can still sample. `GC` has no timer, so its click never lands mid-window
and its render is the reference. `GR` ticks, so it is mid-window almost always.

Three assertions. The mid-window click must end in the reference render. It must mirror
the same value through the page's own `change` listener. And the immediate shot must equal
the settled shot, which says the repaint reached the screen at the click rather than at the
next swap.

One limit is worth stating plainly. Unlike the 0407 arm, a wrong render here is not the
steady state: the swap repaints the whole page, so a missed repaint heals within one pass.
The immediate shot must therefore be taken inside that pass. The margin is the window
width against a 300 ms settle, which is why the page holds 6000 fillers and not 3000.

## Gate

Suites derived with `node tests/run.js --diff origin/main`: todos, projects, kernel, sweep.

<!-- GATE NUMBERS -->
