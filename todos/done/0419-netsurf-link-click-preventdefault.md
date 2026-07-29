# 0419 — netsurf: preventDefault() on a link click does not stop the navigation

- **Status**: done (2026-07-29)
- **Design**: —

## Outcome

`html_mouse_action` now keeps the dispatch result. Both helpers already
reported it — libdom's `dom_event_target_dispatch_event` answers false when a
listener cancelled the event, and `fire_dom_event` passes that answer up — so
the fix is to stop discarding it. A cancelled click clears
`mas.result.action` for the three ELEMENT-ACTIVATION actions: `ACTION_SUBMIT`,
`ACTION_NAVIGATE` and `ACTION_JS`. `ACTION_BACK` and `ACTION_FORWARD` stay,
because they are the mouse's own history buttons and need CLICK_4/CLICK_5,
which the click block cannot see.

`ACTION_SUBMIT` is in the set on purpose. A submit button's activation
behaviour IS the submission, and the cancelable `submit` that `form_submit()`
honours is a different event.

Coverage: `tests/kernel/test_netsurf_pointer_e2e.js`, legs "0419 cancelled"
(the listener's restyle paints AND page B does not) and "0419 control" (a
link whose listener does not cancel still navigates).

## Goal

A click listener on an `<a>` element cannot cancel the navigation. The engine
navigates to the `href` target in every case. The listener's visual effects are
also lost, because the navigation replaces the document before the repaint.

Found by the `netsurf-bughunt` lane (2026-07-29) with an in-OS probe page. The
probe is `tests/kernel/nsprobe-subset.js`, probe name `linkjs`. The probe page
has one `<a href="b.html">` with a click listener. The listener sets a class on
a sibling div and calls `e.preventDefault()`. The shot after the click shows
page B (119663 marker pixels) and shows no class restyle (0 pixels).

## Mechanism

The tail of `html_mouse_action` (`content/handlers/html/interaction.c`) fires
the cancelable DOM `click` BEFORE the deferred `ACTION_NAVIGATE` switch. The
order is correct. The defect is that the code ignores the dispatch result. The
`fire_dom_mouse_event(corestring_dom_click, ...)` return carries no
"default prevented" signal to the caller, and `browser_window_navigate` runs
without a condition.

The submit path is the model: the comment at `ACTION_SUBMIT` states that the
cancelable `submit` fires inside `form_submit()`, and that path honours the
cancellation. The click path needs the same plumbing.

## Plan

1. Return or out-param the "default prevented" state from the click dispatch.
2. Skip `ACTION_NAVIGATE` (and `ACTION_JS`?) when the click was cancelled.
3. Extend `nsprobe`-style coverage into a committed e2e leg: cancelled click
   keeps the page AND the listener's restyle is visible; uncancelled click
   navigates. The second half keeps the fix honest — link navigation must not
   break.

The fix touches `vendor/netsurf/`, so it owes an image bump. `todos/0407`
already owes v193 — coordinate the bump.

## Evidence

- `/tmp` probe shots archived to `~/git/meta/meta/media/netsurf-bughunt/probe-linkjs.png`.
- The div-target twin (`setattr` probe) proves click listeners and
  `setAttribute('style')` restyles work when no navigation races them.
