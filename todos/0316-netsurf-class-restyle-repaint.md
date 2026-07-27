# 0316 — NetSurf: a class-selector restyle on an existing element does not repaint promptly (Lane B residual)

- **Status**: open
- **Design**: `todos/NETSURF-JS.md` §9 (Lane B's residuals) and §10 (Lane C).

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

## Plan

1. Reduce further: is it the FIRST class in the list, the selector's
   specificity, or the cached node data?  `nscss_node_data_clear`
   (`content/handlers/css/select.c`, added by Lane B) is the obvious
   suspect — it is what lets a re-conversion re-style at all.
2. Check whether the id+class case's LATENESS is a second bug or just the
   frame the probe sampled.
3. Fix, and add the case to `tests/kernel/test_netsurf_mutation_e2e.js`
   (the Lane B gate) — nothing in-OS asserts a class restyle on an
   EXISTING element today, which is exactly why this survived Lane B.
   `tests/kernel/test_netsurf_events_e2e.js` documents at its probe-page
   comment why it deliberately uses canvases instead.

## Acceptance

- A class change on an existing element repaints with its new style, for
  both `#id.cls` and `.cls.cls` selectors, in the OS.
- A kernel-e2e leg that fails without the fix.
