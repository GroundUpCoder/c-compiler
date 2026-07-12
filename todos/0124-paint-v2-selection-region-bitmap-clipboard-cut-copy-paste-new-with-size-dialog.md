# 0124 — Paint v2: selection region + bitmap clipboard (Cut/Copy/Paste), New-with-size dialog

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WIN32.md` (the veneer as an app platform). Owns the
  residue 0107 deferred: `/bin/paint` ships Edit → Cut/Copy/Paste as
  visible-but-GRAYED stubs and File → New at a FIXED size. Filed by the 0107
  close-out audit.

## Goal

Turn the grayed Paint menu items live and let the user size a new canvas.
0107 landed the drawing engine, tools, palette, and 24-bit BMP round-trip but
recorded selection/clipboard and New-with-size as v1 non-goals; 0090 (the
system clipboard) has since landed, so the clipboard half is now buildable.

## Plan

- **Selection tool** — a marquee (rubber-band rectangle over the canvas, the
  0107 shape-preview mechanism) that marks a sub-rect; Delete clears it to BG,
  drag moves the floated region (paste-on-drop).
- **Cut/Copy/Paste** — ungrey the Edit items over the selection: Copy/Cut push
  the selection's pixels to the clipboard, Paste drops them at the origin as a
  floating selection. **Blocker to resolve first**: the 0090 kernel clipboard
  slot carries only fmt-1 UTF-8 text + fmt-2 file lists — it does NOT yet carry
  a bitmap (CF_BITMAP). Either (a) add a bitmap format to the kernel slot +
  the SDL3 clipboard veneer, or (b) serialize the selection as a BMP blob under
  an app-private clipboard convention. Pick + record in the item body before
  building.
- **New-with-size dialog** — File → New pops a small width/height dialog
  (DialogBoxParamW over a template, the ctldemo Options pattern) instead of
  clearing at the fixed size; resize the canvas + window (the 0107 bmp_load
  MoveWindow → SURFACE_RESIZE path already exists).

## Non-goals (record, don't build)

- Zoom, text tool, brush shapes, free-rotate — 0107's standing non-goals.
- Cross-host-browser bitmap clipboard (SDL3.md: host clipboard integration is
  deliberately not wired).

## Acceptance

- Headless (`test_paint_e2e.js`-style): agent-drive a marquee selection over a
  drawn region, Copy, move the caret, Paste elsewhere, read pixels back via a
  SHOT (the region reappears at the new origin); Cut clears the source to BG;
  New → size dialog → the canvas + surface resize to the entered dimensions.
- Cut/Copy/Paste are no longer grayed in the menu tree when a selection exists.
