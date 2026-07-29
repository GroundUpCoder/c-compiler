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

## Notes

This item edits files in the `netsurf` component directory. `vendor/netsurf/update.sh`
lists `netsurf` in `COMPONENTS`, and step 6 removes and re-copies every component
directory. The edits must therefore land in `vendor/netsurf/patches/netsurf.diff`
in the same commit. todos/0423 makes that check automatic, so this item is hard
blocked on 0423 for the same mechanical reason as todos/0431.

Provenance: the 0422 lane surfaced this gap in its close-out report and recorded
it in the 0422 ticket body and dev log. The coordinator filed it here, because a
gap that does not enter `todos/` does not exist.
