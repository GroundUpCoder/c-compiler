# 0289 — NetSurf Lane C — UI event coverage (capture-phase listeners, click coordinates, fire_dom_mouse_event)

- **Status**: DONE (2026-07-27)
- **Design**: `todos/NETSURF-JS.md` §"Lane C — UI event coverage" (full scoping there;
  read past §8/§9, which fold in what Lanes A and B found the document had wrong).

## Goal

NetSurf's JS can run (Lane A) and DOM mutation now re-boxes and repaints (Lane B), but the
browser still cannot deliver most user input to JS. Lane C closes that.

Filed 2026-07-27: Lanes A and B **landed** (2026-07-25 / 2026-07-26) and C–E were left "open"
in the design doc only. A topic doc is **not** the scheduling system — nothing in `todos/`
mentioned Lane C, so it was unscheduled work that looked scheduled. That is the class `0286`
exists to prevent.

## Scope (from the design doc)

- `interaction.c` fires the missing DOM events through the existing
  `fire_generic_dom_event` / `fire_dom_keyboard_event` plumbing (`html.c:111`, `:133`):
  mousedown/mouseup/mousemove **with coordinates** — needs a `fire_dom_mouse_event` that fills
  MouseEvent init (the KeyboardEvent path is the precedent for the shape) — plus dblclick,
  keyup, `input`/`change` from the form-gadget editing path, cancelable `submit` before native
  `form_submit` (`interaction.c:1412`), focus/blur, and wheel.
- **Un-cripple `js_fire_event`** (`dukky.c:1567`) to dispatch arbitrary targets/types. Two
  known consequences of today's crippled version: **capture-phase listeners never fire at all**,
  and **click carries no coordinates**.
- Rate note: mousemove under the 10 ms `setTimeout` clamp is fine; JS handlers run on the main
  loop. Keep dispatch behind "listeners registered" checks (dukky already tracks registration)
  so non-JS pages pay nothing.

## Why this matters beyond the browser

**Lane C unblocks withheld demos.** `paint.html` and the breakout demo were deliberately not
shipped because they need `fire_dom_mouse_event` first (design doc §8). Landing C is what makes
those demos possible, so this is user-visible work, not just plumbing.

## Outcome

Landed as scoped, plus four things the plan did not have — the real cause
of the capture bug (any second `addEventListener` for a type on an element
replaced the first, capture or not), the `preventDefault()`-suppresses-the-
native-drag contract a drawing canvas needs, a monkey harness that ate
every command after the first of a burst, and a prototype-by-type-name
hazard that read coordinates off the wrong struct.  All four are written up
in `todos/NETSURF-JS.md` §10 and `logs/2026-07-27/netsurf-lane-c.md`.

Deferred with tickets: `mouseover`/`mouseout`/`mouseenter`/`mouseleave` and
`focusin`/`focusout` (`todos/0314` — they need a box-tree pointer held
across calls, which is the §9.2 class).  Found and filed: `todos/0313`
(P0), a class-selector restyle on an existing element does not repaint —
a Lane B residual this lane measured.

## Acceptance

- Per the design doc's gate: **demo 6's input half** works, plus an event-order e2e via console
  sentinels in `smoke-js`.
- Capture-phase listeners fire, in the correct order relative to bubble phase.
- A click handler receives real coordinates (asserted, not eyeballed).
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
