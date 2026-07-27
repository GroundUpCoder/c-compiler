# NetSurf Lane C — UI event coverage (todos/0289)

The browser could run JavaScript (Lane A) and DOM mutation reached the
screen (Lane B), but it could not tell a page what the user did.  Upstream
NetSurf fires exactly three UI events at script — `click`, `keydown` and
window `load` — and the first two carry nothing useful.  This lane closes
that.

## What shipped

The event surface the design doc named, all of it: mousedown/mousemove/
mouseup **with coordinates**, dblclick, keyup, `input`/`change`, a
cancelable `submit`, focus/blur, and a cancelable `wheel`.  Plus the two
things §9.5 called out as Lane C's: keydown now goes to the FOCUSED element
rather than the document root, and Enter/Tab/Backspace/Delete have real DOM
`key` names (Enter used to arrive as `null`, which is why `todo/` adds with
a button).

Two demos that were deliberately withheld are shipped: `paint/` (the one
§8.5 said "needs Lane C's `fire_dom_mouse_event` before a
draw-where-you-clicked canvas is possible at all, not merely nicer") and a
new `events/` page that states what the browser delivers and in what order.

## The four things that were not in the plan

**1. The capture bug was mostly a different bug.**  §8.3 blamed the
per-node registration being keyed by event name.  True, and the smaller
half.  `EventTarget.bnd`'s two listener-list walks indexed the *callback*
instead of the listener *array*, so each walk fell out immediately with
`idx == 0` and **every second `addEventListener` for a type on an element
overwrote the first** — capture or not.  Two plain click handlers on one
button ran as one.  Found by bisecting the failing demo down to a
four-line page and flipping the registration order: whichever listener was
registered SECOND was the only one that ever fired.  That is a symmetry a
"capture is broken" theory cannot produce, and it is what pointed at the
walk rather than at the phase.

**2. A drawing canvas needed a contract, not just coordinates.**  With
mouse events landing, `paint/` still did not draw: netsurf turns
press-and-move over a non-text box into a page-scroll drag handled entirely
at the `browser_window` level, and the content never sees the motion again.
The fix is the standard browser contract — `preventDefault()` on the
`mousedown` suppresses the native drag — and it is worth noticing that
without it the demo would have *looked* like it passed: the page scrolls,
the pad region fills with the heading's pixels, and a naive "is there ink"
probe goes green.  The kernel e2e asserts the page did **not** scroll for
exactly that reason.

**3. The monkey harness silently ate commands.**  Its poll loop `select()`s
on fd 0 but read with `fgets`; one call pulls a whole burst into the stdio
buffer, leaves the fd empty, and `select()` never reports readable again.
Eight lanes never hit it because every driver sent one command and waited
for a marker — and a driver expressing a *gesture* cannot do that, because
the intermediate moves have no marker of their own.  Root-caused (read the
fd, drain buffered lines) rather than paced around with sleeps.

**4. A prototype must not be chosen from an event's type name.**  Gating
the MouseEvent prototype on `type == "click"` means a plain `dom_event`
dispatched as "click" gets MouseEvent's getters, which read past the end of
the struct: `event.pageX` returned `2386872` where `undefined` was the
truth.  The `-DNETSURF_NO_UI_EVENTS` baseline build does exactly that, so
the A/B leg caught it — which is the argument for having the A/B leg.
libdom gained a class tag and the mapping is gated on it.

## Showing the RED

Lane B established the standard (§9.8) and this lane matches it:
`-DNETSURF_NO_UI_EVENTS` restores upstream behaviour exactly, and
`smoke-js.mjs` leg 11 builds that variant from the same tree and requires
the two new demo pages to receive **nothing** while their scripts still
demonstrably run — no mousedown/mousemove/mouseup at all, no capture-phase
step in the propagation trail, a click with no coordinates, and no key
reaching the field.  A demo that passes with and without the change proves
nothing.

## What it left

- `mouseover`/`mouseout`/`mouseenter`/`mouseleave` and `focusin`/
  `focusout` — **todos/0314**.  Not scope-cutting for its own sake: unlike
  everything else here they need the node the pointer was over last time,
  held across calls, and §9.2 is the record of what happens to a box-tree
  pointer that is not re-bound across a live re-conversion.  That wants
  the `reconvert_focus_node` treatment, not a bare `dom_node *last_over`.
- **todos/0313**, P0: a class-selector restyle on an EXISTING element does
  not repaint.  Tripped over while writing the in-OS gate and measured
  three ways (canvas control repaints immediately; `#id.cls` repaints
  late; `.cls.cls` never).  A Lane B residual — nothing in-OS asserted a
  class restyle on an existing element, which is how it survived.  It is
  also why the Lane C e2e probes through canvases: a grey pad then means
  "the event did not arrive" and nothing else.

## Numbers

- `vendor/netsurf/smoke.mjs` (JS off): PASS.
- `vendor/netsurf/smoke-js.mjs`: 12 legs, 0 failures, 144.6 s (both A/B
  baselines rebuilt).
- `tests/kernel/test_netsurf_events_e2e.js`: 18 checks, PASS.
- The wasm grew 5,234,518 → 5,236,309 B (+1,791 B) over the same tree
  without this lane; the `-DNETSURF_NO_UI_EVENTS` baseline links 4,314 B
  smaller than the product build, which is what leg 11 asserts before it
  trusts its own negative.
