# Menu build M4 — menucore.c extraction + the wm.c reseat + the menu-tree union (todos/0259)

The A13-Option-B milestone: the menu world's fork is deleted. The engine
that 0257/0258 proved inside user32.c now lives in `os/win32/menucore.c`,
and wm.c — customer #2 on the A13 record — consumes it for its Start-menu
flyouts and context menus, retiring its own two engines and both of their
depth caps.

## The extraction (behavior-preserving, by construction and by gate)

Everything the two customers share moved VERBATIM: the MenuTbl/MenuItem
model (+ append/clear/destroy/find/locate), geometry (the cached measure
DC, text widths, `mc_tbl_size`/`mc_tbl_at`), the raster
(`mc_draw_tbl`, and `draw_raised` — the Win95 3D edge user32's controls
also use, now exported as `mc_draw_raised` with a one-line user32
wrapper), and the open-chain tracking (`__mc`, trunc/close/level_open/
sub_open/fire/level_mouse/route_key). Three things changed shape, none
of them behavior:

- The engine's ONE direct SDL call (`SDL_GetDisplayBounds` capping a
  level's size) became a vtable op (`screen_size`) — menucore now
  genuinely knows only gdi32/HDC plus the ops, as the header always
  claimed.
- `mc_fire` captures the item id BEFORE closing the chain. The old code
  read `it->id` after `menu_close()`; safe in user32 (menus persist),
  a use-after-free for a front-end that frees its per-tracking tables.
  wm.c defers its table teardown to the next open anyway (a fired id is
  resolved back to a path after the close), so both layers guard it.
- `mc_route_key` returns whether it owned the key, so a front-end can
  layer type-ahead (wm keeps its 0078 first-letter behavior via the new
  `mc_typeahead`; user32 keeps swallowing everything — its modality is
  unchanged, mnemonic keys stay future work).

Two link-set moves let wm.c carry the engine WITHOUT the veneer:
`__win32_unsupported` moved kernel32.c → gdi32.c (libc-only, and gdi32
is the base every set shares), and gdi32's W text/font wrappers split
into `gdi32w.c` (they need kernel32's UTF-16 boundary; they ride in
lib.json with the veneer). `os/win32/menucore.json` is the shared lib
(menucore.c + gdi32.c + freetype); lib.json deps it. tools/win32ports.js
grew the 0079 diamond-dep dedup its expansion comment already promised
(freetype now arrives via two paths).

Proof the extraction changed nothing: the whole corpus compiles
(`win32ports` 7/7 links), and the corpus e2es — test_user32, winmine,
fileman_ops' fileman legs, ctxmenu's EDIT/TrackPopupMenu legs, browser
os-user32/os-winmine — pass with the M1 assertions untouched.

## The wm.c reseat — what moved, what stayed, and why

DELETED from wm.c (~600 lines of fork): the `menu_col mcol[MENU_DEPTH]`
flyout engine (row math, open/close/hover/click/keyboard/type-ahead,
`draw_menu_col`), and the whole ctx engine (`ctx_ents`/`ctx_row_*`/
`ctx_openwin`/`ctx_open_flyout`/`ctx_click`/`ctx_motion`/`ctx_key` nav/
`draw_ctx`, and its "at most one ctxmenu2" cap). wm's menus are now
engine trackings: measured widths, 18px rows, freetype text — the same
raster as every win32 app's menus. `MENU_DEPTH 4` and the one-flyout cap
are cured by the same `MENU_MAX_DEPTH 16` chain user32 uses.

KEPT in wm.c, deliberately — the honest residuals:

1. **The window substrate.** wm's MenuCoreOps.win_create makes ordinary
   borderless top-layer furniture windows (EV_CREATED parking, the 0091
   focus rules, focus-leave dismissal) rather than kernel
   anchored-children with the grab. Reason: keyboard. A user32 app's
   chain hangs off its own focused top-level, so keys reach the engine
   via the parent. The WM has no parent app window — its ctx popup must
   HOLD kernel focus or arrow keys would land in whatever app was
   focused (the sysmenu case makes this vivid: the target window is the
   focused one). Focus-holding popups and the anchored-child/grab model
   are mutually exclusive; the 0091 furniture pattern stays, the ENGINE
   above it is shared. Titles stay "ctxmenu"/"startmenu2"… (now
   "ctxmenu3+"/"startmenu5+" exist past the old caps).
