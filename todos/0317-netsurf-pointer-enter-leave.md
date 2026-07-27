# 0317 — NetSurf: mouseover/mouseout/mouseenter/mouseleave and focusin/focusout (Lane C deferral)

- **Status**: open
- **Design**: `todos/NETSURF-JS.md` §10 (what Lane C, `todos/0289`, left).

## Goal

Lane C landed the UI event surface its scope named — mousedown/mouseup/
mousemove with coordinates, dblclick, keyup, input/change, cancelable
submit, focus/blur and wheel.  Two neighbouring families were deliberately
NOT done, and this is them:

- **`mouseover` / `mouseout` / `mouseenter` / `mouseleave`.**  Unlike every
  event Lane C shipped, these are not a function of ONE input event: they
  need the node the pointer was over LAST time, held across calls.  That
  pointer would live on the html content, which means it points into the
  box tree — and Lane B's §9.2 is the record of what happens to something
  that points into the box tree and is not re-bound across a live
  re-conversion (focus was silently dropped; typing died at the first
  mutation).  A stale node reference is worse than a missing event, so it
  needs the re-bind treatment (`reconvert_focus_node` is the pattern), not
  a quick `dom_node *last_over`.
- **`focusin` / `focusout`.**  focus/blur ship and do not bubble, which is
  correct; the bubbling twins are simply not generated anywhere.  They are
  cheap once the focus choke exists (`html_set_focus` already computes the
  old and new nodes) — the only real question is ordering against
  focus/blur, which the spec pins.

Neither has a demo blocked on it, which is why they waited; both are part
of "the event surface", which is why they are a ticket rather than a
paragraph.

## Plan

1. `mouseenter`/`mouseleave` are the non-bubbling pair and need the
   ancestor-chain diff, not just the deepest node — do the chain walk once
   and derive all four from it.
2. Hold the remembered node as a REFERENCED `dom_node *` on the content and
   re-bind (or drop) it at the re-conversion swap, next to
   `reconvert_focus_node`.  A `dom_node` outlives its box, so referencing
   the node rather than the box is what makes this safe.
3. `relatedTarget` is already plumbed through `fire_dom_mouse_event`'s
   MouseEvent init — it is passed NULL today and is exactly what these
   events are supposed to fill in.

## Acceptance

- The four pointer events fire with correct targets and `relatedTarget`,
  including across a Lane B re-conversion (the A/B a static page vs a
  mutating one, the `test_netsurf_mutation_e2e` typing-leg pattern).
- `focusin`/`focusout` bubble where focus/blur do not.
- A `smoke-js.mjs` leg, and the events demo page extended to report them.
