# 0427 — a held button reports as released until motion clears DRAG_SLOP (spurious mouseup)

- **Status**: done
- **Design**: —
- **Reported by**: jku, 2026-07-29, direct user report by email.

## Goal

A press followed by small motion must not look like a release. Today it does.

> *"When I click down, the up event looks like it triggers even when I haven't lifted
> the button… I can't 'drag' make a lot of boxes fast. The sample requires me to click
> many times."* — jku

### Root cause — CONFIRMED at source, `vendor/netsurf/gucos/gui.c`

`gucos_mouse_state()` (`gui.c:704`) builds the reported state like this:

```c
browser_mouse_state st = 0;
if (gw->dragging) {
        st |= BROWSER_MOUSE_DRAG_ON;
        if (gw->mouse_pressed & BROWSER_MOUSE_PRESS_1) st |= BROWSER_MOUSE_HOLDING_1;
        if (gw->mouse_pressed & BROWSER_MOUSE_PRESS_2) st |= BROWSER_MOUSE_HOLDING_2;
}
```

The `HOLDING_*` bits are computed **inside** `if (gw->dragging)`. They are therefore
gated on `dragging`, not on `mouse_pressed`, even though they describe `mouse_pressed`.

`gw->dragging` only becomes true once motion exceeds `DRAG_SLOP`, which is **5 px**
(`gui.c:72`, promotion at `gui.c:736-745`). And `gucos_mouse_motion()` ends with an
**unconditional** track (`gui.c:748`):

```c
browser_window_mouse_track(gw->bw, gucos_mouse_state(gw), cx, cy);
```

⇒ **Press the button and move 1-5 px, and the core receives
`browser_window_mouse_track(bw, 0, …)` while the button is still physically down.**
A track carrying no `HOLDING` bits is exactly how a DOM `mouseup` is synthesised — the
project's own harness documents that equivalence at `vendor/netsurf/smoke-js.mjs:332`:

```js
this.mouse('TRACK', to.x, to.y);   // buttons released: the mouseup
```

On the paint pad this terminates the stroke, which is precisely *"I can't drag, it
takes many clicks"*. It is not demo-specific: it silently breaks every drag interaction
on every page.

**The fix is NOT to delete `DRAG_SLOP`.** The slop legitimately stops a jittery press
being read as a drag-select. The defect is that the *held-button* facts are dropped
during the pre-slop window. `DRAG_ON` is a statement about a drag; `HOLDING_*` is a
statement about a button. Only the first belongs behind `dragging`. Establish that
distinction properly — do not special-case the paint demo.

### 🔴 Why no test caught it, and why the obvious harness CANNOT catch it

`smoke-js.mjs`'s `drag()` helper goes `PRESS_1` → `DRAG_1` → `TRACK(DRAG_ON,
HOLDING_1)` → `TRACK()`. It jumps straight into the dragging state and **never
exercises the sub-slop window at all**. That is a real blind spot.

🔴 **But fixing that helper would still not cover this bug.** `smoke-js.mjs` builds and
drives `nsmonkey.wasm` — the **monkey** frontend (`smoke-js.mjs:4, 83`). The defect is
in `vendor/netsurf/gucos/gui.c`, the **gucOS SDL frontend**. Monkey never executes
`gui.c`, so **no smoke-js leg can reach this code path by construction.** A monkey-side
test here would be coverage theatre: green, and blind.

⇒ The regression test must be an **in-OS kernel e2e** driving real SDL mouse events
through the gucOS frontend — a sibling of `tests/kernel/test_netsurf_pointer_e2e.js`.

Same failure shape as the original green-pill problem: the harness asserted the easy
path and called it coverage.

### Does this explain jku's ORIGINAL paint report?

He reported a single dot from the start, and we concluded he had clicked without
dragging. He may instead have *tried* to drag, had the stroke killed by a spurious
mouseup inside 5 px, and got one dot. **If the fix confirms that, say so explicitly** —
it means the demo-visual work (`0425`) was a real improvement but never the whole
story, and this engine bug was present the entire time. Do not assert it without
evidence; refuting it is an equally good answer.

## Plan

1. Verify the diagnosis above against the real event path before changing anything.
2. Fix the held-button state so it survives the pre-slop window. Separate "a drag is in
   progress" (`DRAG_ON`) from "a button is down" (`HOLDING_*`).
3. Check the **same shape elsewhere**: any other site reporting mouse state from
   `dragging` where it should read `mouse_pressed`. Note `gucos_mouse_button()`'s
   release path also calls `mouse_track(bw, 0, …)` on drag-end (`gui.c:781-784`) —
   correct there, but confirm the fix does not make it **double-fire** an up.
4. Add the regression test described above, in `tests/kernel/`, **not** `smoke-js.mjs`.
   It must drive a genuine **press → sub-slop move (≤5 px) → supra-slop move →
   release** sequence and assert that no `mouseup` reaches the page while the button is
   down, and that the stroke survives the sub-slop window.
5. Confirm or refute the historical read above, and say which.

## Acceptance

- A new `tests/kernel/` e2e **fails on the current `gui.c` and passes after the fix**,
  driving a real press → sub-slop move → supra-slop move → release through the gucOS
  frontend.
- No `mouseup` reaches the page while a button is held, at any motion distance.
- Drag-end still fires exactly **one** up, proven against the `gui.c:781` path.
- `DRAG_SLOP` is unchanged in value and still suppresses drag-*start* on a jittery
  press.
- Full kernel suite and browser sweep green, with `results[].status` tallied.

## Coordination notes

- `vendor/netsurf/` change ⇒ owes an image bump. 🔴 **Do NOT bump `os/image.json`.**
  193 is built and UNDEPLOYED (prod 192); the coordinator is holding the deploy to
  bundle it.
- Disjoint from both live lanes, measured 2026-07-29 against `main` `a865e5a1`:
  `0412` owns `netsurf/content/handlers/html/*` + `gucos/options.h`; `0425` owns
  `vendor/netsurf/demos/*` and the `smoke-js.mjs` header/`COVERED`/leg3 assertions.
  **Neither touches `gucos/gui.c`.** The only shared file at merge is
  `todos/queue.json`, which is unavoidable.
