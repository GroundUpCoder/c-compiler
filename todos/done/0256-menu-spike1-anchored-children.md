# 0256 — Menu build Spike 1: kernel anchored-child primitive + grab + focus funnel + SDL popup veneer + menubox

- **Status**: open
- **Design**: the menu-uniform architecture note (external design thread,
  2026-07-16/17) — kernel owns the MECHANISM (anchored child surfaces), never
  "menu"; amendments A1 (arbitrary-depth tree), A2 (grab in v1), A5
  (owner-initiated child resize), A8 (scope = the anchored-popup family, no
  speculative knobs), A9 (focus funnel), A10 (thumbnail subtree compositing),
  A11 (materialize-at-mutation dst)

## Goal

The first build milestone of the uniform-menu architecture: one small,
policy-free, transport-blind kernel primitive — the anchored child surface —
plus the grab and the owner focus pair, exposed through stock SDL3
(`SDL_CreatePopupWindow`, `SDL_WINDOW_POPUP_MENU`/`SDL_WINDOW_TOOLTIP`,
`SDL_EVENT_WINDOW_FOCUS_GAINED/LOST`, `SDL_GetDisplayBounds`), proven
end-to-end by a winbox-class fixture app with NO user32 and NO menu code.

## Plan

- kernel.js: SURFACE_CREATE flag bit 6 + parentSid/dx/dy (same-pid parent,
  arbitrary-depth tree); recursive move/hide/raise/destroy/clamp hooks;
  materialized dst (scale inheritance) at every mutation site; no focus
  steal at create; click/wmFocus redirect to the anchor root; WM ops EPERM
  on children; owner-initiated child resize (WM_MIN_SIZE floor relaxed to 1
  for children); thumbnail subtree compositing; the grab (press outside the
  holder's window tree → WMEV.QUIT to the holder + press AND release
  consumed + grab released); the `_wmSetFocus` funnel emitting
  FOCUS_GAINED/LOST + EV_FOCUS at every `_focusSid` transition.
- host.js: `__sdl_create_popup_window` / `__sdl_get_display_bounds` in both
  flavors (same per-handle tables), focus-pair drain, POPUP_MENU→grab flag
  mapping, `hooks.screen` (vDSO read).
- compiler.js: SDL_popup.h + __SDL_popup.c as their OWN TU (the sdl3webgpu.h
  precedent) so the two new imports never land in non-popup binaries —
  SameBoy byte-identity is the interlock; __SDL_internal.h shares the
  window struct + registry array (register/unregister stay static).
- tests: tests/kernel/test_wm_anchored.js (kernel seam, no wasm) +
  tests/kernel/fixtures/menubox + test_menubox_e2e.js (real veneer via
  wmctl).

## Acceptance

- Red→green on every mechanism leg (52 FAILED at the kernel seam pre-change;
  the e2e dies loud pre-change).
- Kernel suite green incl. the two new files; browser sweep 27/27; SameBoy
  byte-identical; menubox stays a fixture (image v115, no bump).
