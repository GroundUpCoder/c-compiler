# todos/0427 — a held button reported as released before the motion cleared DRAG_SLOP

## The defect

jku reported the defect by email on 2026-07-29. A press followed by a small
motion looked like a release. The paint demo could not draw a stroke.

The cause is in `vendor/netsurf/gucos/gui.c`, in `gucos_mouse_state()`. The
function computed the `HOLDING_*` bits inside `if (gw->dragging)`. The
`HOLDING_*` bits describe `gw->mouse_pressed`, not the drag. The flag
`gw->dragging` becomes true only after the motion goes past `DRAG_SLOP`
(5 px). The function `gucos_mouse_motion()` ends with an unconditional call
of `browser_window_mouse_track()`. Thus a press plus a 1-5 px motion sent a
track with no held buttons to the core.

The core reads such a track as a release. `html_fire_mouse_events()`
(`interaction.c:1692`) makes a DOM `mouseup` from a track that has no
`HOLDING` or `DRAG` bits after a press. The spurious `mouseup` stopped each
drag on each page inside the first 5 px.

## The fix

Keep the two facts separate. `DRAG_ON` is a statement about a drag. The
`HOLDING_*` bits are a statement about a button. Only `DRAG_ON` stays behind
`gw->dragging`. The `HOLDING_*` bits now come from `gw->mouse_pressed` at
all times. `DRAG_SLOP` keeps its value and its function: it still stops the
promotion of a small jitter into a drag.

## The safety survey of the core consumers

A track can now carry `HOLDING_1` without `DRAG_ON`. I examined each core
consumer of these bits before the change:

- `interaction.c:1692` — the `mouseup` synthesis. The sub-slop track is no
  longer a release. This is the fix.
- `html_mouse_buttons()` (`interaction.c:1597`) — the DOM `buttons` mask.
  A sub-slop `mousemove` now reports `buttons=1`. This is the correct DOM
  behavior.
- `html_update_dynamic_chains()` (`interaction.c:2175`) — `:active` stays
  on the pressed element through the sub-slop window. Before the fix, the
  sub-slop track cleared `:active`. The fix cures this second defect.
- `selection_click()` (`selection.c:319`) — a track with only `HOLDING_1`
  matches no branch and returns false. Safe.
- `scrollbar.c:782` — the code demands `HOLDING_*` and `DRAG_ON` together.
  Safe.
- `textarea.c:3179` — the `HOLDING_*` branch also demands an active
  selection drag. Safe.
- `browser_window.c:2304` and `interaction.c:353` — the drag-end checks
  read `!mouse`. A sub-slop track is no longer zero, so these checks can no
  longer fire early. The fix removes this hazard.

The release path in `gucos_mouse_button()` (`gui.c:781`) passes a literal
zero and stays correct. A drag end fires one `mouseup`. A click fires one
`mouseup` through `CLICK_1`. The new test counts both.

## The regression test

The test is `tests/kernel/test_netsurf_dragslop_e2e.js`. It boots the OS
and drives real SDL input through the gucOS frontend. A monkey-side test
cannot see this defect: `smoke-js.mjs` drives `nsmonkey.wasm`, and the
monkey frontend never executes `gui.c`.

The probe page logs each mouse event to the console with the coordinates
and the `buttons` value. The console lines reach the boot stderr
(todos/0421). The kernel input ring keeps the injection order, so the line
order is the event order. A sentinel motion changes the window title; the
wait on that title is the flush barrier.

The test drives three gestures. Gesture one: a press, a 3 px motion, a
40 px motion, a release. Gesture two: a click with no motion. Gesture
three: a press, a 3 px motion, a release inside the slop. The test asserts:
no `mouseup` before a release, one `mouseup` per release, and a `mousemove`
with `buttons=1` in the sub-slop window.

## The answer on the first paint report

The first report said "I see a single dot". We then concluded that jku
clicked without a drag. The code refutes that conclusion as the full story.
`paint.js` sets `drawing = true` on `mousedown` and clears it on `mouseup`.
A motion paints only while `drawing` is true. On the defective engine, the
first motion of a real drag arrives inside 5 px and fires the spurious
`mouseup`. The flag falls, and the rest of the drag paints nothing. Thus a
genuine drag attempt also produces one dot. The defect was present the
whole time, and the demo-visual work (todos/0425) was never the whole
story.

## Verification

Phase 1 (this branch, lock-free): the netsurf projects compile passed
(1 passed, 73.7 s). The todos suite passed (5/5, 14.8 s). Phase 2 (after
the coordinator GO): show the new test red on the unfixed `gui.c`, show it
green on the fix, then run the full kernel suite and the full browser
sweep, and tally `results[].status` in both artifacts.
