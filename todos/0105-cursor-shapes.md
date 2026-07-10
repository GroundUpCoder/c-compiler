# 0105 — pointer cursor shapes (per-surface cursor + chrome resize cursors)

- **Status**: open
- **Design**: `todos/SDL3.md` "Mouse" (cursor create/set listed missing,
  "Web: CSS cursors"); `todos/WM.md` deviations ("Cursor is the native
  browser cursor — no kernel sprite"). Filed by the 0076 parity sweep.

## Goal

The pointer is the browser's default arrow everywhere: no I-beam over
text, no resize arrows over a window frame, no wait cursor — one of the
loudest "web page, not a desktop" tells. The deviation decision (native
browser cursor, no kernel sprite) stands; this item is about *which*
native cursor shows, which CSS handles for free.

## Plan

- **Chrome cursors (kernel-side, zero app change)** — the kernel already
  hit-tests frames per pointer move; derive a wanted-cursor from the hit
  (resize edges/corners → the 8 directional cursors, title bar → arrow)
  and post it to os.html (the pointer-lock wanted-state pattern, 0018),
  which sets `canvas.style.cursor`. Debounce by change, not per-move.
- **App cursors (SDL path)** — implement `SDL_CreateSystemCursor` /
  `SDL_SetCursor` / `SDL_ShowCursor`-family in host.js's SDL veneer as a
  per-surface cursor id (a small enum of CSS cursor names: default,
  text, wait, crosshair, pointer, move, the resize set) riding a
  SURFACE_SET_FLAGS-style RPC → kernel per-surface state; the composite
  hit test picks focused-surface cursor when the pointer is over the
  client area, chrome cursor over frames. Custom pixel cursors
  (`SDL_CreateCursor`) stay out — system shapes only.
- **user32/EDIT** — `SetCursor`/`LoadCursorW(IDC_*)` map onto the same
  per-surface state (today they're recorded stubs); the EDIT control
  sets IDC_IBEAM on WM_SETCURSOR-equivalent hover, giving notepad/edit
  fields the I-beam for free. Keep the 0068 stance: no .cur assets.
- **Headless** — cursor is browser-only rendering (the 0063 glass rule):
  the kernel state exists and is assertable (`wmctl` read), but the
  headless composite never draws it.

## Acceptance

- Headless: an app sets the text cursor → kernel per-surface state
  reads back; chrome hit over a resizable frame edge reports the
  matching directional cursor; fixed-size frames report arrow.
- Browser (`os-wm.mjs` leg): `canvas.style.cursor` flips to `ew-resize`
  over a winbox side frame, `text` over a notepad/EDIT client, back to
  `default` on the desktop.
