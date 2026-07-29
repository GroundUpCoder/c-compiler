# 0420 — netsurf: the :hover pseudo-class never matches

- **Status**: done (2026-07-29)
- **Design**: —

## Outcome

`:hover` and `:active` both work. Four parts:

1. `html_content` carries `hover_node` and `active_node` — the DEEPEST
   ELEMENT of each chain, as a referenced DOM node. A node, not a box, so the
   state survives a live re-conversion.
2. `nscss_select_ctx` carries both nodes, and `node_is_hover` /
   `node_is_active` answer by walking up from the subject. A pseudo-class
   matches a CHAIN, which is what makes `li:hover a` work.
3. `box_restyle_element` (box_construct.c) re-selects a box subtree. It drops
   the libcss per-node cache first, because that cache holds the pseudo-class
   flags themselves. Computed styles are interned by libcss, so an unchanged
   selection hands back the SAME pointer — that is the exact test for "did
   anything change", and it is why a pointer crossing a page with no dynamic
   rule costs no reflow and no repaint.
4. `html_mouse_action` updates both chains before its box walk, re-selects
   the subtree of the topmost changed element of each chain, reflows with
   `background: true` (so the reflow drags no full-window repaint behind it)
   and requests a redraw bounded to the boxes that really changed.

Measured through the monkey frontend on a 3000 px page (2026-07-29): a
steady-state transition between two adjacent links invalidates 300x212 px,
one link entering or leaving invalidates 300x112 px. The first pointer entry
invalidates more, because an empty old chain really does change the whole
chain — and on that pass both links also flip `:link` to `:visited`, which
upstream never repainted at all.

Not covered, and now funded by `todos/0426` + register entry L64: a sibling
combinator (`a:hover ~ span`), whose subject sits outside both subtrees, and
a rule that takes an element from `display: none` to displayed, which has no
box to re-select from.

Coverage: `tests/kernel/test_netsurf_pointer_e2e.js` — hover entry, hover
EXIT, an ancestor styled from a span inside it, and `:active` between a
button-down and its release. The `hover` probe in
`tests/kernel/nsprobe-subset.js` is green.

## Goal

A `:hover` rule never applies. The pointer can rest on the element and the
element keeps its base style.

Found by the `netsurf-bughunt` lane (2026-07-29) with an in-OS probe page
(`tests/kernel/nsprobe-subset.js`, probe name `hover`): an
`a#h:hover{background:...}` rule, a `wmctl hover` on the link, zero pixels of
the hover colour in the shot. The pointer WAS on the link — the status bar
showed the link target, so the motion tracking works.

## Mechanism

This is an UPSTREAM gap, not a port defect. `node_is_hover` in
`content/handlers/css/select.c` (line ~1540) carries
`/** \todo Support hovering */` and always reports no match. libcss asks;
NetSurf answers "never".

## Plan

1. Track the hovered node chain in `html_content` from the mouse-track path
   (the browser window already computes the node under the pointer).
2. Answer `node_is_hover` (and `node_is_active`?) from that chain.
3. Re-select and repaint the boxes whose hover state changed — bound the work
   to the entry/exit chains, not the whole document.
4. A conformance leg: the `hover` probe from `nsprobe-subset.js` flips from
   FAIL to green.

The fix touches `vendor/netsurf/`, so it owes an image bump.

## Evidence

`~/git/meta/meta/media/netsurf-bughunt/probe-hover.png` — the pointer is on
the link (status bar names the target), the block keeps its gray base style.
