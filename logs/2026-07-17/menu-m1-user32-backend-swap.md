# Menu build M1 — the user32 menu-engine backend swap (todos/0257)

The single biggest piece of the menu campaign: user32's HMENU engine keeps
its model, tracking, `WM_INITMENUPOPUP`/`TrackPopupMenu` timing,
accelerators, keyboard nav and agent protocol — but its PIXELS move from
the app's window surface onto the Spike-1 (todos/done/0256) kernel
anchored-child surfaces. Six couplings resolved, one data structure
replaced (A12), one seam made structural (A7/A13). Whole corpus migrated
by recompile; zero app-source changes.

## The couplings, and where each one went

1. **Overlay-on-every-present — deleted, not disabled.** `ReleaseDC` no
   longer knows menus exist. The bar is a persistent `SDL_CreatePopupWindow`
   strip child (TOOLTIP flavor — no grab: it lives forever) painted by the
   SAME `menu_draw_bar_into` through `__gdi_dc_wrap` of the *child's*
   surface, presented only when menu state changes. Real damage isolation:
   an animating client never touches menu pixels and vice versa.
2. **Client strip reservation — kept verbatim.** `GetDC`'s `oy += bar_h`,
   `GetClientRect`, `SM_CYMENU`, `AdjustWindowRect`, the dialog
   template-menu height bump: all untouched. The parent's top 20px become
   dead pixels under the strip child. This is what makes the corpus's
   on-screen geometry BYTE-IDENTICAL — the winmine geometry legs and every
   client-area pixel probe pass unchanged.
3. **Popup clamp-to-surface — gone; popups really overflow now.** Each
   open level is a transient anchored child (POPUP_MENU flavor — holds the
   kernel grab). Size is capped to the screen via `SDL_GetDisplayBounds`.
   **Design-note ambiguity resolved here:** §3.3.3 said user32 should
   "flip-up at the screen's bottom edge, flip-left at the right" using
   display bounds — but flip needs the anchor's SCREEN position, and
   owners deliberately cannot see surface positions in this OS (only
   dims). Spike 1's kernel slide-clamp exists precisely for this
   ("edge-avoiding popups without the app knowing screen dims", the
   xdg-positioner 'slide' shape, re-derived from dx/dy so it never
   accumulates) — so the kernel slide IS the edge policy, and user32 only
   guarantees the window fits the screen. This is the same layering as
   Wayland: constraint adjustment executes in the compositor because only
   it knows where things are. If real flip semantics are ever wanted,
   that's a kernel positioner flag (a new mechanism with a real customer),
   not an owner-side computation. Overlap from sliding is harmless for
   correctness: input routes by windowID, and a child composites above its
   parent by the A1 subtree ordering.
4. **`menu_close` parent invalidation — deleted.** Closing destroys the
   level windows (deepest-first, so each destroy pops its own grab holder
   and no kernel cascade ever races an app-side handle); nothing of the
   parent to repaint. The winmine test now pins the inverse invariant:
   parent client pixels byte-identical across popup open/close.
5. **Input demux.** Real pointer input arrives on the child windowIDs with
   child-local coordinates — `pump_sdl` routes bar-strip events and each
   level's events straight to `menu_bar_mouse`/`menu_level_mouse`. Bar
   coords are the OLD surface-strip coords by construction (the strip sits
   at (0,0), parent-width), so `menu_bar_rect/menu_bar_at` didn't change.
   The subtle piece is `menu_route_surface`: PARENT-surface-coordinate
   events still reach the chain, translated through the levels' nominal
   anchor offsets (deepest-first). Two callers need it: (a) kernel drag
   capture — a press on the bar that drags into the popup keeps delivering
   on the press window (the classic one-gesture menu select), and (b)
   agent `wmctl click SID x y` injection, which predates the child windows
   and is what every existing bar-click test uses (`click $SID 10 10`).
   Caveat recorded in-code: when the kernel clamp shifted a child, the
   nominal mapping is approximate — real input is always exact because the
   kernel inverse-maps per surface. Keyboard needed ZERO work: children
   never take focus, so keys keep arriving on the parent where
   `menu_route_key` already lives.
