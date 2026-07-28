# 0386 + 0402: focus survives NetSurf's live re-conversion window

The `285 vs 234` intermittent in `test_netsurf_mutation_e2e.js` is closed as a
**product defect** (M1 in the design pass's terms), and `0402`'s click-mid-window
use-after-free is closed by the same change. This log records the why and the numbers.

## The discriminators did exactly what the design pass said they would

The load-hammering plan was superseded (sighting 4 showed a quiet box repeats green),
so the lane went straight to the controlled trigger, all on a quiet box:

| probe | result | reading |
|---|---|---|
| D2-T (3000 el, 300 ms tick, type during) | **52 / 52** (immediate/settled) | every key lost, and NOT paint lag — the settled shot is identical |
| D2-T2 (click mid-ticking, then type) | **52 / 52** | the 0402 shape, reached observably |
| D2-C1 (3000 el, no timer) | 285 / 285 | size alone innocent |
| D2-C2 (3000 el, 5 s timer) | 285 / 285 | period alone innocent |
| D3 per-glyph table | `a=39 b=51 c=23 d=51 e=36 f=33` | the historical 51-px loss is `b` or `d` — an ascender. M2 (late sample) can only lose the trailing `f` (33 px → 252, never 234). **M2 dead twice over.** |
| D4 (20 ms cadence, small page) | 285 / 285 | no paint-lag component at any cadence |

The per-glyph table also retro-explains the wild sightings: exactly one of `b`/`d` sat
in the key↔tick resonance window on the loaded gates.

## The fix is the general rule, and it needed two things the design pass flagged

> Interaction state that routes input must stay valid for the whole build-then-swap
> interval and be re-bound at the swap — not surrendered at teardown-start.

1. **The §4.2 safety question had a real answer.** `box_textarea_keypress` on an
   old-tree box is safe (`ta` is read fresh from the gadget each call, `TEXT_MODIFIED`
   → `form_gadget_update_value` writes through to the DOM, `textarea_destroy` fires no
   callbacks) — BUT `textarea_get_caret` silently defaults an unset caret to **0**, so
   keys landing in the freshly recreated widget would insert at position 0. The caret
   therefore has to be **carried across the widget recreation**, not just re-applied at
   the swap. That carry is focus-gated (or claim-gated) so a lingering caret on an
   unfocused gadget cannot steal focus.
2. **The mid-window click needs a claim.** A click before construction re-binds the
   gadget arrives in `box_textarea_callback` with `gadget->box == NULL`. Skipping it
   silently would fix 0402's UAF but keep "click is swallowed". Recording the claimant
   (`reconvert_focus_claim`, consumed at recreation) keeps the click.

`html_reconvert_box_done` now snapshots the focused gadget's node AT the swap (local
variable — the `reconvert_focus_node`/`_caret` content fields are gone), scrubs the
owner while reformat runs, then re-binds DIRECTLY (no `html_set_focus` blur/focus
bookkeeping: the gadget never conceptually lost focus) and re-fires the live caret for
post-layout coordinates.

## Two things the probes found that are NOT this ticket (filed, not folded)

- **The deterministic 204.** Post-fix, un-settled shots of the forced arms read
  `204 = 52 + 152`: the FULL six-glyph value drawn at the recreated widget's default
  10pt fstyle (152 ≈ 233 × 13/20) while the old tree is on screen. Pre-existing render
  artefact, invisible on normal pages (window ≈ 1–2 ms), persistent on a page that
  re-boxes continuously → `todos/0407`. This is also the reason un-settled shots must
  never gate: they can legitimately catch that state.
- **`el.style.width = …` does nothing.** The first probe generation used style writes
  and read zero everywhere — instrument error by way of product gap:
  `HTMLElement::style` returns a disconnected stub object → `todos/0408`. The probes
  were rebuilt on `textContent` mirrors (the bridge the test itself proves).

Plus `todos/0406` for the §4.3 `wmctl shot` crop / `pollStableRegion` seam (§4.4: the
other fix is owed regardless of the verdict — filed, its workaround here is finite page
timers + derived sleeps).

## Test discipline notes

- The tolerance moved NARROWER: `>= staticInk * 0.9` (which silently accepted a dropped
  x-height glyph) is deleted; all gating shots are settled and assert `===`.
- The pages' tickers are now FINITE so a settled state exists at all; every derived
  sleep is annotated with the timeline it must land in.
- Value-level closure rides two `textContent` mirrors (event-driven + guarded poller),
  compared by colour count across arms against the never-windowed control.
