# 0316 — a class restyle on an existing element: two bugs, neither where the ticket pointed

`todos/0316` came in with a measurement and a diagnosis.  The measurement
held; the diagnosis did not.  Worth writing down because the wrong turn was
a *reasonable* reading of a real probe table, and because the shape of the
mistake ("three rows, therefore one bug with three severities") is easy to
repeat.

## The handed-down table

One page, one click handler, three probes:

| probe | selector | result |
|---|---|---|
| `<canvas>` + `putImageData` | — | repainted immediately (control) |
| `<div id="idsel">` | `#idsel.on` | repainted, but only in a LATER frame |
| `<div id="a" class="slab">` | `.slab.on` | never repainted |

and the reading: the mutation reaches the box tree, the paint is requested,
so suspect the CSS re-selection — libcss bucketing, or the cached
`libcss_node_data` that Lane B's `nscss_node_data_clear` exists to drop.

That is exactly the wrong place.  libcss is not involved in either bug.

## Reduction

Static first: a page whose markup ALREADY carries `class="slab on"` styles
correctly under `.slab.on` (24000/24000 px).  So compound selectors work;
the failure is dynamic.

The truth table that settled it — one page, one click, no canvas, dominant-
colour histogram over the window, each probe a 400×60 = 24000 px box with a
distinct unlit grey so a dark probe names itself:

| probe | pre-fix |
|---|---|
| created div, `.plain` (Lane B insertion control) | 24000 lit |
| created div, `className='fresh on'`, `.fresh.on` | 24000 lit |
| `#idsel` (no class attribute) → `className='on'`, `#idsel.on` | 24000 lit |
| `#a` (`class="slab"`) → `className='slab on'`, `.slab.on` | **0 lit, 24000 still unstyled** |

A freshly created element matching the SAME compound selector shape lights.
So it is not the selector, not the stylesheet, not the bridge, and not the
re-selection.  The only thing left that `#idsel` and `#a` do not share is
that `#a` already had a class attribute.

`libdom/src/core/element.c` says why in the plainest possible way:
`_dom_element_create_classes` is called from
`_dom_element_attr_list_node_create` (attribute ADDED) and
`_dom_element_destroy_classes` from `..._node_destroy` (attribute REMOVED).
`_dom_element_set_attr`'s *existing*-attribute branch just calls
`dom_attr_set_value` — the parsed class array is never rebuilt.  Every
class selector, and every `dom_element_has_class` caller, reads that array.

Fixed at `_dom_attr_set_value`, which is the one choke `setAttribute`,
`className`, `classList` and `attr.value` (via `dom_node_set_node_value`)
all pass through.  `_dom_element_set_attr_node` was already correct — it
destroys and recreates the list node — so the value-rewrite branch was
genuinely the only hole.  Post-fix the last row reads 24000 lit.

## The second bug, which the ticket's control was hiding

The first probe page I wrote had the ticket's canvas control in it, and
under that page *nothing* re-boxed — not the restyles, not even the
plain element insertion that `test_netsurf_mutation_e2e.js` proves works.
Same page minus the canvas fill: everything worked.  The monkey frontend
never reproduced it.  That narrows it to the gucOS frontend, and
`gucos/main.c` had it in the open:

```c
while (!gucos_done) {
        schedtm = gucos_schedule_run();   /* deadline sampled HERE */
        gucos_process_events();           /* ...JS runs HERE, and schedules */
        gucos_redraw_all();
        if (SDL_PollEvent(NULL)) continue;
        SDL_WaitEventTimeout(NULL, schedtm);
}
```

`html_schedule_reconvert` posts the live re-conversion with
`guit->misc->schedule(0, ...)`, from a JS listener, i.e. from inside
`gucos_process_events()`.  With nothing else pending, `schedtm` is `-1` —
"sleep until input" — and the loop parks on it.  The re-box then waits for
an unrelated later event.

The `SDL_PollEvent(NULL) → continue` line is what made it look intermittent
rather than fatal: if the press and the release are drained in separate
passes, the second pass re-enters the loop, re-samples the deadline as 0
and runs the re-conversion.  If they are drained in ONE pass, the queue is
empty and the loop wedges.  Filling a canvas is ~96 000 iterations of
duktape, which is plenty of time for the release to arrive — so the canvas
did not merely fail to help, it is the thing that made the failure
deterministic.  That is the ticket's "repainted, but only in a LATER
frame", and it is also why `test_netsurf_events_e2e.js` believed canvases
were the *safe* probe channel.

The deadline is read after events and after redraw now, from a new pure
`gucos_schedule_next()`.  It also clamps: an already-due callback reports
0, never a negative, because `SDL_WaitEventTimeout` reads a negative
timeout as "forever" — the same wedge by another route.  Being already due
parks for 1 ms rather than spinning, since `gucos_schedule_run`'s
comparison is strictly greater and needs the clock to move on.

## Why Lane B's gate could not have caught either

`test_netsurf_mutation_e2e.js` only inserts elements and writes
`textContent` — the class-rewrite class of mutation had no probe at all.
And its driver polls with `pollChange`, repeated screenshots either side of
the click, which incidentally keeps the loop turning across passes.  A
mutation class nobody probed, sampled by a driver that accidentally papers
over a park bug: two silent symptoms stacked, which is the anti-pattern
`CLAUDE.md`'s test-sync section is about.

`tests/kernel/test_netsurf_restyle_e2e.js` is the guard.  Five probes, one
click, and every one of them must light in the SAME frame as the canvas
control — so defect 2 cannot come back as "eventually", and the two created-
element probes mean a `.slab.on` failure can only be a statement about the
existing element.  It fails 6 of 11 checks on the unfixed tree.

## Falsified along the way

- "the class+class case failing while the id+class case eventually succeeds
  points at the selection side" — no.  Both cases are correct in libcss;
  one of them was fed a stale class list and the other was fed a stale
  wakeup deadline.
- My own first probe page put the canvas control FIRST and read a flat
  "nothing works", which I briefly mistook for the reduction failing to
  reproduce.  It was reproducing two bugs at once.  The canvas-free page is
  what separated them.
