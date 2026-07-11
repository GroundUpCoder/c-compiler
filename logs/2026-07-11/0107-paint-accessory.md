# 0107 — Paint accessory (gdi32 mspaint-class app)

**Status**: landed. `/bin/paint` is seeded in Accessories; `.bmp` opens with
it. Headless acceptance (`tests/kernel/test_paint_e2e.js`, 35 checks) PASSES.

## What shipped

`os/win32/paint.c` → `/bin/paint`: the first *creative* app on the Win32
veneer (not a port — ReactOS mspaint is C++, the Solitaire rule). It is one
owner-drawn window (no child controls) over the gdi32/user32/comdlg32 stack:

- **Canvas** — a memory-DC bitmap (default 400×300, white). `CreateCompatible
  Bitmap` + `CreateCompatibleDC`; every op draws into the memory DC, `WM_PAINT`
  `BitBlt`s it 1:1 into the client at (56,6) under a sunken frame. A second
  memory DC (`g_undo`) holds the single-level Undo copy.
- **Tools** — pencil, eraser, fill, line, rectangle, filled rectangle,
  ellipse, filled ellipse. Shape tools rubber-band by `BitBlt`ing the undo
  copy back and re-drawing to the live point each `WM_MOUSEMOVE` (SetCapture
  during the drag); pencil/eraser are freehand `draw_seg`; Fill is an own
  scanline flood fill over `GetPixel`/`SetPixel`. FG = left button, BG = right
  (the mspaint convention); filled shapes fill with FG, outline shapes use a
  hollow brush. Pen width 1/3/5 via Tools→Width.
- **Palette** — the 16 VGA-ish colours as owner-drawn swatches; left-click sets
  FG, right sets BG, with an FG/BG indicator. Colours are agent-driven by pixel
  injection (`wmctl click SID X Y`), tools by menu label (`wmctl click Line`).
- **Menus/keys** — File/Edit/Image/Tools/Help built with `CreateMenu`/
  `AppendMenuA` (passed as the top-level `hMenu`), accelerators Ctrl+N/O/S/Z via
  `CreateAcceleratorTableA` + `TranslateAcceleratorW`. Cut/Copy/Paste stay
  GRAYED (a selection region is the recorded 0107 non-goal — a v2 with the
  0090 bitmap clipboard, which the kernel slot doesn't carry yet). Undo starts
  grayed, enables after the first mutating op.
- **BMP I/O** — 24-bit BMP only, via comdlg32 `GetOpenFileNameW`/
  `GetSaveFileNameW`. Save extracts 32bpp `GetDIBits` (bottom-up BGRX) and
  repacks to padded 24-bit BGR; Open parses 24/32-bit BI_RGB (top-down and
  bottom-up), rebuilds a bottom-up 32bpp buffer and `SetDIBits`. Round-trip is
  byte-identical (test-proven). A different-size open resizes the canvas +
  window (`MoveWindow` → `SURFACE_RESIZE`); an argv path opens at startup (the
  openwith launch path).

## Seeding + regression guards

- `os/image.json`: `/usr/bin/paint` (project), `/usr/share/menu/Accessories/
  paint` link, a `bmp\t/bin/paint` openwith line; `version` 66 → **67** (paint
  sources are bake inputs).
- `os/win32/ports.json` + `PORTS.md`: paint added as a control target
  (`expect: links`) alongside gdidemo/ctldemo/k32demo — `win32ports --check`
  keeps it compiling.
- `tests/kernel/run.js`: registered `test_paint_e2e.js` (IMG).

## Design calls (don't re-litigate)

- **One owner-drawn client, no child controls.** Tools live in a real menu
  (agent-clickable by label) AND an owner-drawn toolbox (pixel-clickable);
  the whole client hit-tests in `WndProc`. Simpler than a control forest and
  fully agent-drivable. The menu bar shifts client origin down 20px (user32
  draws it over the top of the surface); injected pointer coords are surface
  coords, so the test adds `BAR` to client Y — same convention as winmine.
- **Undo is single-level, no redo** (per the item): `undo_push` stashes before
  each op, `undo_apply` restores. Cut/Copy/Paste grayed until a real selection
  region + bitmap clipboard exist (v2).
- **24-bit BMP, not 32.** More interoperable and matches the plan; `GetDIBits`/
  `SetDIBits` are 32bpp-only so save/load repack the rows. The colour compare
  in the test samples the palette swatch pixel from the same shot, so it never
  assumes a surface byte order.

## Testing

- `tests/kernel/test_paint_e2e.js` — 35 checks, PASS: lifecycle, the menu tree
  (tool/width items, grayed Cut/Copy/Paste + Undo), select-tool + palette-pick
  + `wmctl drag` a filled rect (red pixels via SHOT), flood fill (green bg),
  single-level Undo (bg back to white), New clear, and the comdlg32 Save→New→
  Open round-trip with a **byte-identical** re-save.
- `node tools/win32ports.js --check` — paint links; report fresh.
- `node tests/kernel/run.js --filter=os_boot` — the full image bakes + boots
  with paint seeded (194s, PASS).

## Owed to the operator (browser sweep, 0064)

`tests/browser/os-paint.mjs` is written (launch from the shell, real-mouse pick
Filled Rectangle + red swatch, drag a rect, assert red composites through the
WebGPU compositor, close-box exit) but UNRUN here — Playwright isn't installed
in-repo. Runs in `node tests/browser/os-sweep.mjs --filter=paint`. Joins the
standing 0064 browser-leg debt.
