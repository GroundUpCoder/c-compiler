# 0105 — pointer cursor shapes (per-surface + chrome resize cursors)

**What:** the desktop pointer is no longer the browser's default arrow
everywhere. Three things now drive which native cursor shows:

1. **Chrome resize cursors** — the kernel already frame-hit-tests every
   pointer move; `_wmCursorAt(x,y)` (a side-effect-free mirror of
   `wmPointer`'s hit test) now derives a cursor from the hit: a **resizable**
   frame's E/S edges → `ew-`/`ns-resize`, the SE corner → `nwse-resize`;
   fixed-size frames, the title bar and the desktop → the arrow.
2. **App cursors** — real SDL3 `SDL_CreateSystemCursor` / `SDL_SetCursor` /
   show/hide land in the compiler's SDL veneer; the shape rides
   `SURFACE_SET_CURSOR` (0x1008) to per-surface kernel state, which
   `_wmCursorAt` returns over that surface's client (chrome overlays it on the
   frame).
3. **user32 EDIT** — `LoadCursorW(IDC_IBEAM)` + `SetCursor` map onto the SDL
   path; `route_mouse` sets the I-beam when the pointer hovers an EDIT child,
   the arrow elsewhere — notepad/edit fields get the I-beam for free.

The kernel posts the **effective** cursor to the UI bridge on every
pointer-move CHANGE (`onCursor` → `{type:'cursor', shape}`), debounced; os.html
maps the `SDL_SystemCursor` shape to `canvas.style.cursor` via `CURSOR_CSS`
(shape -1 = `none`). The WM.md deviation (native cursor, no kernel sprite)
STANDS — this is only about *which* native cursor, which CSS handles for free.

## The wire enum

`SDL_SystemCursor`'s own values are the wire shape end-to-end (C veneer →
`__sdl_set_cursor` → `SURFACE_SET_CURSOR` → kernel state → `onCursor` →
`CURSOR_CSS`): 0 default, 1 text, 5 nwse, 7 ew, 8 ns, 11 pointer, … -1 hidden.
`CURSOR_CSS` lives in BOTH host.js (module const, for the standalone-canvas
`__sdl_set_cursor`) and os.html (it is a standalone HTML bridge, not a host.js
importer) — keep the two in sync.

## Headless assertion

Cursor is browser-only RENDERING (the 0063 glass rule) — the kernel state is
assertable but never drawn headless. `WMP_CURSOR_AT` (0x34) → `R_CURSOR`
(0x45) is a **pure query** of `_wmCursorAt` at a screen point;
`wmctl cursor X Y` prints the shape. `test_cursor_e2e.js` drives `winbox cursor`
("curbox", I-beam client) + `winbox fixed` and asserts: client TEXT readback,
EW/NS/NWSE on the resizable frame, arrow on title/desktop/fixed-frame.
`test_user32_e2e.js` grew a leg: a real `wmctl smove` over ctldemo's Name EDIT
flips the surface cursor to TEXT, over the STATIC to arrow.

## Gotchas hit

- **The SDL veneer is ONE big template literal in compiler.js** — C comments
  there must not contain backticks or `${` (they close the JS string). Bit me
  twice (``canvas.style.cursor``, `` `cursor: none` ``); both re-worded.
- **The win32 veneer builds ANSI (`#undef UNICODE`)**, so `IDC_*` are LPSTR;
  passing them to `LoadCursorW(…, LPCWSTR)` or comparing `name == IDC_IBEAM`
  is a pointer-type mismatch. LoadCursorW compares the ORDINAL (`ULONG_PTR`),
  and `update_cursor` calls the internal `cursor_token(shape)` directly rather
  than round-tripping through LoadCursorW.
- **SetCursor debounces** (`cur == g_curCursor` early-return) so the per-move
  hover calls only reach the kernel RPC on an actual shape change — the SDL
  cursor objects are cached per shape (`g_sdlCursor[]`), no per-move leak.
- **Only RESIZABLE surfaces get resize cursors.** The 0024 scale-drag works on
  fixed-size frames too, but showing a resize cursor there would over-promise;
  fixed frames read the arrow (matches Windows + the item's acceptance).
- **Ordering:** the kernel emits the cursor for a move using the CURRENT
  surface cursor, then routes the motion; an app's `SetCursor` in response
  lands for the NEXT move. `wmctl cursor` after a settle reads the updated
  state, so the headless tests sleep ~0.8s after an `smove`.

## Files

`compiler.js` (SDL cursor C API + `__sdl_set_cursor` import), `host.js`
(`setCursor` + `CURSOR_CSS` + the four backends), `kernel.js`
(`SURFACE_SET_CURSOR`, `surface.cursor`, `_wmCursorAt`/`_wmEmitCursor`,
`onCursor` opt, `WMP_CURSOR_AT`/`R_CURSOR`), `os/wm_proto.h`, `os/wmctl.c`
(`cursor X Y`), `os/kernel-worker.js` (`onCursor` post), `os/os.html`
(`CURSOR_CSS` + the `cursor` message case), `os/winbox.c` (`cursor` variant),
`os/win32/user32.c` (LoadCursorW/SetCursor + `update_cursor`). Tests:
`tests/unit/sdl_cursor`, `tests/kernel/test_cursor_e2e.js`, legs in
`test_user32_e2e.js` + `tests/browser/os-wm.mjs` + `os-user32.mjs`. Image
bumped **v64 → v65** (seeded `winbox.c`/`user32.c` changed).
