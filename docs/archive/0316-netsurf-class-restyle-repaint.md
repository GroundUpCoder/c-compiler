# 0316 — NetSurf: a class-selector restyle on an existing element does not repaint promptly (Lane B residual)

- **Status**: done (2026-07-27)
- **Design**: `todos/NETSURF-JS.md` §9 (Lane B's residuals), §10 (Lane C) and
  §11 (what this item found).

## Goal

Found while building the Lane C in-OS gate (`todos/0289`), measured, not
inferred. Writing `el.className = 'slab on'` on an ELEMENT THAT ALREADY
EXISTS re-boxes the document — the Lane B bridge fires, `INVALIDATE_AREA
ALL` goes out, and reading `el.className` back returns the new value — but
the element is still painted with its OLD style.

Measured in the OS (`node os/boot.js` + `wmctl shot`, colour histogram over
the window), one page, three probes changed by one click handler:

| probe | selector | result |
|---|---|---|
| a `<canvas>` filled by `putImageData` | — | repainted IMMEDIATELY (control) |
| `<div id="idsel">` restyled by `#idsel.on` | id + class | repainted, but only in a LATER frame |
| `<div id="a" class="slab">` restyled by `.slab.on` | class + class | never repainted at all |

So the mutation reaches the box tree (Lane B) and the paint is requested,
but the CSS re-selection either does not happen or does not happen against
the new class list.  The class+class case failing while the id+class case
eventually succeeds points at the selection side (libcss bucketing / the
cached `libcss_node_data`), not at the bridge.

This is P0 by the repo's rule: `className` is a shipped, documented binding
(the demos' load-check pill uses it, and `todo/`'s counter is written
against exactly this) and it is wrong.

## Outcome — TWO independent defects, both fixed

The probe table above is one bug per row, not one bug seen three ways.  The
guess it ends on (libcss bucketing / the cached `libcss_node_data`) was
**wrong**: the re-selection does run, `nscss_node_data_clear` does its job,
and libcss is not involved at all.  Both real causes are one level out from
where the ticket pointed.

**1. libdom never refreshed an element's parsed class list when an existing
`class` attribute's VALUE changed** (`libdom/src/core/{attr.c,element.c,
element.h}`).  `dom_element.classes` — the array `dom_element_has_class`,
and so every class selector, reads — is built by
`_dom_element_attr_list_node_create` when a `class` attribute is ADDED and
destroyed by `_dom_element_attr_list_node_destroy` when one is REMOVED.
`_dom_element_set_attr`'s existing-attribute branch only calls
`dom_attr_set_value`, so an element that already had a class kept its
original list for the rest of the document's life.  That is exactly the
`.slab` vs `#idsel` asymmetry, and it is not about the selector: `#idsel`
had no class attribute until the click created one (cache built correctly),
`.slab` already had one.  The fix sits at the one choke every value rewrite
passes through — `setAttribute`, `className`, `classList` and `attr.value`
all reach `dom_attr_set_value` — which now calls a new
`_dom_element_classes_changed` when the attribute it just rewrote is the
class attribute.  Upstreamable.

Measured on a canvas-free probe page, one click, colour histogram
(box = 24000 px):

| probe | before | after |
|---|---|---|
| created element, `.plain` (the Lane B insertion control) | 24000 lit | 24000 lit |
| created element, `.fresh.on` (same compound shape) | 24000 lit | 24000 lit |
| `#idsel.on`, element had no class attribute | 24000 lit | 24000 lit |
| **`.slab.on`, existing class attribute rewritten** | **0 lit / 24000 still unstyled** | **24000 lit** |

**2. the gucOS frontend parked on a stale deadline** (`gucos/main.c`,
`gucos/schedule.{c,h}`).  `gucos_run` read `schedtm = gucos_schedule_run()`
at the TOP of the loop and only then called `gucos_process_events()`, so a
callback scheduled by an input event's own handler was not in that number.
The live re-conversion is scheduled at delay 0 from a JS DOM mutation, i.e.
from inside `gucos_process_events()` — so the loop parked on `-1`
("nothing scheduled, sleep until input") and nothing re-boxed until some
later unrelated event woke it.  Whether that ever happened depended on
whether the press and the release were drained in one pass, which is why
the ticket's own table recorded a repaint "in a LATER frame": the same page
repainted late, or never.  A `<canvas>` fill in the handler makes it
deterministic (that much JS lets both events arrive before the handler
returns), which is why the ticket's canvas control and its restyle probes
disagreed.  The park deadline is now read AFTER events and redraw, from a
new pure `gucos_schedule_next()` that also reports an already-due callback
as 0 rather than as a negative (SDL's "wait forever").

Measured on the committed test's page (which carries the canvas), one
click:

| frame | before | after |
|---|---|---|
| p1, the click's own frame | `{ctl:24000, plain:0, fresh:0, idc:0, cls:0}` | `{ctl:24000, plain:24000, fresh:24000, idc:24000, cls:24000}` |
| p2, settled | same as p1 — nothing ever re-boxed | all five lit |

## Acceptance

- A class change on an existing element repaints with its new style, for
  both `#id.cls` and `.cls.cls` selectors, in the OS. ✅
- A kernel-e2e leg that fails without the fix. ✅
  `tests/kernel/test_netsurf_restyle_e2e.js` — 6 of its 11 checks fail on
  the unfixed tree, and it asserts the restyles land in the SAME frame as
  the canvas control, so defect 2 cannot come back as "eventually".
