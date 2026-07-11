# 0107 — Paint accessory (gdi32 mspaint-class app)

- **Status**: DONE (2026-07-11). `/bin/paint` seeded (Accessories menu + `.bmp`
  openwith); one owner-drawn window over gdi32/user32/comdlg32 — memory-DC
  canvas, 8 tools (pencil/eraser/fill/line/rect/filled-rect/ellipse/
  filled-ellipse), 16-colour palette (FG/BG left/right), Tools+Width menu,
  single-level Undo, Ctrl+N/O/S/Z accelerators, 24-bit BMP save/open
  (byte-identical round-trip). Cut/Copy/Paste GRAYED (selection region = the
  recorded v2 non-goal, wants a bitmap clipboard). Headless acceptance
  `tests/kernel/test_paint_e2e.js` (35 checks) PASSES; `win32ports --check` +
  `os_boot` green; image `version` → 67. Browser leg `tests/browser/
  os-paint.mjs` written but UNRUN (no Playwright) — folded into the 0064
  browser-sweep debt. Dev log `logs/2026-07-11/0107-paint-accessory.md`.
- **Design**: `todos/WIN32.md` (the veneer as an app platform — gdi32
  0057, user32 0058/0068, comdlg32 exist; this is the first *creative*
  app on them). Filed by the 0076 parity sweep.

## Goal

Accessories has term/calc/notepad/fileman — but no Paint, the most
iconic Win95 accessory after Minesweeper (which shipped in 0068). A
paint program is also the best all-in-one exercise of the veneer we
have: memory DCs as the canvas, the full shape/ROP set, mouse capture,
menus + accelerators, comdlg32 open/save, and the 0090 clipboard once
it lands. ReactOS mspaint is C++ (excluded, the Solitaire rule), so
this is a small native app: `os/win32/paint.c` → `/bin/paint`, seeded
in the Accessories menu.

## Plan

- **Canvas** — a memory-DC bitmap (default ~400×300; File → New asks
  size later, fixed first); the window blits it 1:1, scrollbars only if
  cheap (SCROLLBAR control exists). Draw = mouse capture on the canvas
  child, tool renders into the memory DC, InvalidateRect.
- **Tools (v1)** — pencil, line, rectangle, ellipse, filled variants,
  eraser, flood fill (own scanline fill over GetPixel/SetPixel or the
  DIB bits), color palette strip (the 16 VGA colors + current FG/BG on
  left/right button — the mspaint convention), 1/3/5px width picker.
  Toolbox = a column of owner-drawn BUTTONs; no free-rotate/text/spray
  in v1.
- **File I/O** — BMP only (24-bit, the gdi32 DIB path already swizzles
  B<->R): Open/Save/Save As via comdlg32; `.bmp` gets an openwith
  association → `/bin/paint` (0072 store, image seed).
- **Menus/keys** — File/Edit/Image/Help via the 0068 menu + accelerator
  machinery; Edit Undo = one stashed canvas copy (single-level);
  Edit Cut/Copy/Paste arrive with 0090 (leave grayed rows until then —
  visible-but-disabled beats absent here since the menu ships anyway).
- **Seeding** — image.json: `/usr/bin/paint` + Accessories menu link +
  the `.bmp` association line; bump the image version.

## Non-goals (record, don't build)

- PNG/GIF (BMP round-trips losslessly and needs no new deps here;
  wallpaper's PNG stack is 0049's).
- Selection rectangle / move-paste of regions (wants 0090; a natural
  v2 with clipboard).
- Zoom, text tool, brush shapes, dithered palettes.

## Acceptance

- Headless (`test_user32_e2e.js`-style e2e): agent-drive a line + filled
  rect + flood fill, read pixels back via a SHOT (deterministic colors);
  Save then Open round-trips the BMP byte-identically; the menu tree
  lists the tools; winmine-style registry not needed.
- Browser (`os-shell.mjs` or own leg): launch from Start → Accessories,
  draw with the mouse, pixels appear; openwith on a .bmp opens paint.