6. **(A5) Bar width-follow on WM_SIZE — the coupling the original note
   missed.** The parent's RESIZED handler calls `menu_bar_sync`, which
   owner-resizes the strip (`SDL_SetWindowSize`, the 0256 kernel
   owner-initiated child resize). That resize is ASYNC — the strip's
   surface re-derives and zero-fills at its own RESIZED ack, so the
   repaint hangs off THAT event, not the request. Getting this wrong shows
   as a blank strip after every resize.

## The pop/sub scalar → the chain (A12)

`g_menu` held exactly `.pop` + one `.sub` — a model-level 1-nested cap
("a sub-sub popup reports unsupported") that A1's arbitrary-depth kernel
tree would have made a lie for every win32 app. Replaced with
`MenuLevel lev[MENU_MAX_DEPTH]` (16, loud refusal past it — far beyond
what any screen can hang): each level records its table, HMENU, overlay
window, dims, anchor offset and hot row. Everything that special-cased
"the popup" vs "the cascade" became a loop or an index: `menu_sub_open(k,
row)` truncates deeper levels and opens k+1 anchored at the row's drawn
top on the level-k window; Esc/Left close exactly the deepest level;
hover-switch on the bar truncates to 0 without leaving the menu loop
(ENTERMENULOOP fires once per tracking, as before). The agent's
fire-by-label path got the same generalization — `menu_locate` finds the
(table,row) of an item at ANY depth, replacing the hand-rolled
one-cascade-down search. ctldemo's menudemo grew a third level
("More ▸ Deeper ▸ Epsilon") and shrank to 180x120 so the chain also
overflows the window edge; on the old engine the walk misfires cmd=301
where the third level should open — the red run showed exactly that.

## Why the seam is structural (A7/A13)

`os/win32/menucore.h` now holds the engine's entire outward surface as a
real struct-of-fn-pointers (`MenuCoreOps`: post_command, track_state,
popup_opening, win_create/win_destroy, win_begin/win_present) plus the
shared geometry constants. user32 instantiates it once (`g_mc`) with
PostMessage/SendMessage/SDL implementations; the tracking/geometry code
calls only through it. The point is A13's factual correction: wm.c ships
a COMPLETE second menu engine today (Start-menu flyouts + ctxmenu with
its own depth cap), so "no second customer" was false — the M4 extraction
(menucore.c consumed by both, deleting the wm.c fork) needs the boundary
to already be compiler-enforced, not a prose promise. Deliberately NOT a
registration framework: one plain vtable. The raster dependency is only
gdi32 (HDC), per the design.

## Testability upgrade that fell out

Popup windows are titled `#32768` (the real Win32 menu window class) and
the bar `menubar` — so menu open/close became a WAITABLE condition
(`wmctl wait win/nowin/atleast "#32768"`). Three blind sleeps died:
winmine's two `sleep 1` popup settles and ctxmenu's two
`sleep 0.5` "TrackPopupMenu is in-surface, no marker can see it" settles
(that comment is now false by construction). The grab-consumption leg
uses a focus fence: open the menu, press on winbox — the chain closes AND
winbox does NOT gain focus (the press was consumed whole); the next press
focuses it normally. On the old engine the ==grab list shows winbox
stealing focus — red exactly where the fidelity gap was.

## Gate

Red: all four updated e2es fail loud on the old engine (v115 bake) at the
new wait markers. Green: image v116 bake; kernel suite 82/82; browser
sweep 27/27 (incl. os-user32, os-fileman, os-gpubox real-cube); flake
gate 3/3 stable under load for the four changed e2es. compiler.js
untouched (the popup veneer landed in Spike 1) — no codegen, no SameBoy
interlock. CS_OWNCLIENT/GetWindowSDL (M2), the wm.c menucore reseat (M4)
and app-corpus sources untouched by scope decision.
