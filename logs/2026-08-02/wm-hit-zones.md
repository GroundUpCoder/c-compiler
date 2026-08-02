# #388 — fat resize hit zones (12px E/S band, 32px SE widening, 16px inward grip)

jku hit this live on mobile: the 4px resize frame and 16px SE grip are
too small to hit with a finger (and small for a mouse too). The kernel
cannot special-case touch — todos/0212 deliberately keeps pointer type
off the wm-input wire — so the zones grow for everyone.

## What changed

Hit-testing gets its own constants; `WM_BORDER` stays the DRAWN width so
the chrome is pixel-identical and no screenshot golden moves (`WM_GRIP`
turned out to be hit-only all along — no draw site — but it stays
exported untouched):

- `WM_BORDER_HIT = 12` — the band accepts presses 12px OUTWARD past the
  **right and bottom** edges (was 4). Invisible slop; steals nothing
  from the window's own client.
- `WM_GRIP_HIT = 32` — the SE corner widens E/S into SE within 32px of
  the corner (was 16).
- `WM_GRIP_IN = 16` — on a RESIZABLE surface the SE grip also reaches
  16px INWARD into the client, 'down' only (moves/ups/wheels still
  reach the app). This is what keeps a maximized/snapped window
  resizable — its outward band is clipped by the screen edge or covered
  by the taskbar. 16 = the classic scrollbar-corner size-box square
  (SM_CXVSCROLL), the slot Win95 itself used for the sizing grip.
  Fixed-size surfaces are exempt: a game keeps every client pixel; the
  0024 scale gesture stays on the outward band.

Both copies of the arithmetic — `wmPointer`'s hit test and the
`_wmCursorAt` overlay — moved together, and a test leg pins their
agreement.

## The direction call (recorded per the ticket)

Growth is **asymmetric**: outward on E/S/SE only, plus the inward SE
square. The first cut fattened all four sides, and the full browser
sweep caught a real regression (`os-shell`'s applet-close leg): in a
cascade, the higher window's invisible 12px TOP band overlays the
bottom ~12px of the window-behind's title bar and swallowed its close
box. Top/left are focus-only — slop there has no resize benefit and a
real chrome-steal cost — so N/W keep the thin 4px band. When #102 adds
the moving W/N edges it inherits this trade-off consciously.

## Evidence

`node tests/run.js --diff origin/main` mandated todos, kernel, sweep:
todos 3/3, kernel 147/147 (recorded == total), sweep 47/47 (recorded ==
total), all on the final tree. The pre-fix sweep run was 46/47 — that
failure is what forced the asymmetry, a live demonstration that the
sweep gate earns its runtime.
