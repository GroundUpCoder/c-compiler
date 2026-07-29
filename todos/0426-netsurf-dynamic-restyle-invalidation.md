# 0426 — netsurf: two shapes the dynamic-restyle chain walk does not cover

- **Status**: open
- **Design**: —

## Goal

`todos/0420` gave netsurf real `:hover` and `:active`. The restyle is bounded
to the entry and exit chains: it re-selects the box subtree of the topmost
element whose state changed. Two shapes fall outside that bound. Close them,
or record why the cost is not worth it.

## The two shapes

1. **A sibling combinator.** `a:hover ~ span { ... }` puts the restyled
   element outside both subtrees, so it keeps its old style. A descendant
   combinator (`li:hover a`) IS covered, because the subject is inside the
   subtree.
2. **A rule that displays a hidden element.** `#x:hover #y { display: block }`
   cannot work when `#y` is `display: none`. box_construct drops the box of a
   `display: none` element, so there is no box to re-select from.

Both need a real style-invalidation engine: libcss must report which
selectors an element takes part in, and the engine must keep an invalidation
set per element. That is the shape a modern browser uses.

## Anchor

`content/handlers/html/interaction.c`, the comment block above
`#define HTML_CHAIN_MAX`.

## Evidence

`tests/kernel/test_netsurf_pointer_e2e.js` covers the shapes that DO work:
entry, exit, an ancestor styled from a span inside it, and `:active`. Nothing
covers the two above, by design — they do not work.

## Cost note

The bounded walk keeps a steady-state hover transition at ~300x112 px of
invalidation (measured through the monkey frontend, 2026-07-29, on a 3000 px
page). A whole-document restyle per transition was the alternative and is
what the bound exists to avoid, so any fix here must keep that property.

The REPAINT is tight. The RE-SELECTION is not, and it cannot be without the
same missing capability. A descendant combinator lets `#pad:hover .x` match
anything inside `#pad`, so entering `#pad` obliges the engine to re-select
the whole of `#pad`. Pruning that needs libcss to report which selectors an
element takes part in — the same report the two shapes above need. Fix them
together.
