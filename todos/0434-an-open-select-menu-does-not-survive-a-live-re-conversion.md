# 0434 — an open select menu does not survive a live re-conversion

- **Status**: open
- **Design**: —

## Goal

Keep an open core select menu alive across a live document re-conversion.

todos/0422 made the core select menu reachable in the gucOS browser. That ticket
deferred this case until the menu existed. The menu exists now.

The gucOS mutation bridge treats a `DOMSubtreeModified` event as a render-tree
edit. The bridge re-converts the document. A re-conversion frees the option list.
The menu object dies with the option list by construction. Therefore an open menu
disappears.

0422 fixed one class of this defect. The form code's own write-back
(`form__select_process_selection`) now sets `html_content.form_selfmutation`, and
the bridge skips the re-conversion. That guard covers the multi-select toggle.

The guard is deliberately narrow. A JavaScript write to `option.selected`, and
any other DOM mutation, still re-converts the document and still dismisses an
open menu. The render state is genuinely stale in that case, so the
re-conversion is correct. Only the loss of the menu is wrong.

## Plan

Carry the menu across the swap. The work has two parts.

1. Snapshot the menu state before the re-conversion. Use the pattern from
   todos/0407.
2. Diff the option list after the re-conversion. Re-attach the menu when the
   list still supports it. Dismiss the menu when it does not.

The second part is the reason this item is not light. A re-conversion can add an
option, remove an option, or change the text of an option. The menu must keep
the correct selection and the correct scroll position across each of those
changes.

Decide the dismiss rule as part of the design. A menu whose selected option no
longer exists cannot re-attach.

## Design

The choke point. The menu object (`form_select_menu`) holds no pointer to an
option. The redraw and the hit test read the live option list on each use. The
menu dies with the list only because `form_select_clear_options` destroys the
menu object. That coupling is the defect. The fix removes it: the death of the
option list no longer destroys the menu. The death of the CONTROL destroys the
menu (`form_free_control`).

The snapshot. `visible_select_menu` stays set across the re-conversion window.
The menu object itself carries the scroll offset, the geometry, and the
scrollbar. The one extra snapshot is the DOM node of the current option, with a
reference held, because `box_select` frees the option structs in the middle of
the window. A mid-window click that moves the selection refreshes the snapshot
(the todos/0407 lesson: a snapshot that ignores the window throws the user's
change away).

The dismiss rule. Option identity is the DOM node, not the text and not the
index. At the end of every re-conversion window, the open menu is DISMISSED
when any of these is true:

1. The gadget has no box on screen. The element left the document.
2. The option list is empty. An empty list gives the menu nothing to show.
3. A current option existed, and no option in the new list carries the same
   DOM node. The menu's anchor is gone.

In every other case the menu RE-ATTACHES: the code measures the geometry again
from the box on screen, updates the scrollbar extents to the new list, keeps
the scroll offset in pixels, and clamps the offset to the new range.

What the rule does for each named case:

- **The selected option is removed.** Rule 3 fires. The menu closes. The
  dismissal fires no `change` event, because the dismissal path never touches
  the selection.
- **The selected option's text changes.** The DOM node is the same node. The
  menu stays open and shows the new text. The highlight stays on that node.
- **An option is inserted above the selection.** The selected node is still in
  the list. The menu stays open. The highlight follows the node, so its row
  index grows by one. The scroll offset does not move.
- **The whole list is replaced.** The old current node is absent. Rule 3 fires
  and the menu closes. When no option was current, no anchor constrains the
  menu, so it re-attaches over the new list.

The scroll rule preserves the OFFSET, not a row anchor. The offset is what the
acceptance can state exactly, the behaviour is predictable, and a row anchor
would need a stable row identity that a replaced list does not have.

Two consequences close holes that the decoupling would open. First,
`form_open_select_menu` measures the geometry on EVERY open, not only on the
first open: a mutation while the menu is closed used to destroy the stale menu
object, and now the object survives. Second, the redraw's scroll skip loop gets
a null guard: a list that shrinks below the kept scroll offset is reachable
now.

No new kill switch. The five earlier re-conversion patches (0386, 0407, 0410,
0412, 0422) carry no per-ticket switch; `-DNETSURF_NO_LIVE_RECONVERT` already
switches the whole bridge layer, and this change is subordinate to it.

## Acceptance

- A JavaScript write to `option.selected` on a different element keeps an open
  menu open. The menu keeps its scroll position and its highlighted row.
- A JavaScript write that removes the selected option dismisses the menu. The
  dismissal fires no `change` event.
- A JavaScript write that appends an option to the open list shows the new
  option. The scroll range grows.
- The five behaviours from todos/0422 still pass: open, scroll, choose, dismiss,
  and multi-select.
- A kernel e2e test covers each case above. Register the test in
  `tests/kernel/run.js` and report the new total.
- The kernel suite and the browser sweep pass at their full counts.

## Result

Fixed on branch `0434-select-menu-reconvert`. The menu object's lifetime is
the control's, not the option list's; `visible_select_menu` rides the window;
the settle rule (the Design section above) re-attaches or dismisses at every
window exit path. Test: `tests/kernel/test_netsurf_select_reconvert_e2e.js`
(the kernel suite grows 133 → 134). Dev log:
`logs/2026-07-30/netsurf-select-menu-reconvert.md`. Image v196 → v197.

Acceptance evidence, bullet by bullet:

- **A write to `option.selected` on a different element keeps the menu
  open, with its scroll and its highlight.** The `survive` leg: the menu on
  a 20-item multi select, scrolled exactly 96 px, a row toggle makes the
  change listener write `option.selected` on a second select. The settled
  shot shows the menu open and the toggled row's band at its
  96px-scrolled position — one sample asserts the highlight and the exact
  offset together — and no band at the unscrolled position.
- **Removing the selected option dismisses the menu without a `change`
  event.** The `remove` leg: the listener removes the option the click
  toggled (the anchor). The settled shot shows the occlusion block fully
  restored (menu closed), and the read-back count is exactly 1 — the
  dismissal fired no second event.
- **Appending an option shows it, and the scroll range grows.** The
  `append` leg: the listener appends a selected option to the open 20-item
  list. The settled shot shows the menu open; scroll-to-clamp then shows
  the appended option's band on the menu's bottom row, a position only
  reachable with a 21-item scroll range.
- **The five 0422 behaviours still pass.** `test_netsurf_select_e2e.js`
  runs green on the fixed tree (open, scroll, choose, dismiss,
  multi-select, and the layout differential).
- **Red control.** On the pristine tree the new test fails exactly the five
  checks that target the fix (both "menu is STILL OPEN" checks and the
  three band checks behind them); the `remove` leg passes there too,
  because the old behaviour also dismissed. Every leg's `#mark` strip
  proves its re-conversion really ran.

Gate (filled at close-out, after the rebase): see the closing commit
message for the suite numbers.

## Notes

This item edits files in the `netsurf` component directory. `vendor/netsurf/update.sh`
lists `netsurf` in `COMPONENTS`, and step 6 removes and re-copies every component
directory. The edits must therefore land in `vendor/netsurf/patches/netsurf.diff`
in the same commit. todos/0423 makes that check automatic, so this item is hard
blocked on 0423 for the same mechanical reason as todos/0431.

Provenance: the 0422 lane surfaced this gap in its close-out report and recorded
it in the 0422 ticket body and dev log. The coordinator filed it here, because a
gap that does not enter `todos/` does not exist.
