# 0257 — Menu build M1: user32 menu-engine backend swap onto anchored children

- **Status**: open
- **Design**: the menu-uniform architecture note (external design thread,
  2026-07-16/17) §3.3 (the five couplings) + amendments A5 (coupling #6:
  bar width-follows-parent), A7 (structural menucore seam), A12 (popup
  CHAIN, not the pop/sub scalar), A13 (land the seam AS menucore.h now;
  wm.c reseat deferred to M4). Builds on Spike 1 (todos/done/0256).

## Goal

Retarget user32's complete, tested HMENU engine (model/tracking/dispatch/
accelerators/agent protocol unchanged in substance) from in-surface pixels
onto the 0256 kernel anchored-child surfaces: the bar becomes a persistent
strip child presented only on menu-state change, every open popup level a
transient child window under the kernel grab. The whole win32 corpus
migrates by recompile — no app source changes.

## Plan

The six couplings (§3.3 + A5):

1. Overlay-on-every-present → DELETED (bar child painted via the same
   `menu_draw_bar_into` over `__gdi_dc_wrap` of the child's surface).
2. Client strip reservation (`bar_h` offsets, SM_CYMENU, AdjustWindowRect)
   → KEPT: on-screen geometry byte-identical for the whole corpus.
3. Popup clamping to the parent surface → transient anchored children;
   size capped to the screen (`SDL_GetDisplayBounds`); on-screen position
   is the kernel slide-clamp's job (only the kernel knows the anchor's
   screen position — the §3.3.3 "flip in user32" wording is not
   implementable owner-side; resolution in the dev log).
4. `menu_close` parent invalidation → DELETED (popups never overwrote
   client pixels).
5. Input demux → per-child-windowID routing (bar strip + each level),
   child-local coords; `menu_route_surface` keeps parent-coord delivery
   working for kernel drag capture and agent `wmctl click SID x y`.
6. (A5) Bar width-follows-parent on WM_SIZE via the 0256 owner-initiated
   child resize; repaint rides the strip's own RESIZED ack.

Plus: A12 popup CHAIN (`g_menu.lev[]`, the Win32 #32768 stack — the 0211
one-nested-level cap deleted); A7/A13 `os/win32/menucore.h` structural
seam (post_command / track_state / popup_opening / win_create / win_destroy
/ win_begin / win_present as a real struct-of-fn-pointers); popup windows
titled `#32768`, the bar `menubar` — real waitable markers replacing the
old blind pixel settles; grab dismissal (outside press closes the chain +
is consumed).

## Acceptance

- Whole corpus green by recompile: test_user32_e2e, test_winmine_e2e,
  test_notepad_menu_e2e, test_fileman_ops_e2e, test_ctxmenu_e2e,
  test_paint_e2e, browser os-user32/os-fileman/os-winmine/os-paint.
- New red→green legs: 3-level cascade (A12, ctldemo menudemo grew a third
  level and shrank so the chain overflows), chain overflow past the parent
  edge + headless composite probe, bar width-follow on resize (A5,
  notepad), grab dismissal + consumption (focus fence on winbox).
- Closed-menu parent pixels byte-identical across popup open/close
  (winmine shot legs flipped from "pixels change" to "pixels identical").
- Image v116; kernel suite + browser sweep green; compiler.js untouched
  (the popup veneer landed in 0256) — no SameBoy interlock needed.
- Out of scope (guarded): CS_OWNCLIENT/GetWindowSDL (M2), wm.c reseat
  onto menucore (M4), app-corpus source changes (none).
