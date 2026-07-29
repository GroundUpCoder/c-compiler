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

## Two test-harness facts found on the way

The dukky `document.title` setter is a stub (`genjs/duktape/document.c`).
A dynamic retitle from a page never reaches the window. Do not use a
title change as a wait marker for a JS action. The test uses a sentinel
div class flip instead, and polls the pixels; the 0316 restyle path
proves that channel. A body-class background restyle does not repaint
either; flip a normal element.

A page that wants drag events must call `preventDefault()` on the
`mousedown`. Without it, the DRAG_SLOP promotion starts a core
page-scroll drag, and the core consumes those tracks before the DOM.
The paint demo has the same call for the same reason.

## Verification

The red proof and the green proof ran on one test text. On the unfixed
`gui.c`, the test fails 10 named checks. The log shows the spurious
`mouseup` at (103,102), 3 px after the press at (100,100), before any
move. It shows 4 mouseups and 4 mousedowns for 3 gestures; the extra
mousedown is the synthetic one the core owes when it thinks a click had
no press. On the fixed `gui.c`, the test passes 16 of 16 checks.

The full gates ran on the tree rebased onto main `18c1e286`. The kernel
suite: 132 passed, 0 failed (1114.2 s); the artifact shows one run, no
filter, no resume, no carry, 132 selected = executed = recorded. The
browser sweep: 42 passed, 0 failed (808.1 s); the artifact shows one
run, no filter, no resume, no carry, 42 = 42 = 42. A first sweep run
failed one file, `os-boots.mjs`, at the "vi edits a file through xterm"
leg; that leg does not execute netsurf code, and the clean full re-run
confirms a flake. The todos suite: 5/5 (12.0 s). The netsurf projects
compile: 1 passed (73.7 s).