2. **The Start ROOT panel.** Search box, pinned/MRU rows, the gucOS
   band, fixed places, bottom All-Programs — that is shell furniture,
   not an item-tree menu; forcing it into the engine's model would have
   been the bad fit the milestone brief warned against. It stays
   wm-drawn (5x7 font and all); only the CASCADES are engine levels.
3. **Sysmenu Move/Size.** Their popup-stays-up-as-key-grabber behavior
   (0102, test-pinned six ways) contradicts the engine's fire-closes
   rule, so the front-end intercepts those two rows BEFORE the engine
   sees the press (and swallows the paired button-up — the first run
   taught us the engine's press-drag-release fire catches the release
   otherwise), enters the mode, and leaves the chain open. Everything
   else fires through `post_command`.

Deliberate behavior adoptions (engine semantics, all Win95-faithful,
tests updated): Esc/Left close chain levels one at a time instead of
dismissing everything; keyboard Up/Down skip GRAYED rows (os-wm's
sysmenu leg counted Downs through a grayed Restore); right-click no
longer fires menu rows; a dead-zone click inside a popup still
dismisses (front-end policy re-added on top of the engine, which
ignores it).

One found-by-test engine/front-end contract bug: wm passed NULL
owner/cmd tokens to `mc_track_begin` and the standalone fire path guards
`&& cmd` — every wm menu opened and closed perfectly but never posted a
command. The tokens are non-NULL opaques now, with a comment.

## The union (ex-0244 "4th class member", ex-0250)

`menu_load_union(rel)` reads `/etc/menu/<rel>` AND
`/usr/share/menu/<rel>`, /etc winning same-NAME clashes, one merged
groups-first sort — at EVERY level (the engine's lazy `popup_opening`
population makes this natural: each level re-reads its union directory
as it opens). The live search walks both roots with the same dedup. So
a package (gucman-to-be) can drop one entry into the writable /etc/menu
without hiding the baked tree — which is exactly what the old
first-existing-dir rule did.

## Red→green, proven against the OLD wm.c

Baked an image with HEAD's wm.c and drove the new legs:

- **Union red**: with `/etc/menu/D1` present, startmenu2 listed ONLY it
  (`150x28`, one row) — the baked Accessories/Demos/Games shadowed.
  Green: the tree lists the union (the wm_service leg asserts the
  4-group height with /etc/menu/Apps present).
- **Depth red**: `wmctl wait win startmenu5` timed out (the MENU_DEPTH-4
  refusal). Green: a 4-dir tree cascades root → startmenu2..6 (five
  chain levels), x strictly advancing, Enter at depth 5 fires the leaf.

## Test churn (the honest ledger)

wm-menu geometry moved from the fork's 20px-row/fixed-width constants to
the engine's 18px rows + measured freetype widths, so every test that
clicked wm menus by coordinate was recomputed: test_ctxmenu_e2e (row
math + width-structural geometry asserts + shot probes moved to the
left gutter / parsed-width points, dark-not-black text under AA),
test_wm_service_e2e (flyout/0101/sysmenu rows), test_recycle_e2e,
test_fileman_ops_e2e (the wm desktop legs only), browser os-ctxmenu
(gutter samples + a probe loop for the measured flyout x), os-shell
(edge-scan for measured column widths), os-touch, os-recycle, os-wm
(grayed-skip Down counts). test_wm_fatal_e2e builds wm via the project
(os/wm.json) instead of the dead single-file cc invocation. Width is
asserted STRUCTURALLY everywhere (flyout x == parent x + parent w - 3,
h == 4 + 18n + 8s) — no freetype metrics baked into tests.

## Gate

Image v119 (wm switched to a `project` entry — os/wm.json). Kernel suite
84/84; browser sweep 27/27 (incl. os-user32, os-wm, os-gpubox real-cube);
flake 4× changed kernel e2es 3/3 stable under load ×10; corpus compile
7/7 links; compiler.js untouched (no codegen, no SameBoy interlock).
wm.wasm grows to ~370KB (freetype rides along) — the price of one
raster instead of two.
