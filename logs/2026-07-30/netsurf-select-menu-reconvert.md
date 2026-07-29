# An open select menu survives a live re-conversion (todos/0434)

## The choke point was one coupling, not seven sites

The menu object (`form_select_menu`) holds no pointer to an option. The
redraw and the hit test read the live option list on each use. The menu died
with the list for one reason only: `form_select_clear_options` destroyed the
menu object. Every earlier path that killed an open menu — the proactive free
at `html__reconvert`, the destroy inside `box_select`'s refill — existed to
keep that coupling safe. The fix removes the coupling: the option list's
death no longer destroys the menu, and the CONTROL's death does
(`form_free_control`, which also stops the content from naming the menu).

## The dismiss rule (see the ticket's Design section)

Option identity is the DOM node. At the window's end the menu dismisses when
the gadget lost its screen box, when the list is empty, or when the anchor —
the current option's node, snapshot at the window start — is absent from the
rebuilt list. Otherwise it re-attaches: geometry re-measured, scrollbar
extents updated, scroll offset kept in pixels and clamped.

Rejected alternatives, and why:

- **Widen the 0422 guard** (skip the re-conversion). The render state is
  genuinely stale after a JS write; the re-conversion is correct. Only the
  loss of the menu was wrong. The ticket forbids this, and it is right.
- **Snapshot-and-rebuild** (free the menu, reopen it at the swap). More
  state to carry (offset, geometry, callback), and it recreates an object
  that never needed to die. Keeping the object IS the snapshot for
  everything except the anchor.
- **Anchor the scroll to a row instead of a pixel offset.** A replaced list
  has no stable row identity to anchor to, and the acceptance needs the
  exact offset only for the unchanged-list case. The pixel rule is the one
  we can state and test exactly.
- **A per-ticket kill switch.** The five earlier re-conversion patches
  (0386, 0407, 0410, 0412, 0422) carry none; `-DNETSURF_NO_LIVE_RECONVERT`
  switches the whole bridge layer and this change is subordinate to it. The
  red is shown by the test instead (see below).

## Gotchas that shaped the code

- **The snapshot must follow a mid-window click.** The old option structs die
  at `box_select`'s refill, in the middle of the window, so the anchor is
  taken at the window start. A click that moves the selection during the
  window must move the anchor with it (`form__select_process_selection`), or
  the settle rule would judge the wrong option — the todos/0407 lesson again.
- **The multi-select `current` distinguishes remove-anchor from no-anchor.**
  After the refill, `data.select.current` points into the NEW list, so it
  cannot testify about the old one. `reconvert_menu_had_current` carries the
  difference between "no option was ever current" (re-attach freely) and
  "the current option's node vanished" (dismiss).
- **Decoupling opened two holes, both closed here.** A CLOSED menu object now
  survives list changes too, so `form_open_select_menu` re-measures on every
  open (one shared measure function; the first open, every re-open and the
  re-attach cannot drift apart). And the redraw's scroll-skip loop needed a
  null guard: a kept scroll offset can exceed a list that shrank mid-window.
- **`scrollbar_set_extents` rescales the offset proportionally.** The design
  wants pixel preservation, so the refresh reads the offset first and puts it
  back through `scrollbar_set`, whose clamp handles a shrunken range.
- **The settle must run on EVERY window exit path** — the swap, the two
  failure paths inside `html__reconvert`, and the done-callback failure path
  — or the snapshot's node reference leaks. `html_destroy` drops the ref a
  dying window leaves behind.

## The test trigger is deterministic, not a timer

While a core menu is open, all mouse routing goes to the menu, so no page
element can be clicked to fire a mutation. But a multi-select row click keeps
the menu open (0422) and fires `change` synchronously — the change listener
IS the in-window mutation vehicle. Each leg's listener also flips a `#mark`
strip that only paints through the re-conversion, so a shot that settled
early fails loud instead of passing vacuously. One band sample at the
96px-scrolled row position asserts the highlight and the exact scroll offset
together.

Red control (pristine tree, before commit): exactly the five checks that
target the fix fail — both "menu is STILL OPEN" checks and the three band
checks behind them — and the remove leg passes unchanged, because the old
behaviour also dismissed. Green on the fixed tree: 49/49 checks.

`tests/kernel/test_netsurf_select_reconvert_e2e.js`, registered in
`tests/kernel/run.js`: the kernel suite is now 134 files. Image v196 → v197
(netsurf is an image.json project).
