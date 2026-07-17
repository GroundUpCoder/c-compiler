# 0259 — menu m4 menucore reseat

- **Status**: done (image v119; ticket #64)
- **Design**: menu-uniform architecture A13 (the coordinator-held design
  note); seam landed by 0257 (`os/win32/menucore.h`)

## Goal

The A13-Option-B milestone: the ONE menu engine. Extract user32.c's
tested menu engine (model + geometry + tracking + raster over HDC) into
`os/win32/menucore.c` behind the 0257 MenuCoreOps vtable, and RESEAT
wm.c's fork engines — the Start-menu flyout columns (`MENU_DEPTH 4` cap)
and the ctxmenu/ctxmenu2 engine (one-flyout cap) — onto it, deleting the
fork and curing both depth caps (chain to MENU_MAX_DEPTH 16, loud past
it). Fold in the menu-tree UNION (/etc/menu ∪ /usr/share/menu, /etc wins
same-name clashes — the gucman prerequisite; resolves the 0244 "4th
class member" + the 0250 load_entries deferral).

## Plan

- menucore.c: engine moved verbatim; sys colors + strip_amp +
  draw_raised move with it (shared vocabulary); the engine's one SDL
  call becomes the `screen_size` op. `__win32_unsupported` moves
  kernel32.c → gdi32.c and gdi32's W wrappers split into gdi32w.c so the
  wm link set (menucore.json: menucore.c + gdi32.c + freetype) carries
  no kernel32/user32.
- user32.c thins to the win32 front-end (HMENU API, bar strip,
  notifications, TrackPopupMenu pump, agent path) — corpus
  byte-identical.
- wm.c: ctx menus + Start flyouts become engine trackings over wm's own
  furniture-window substrate (focusable borderless top-layer windows,
  EV_CREATED parking, focus-leave dismissal — kept because wm popups
  must HOLD kernel focus for keyboard nav; the Start ROOT panel stays
  wm-drawn, a surfaced residual). Sysmenu Move/Size keep the
  popup-as-key-grabber via front-end interception ahead of the engine
  fire.

## Acceptance

- Corpus e2es (user32/winmine/fileman_ops/ctxmenu EDIT legs + os-user32)
  green with the M1 assertions unchanged (extraction guard).
- Depth-cap cure red→green: a 4-dir /etc/menu tree cascades to
  startmenu6 (old wm refused past startmenu4 — `wait win startmenu5`
  times out on the pre-0259 wm).
- Union red→green: /etc/menu entries listed ALONGSIDE the baked tree
  (old wm shadowed it — flyout height assert fails pre-0259).
- Image v119; kernel suite + browser sweep green; compiler.js untouched.
