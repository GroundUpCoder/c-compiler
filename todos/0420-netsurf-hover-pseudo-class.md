# 0420 — netsurf: the :hover pseudo-class never matches

- **Status**: open
- **Design**: —

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
