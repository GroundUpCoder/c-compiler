# 0282 — Start-menu flyouts render below parent — WM furniture uses ownerless top-levels not anchored children

- **Status**: done
- **Design**: os/wm.c Start-menu/flyout creation; rides the existing 0256 anchored-child foundation (WMP_F_ANCHORED); found via jku report + root-cause investigation 2026-07-22

## Goal
When the Start menu and its child flyouts/submenus overlap the parent panel,
the child renders BELOW the parent in z-order. Desired: a child/owned/popup
window always draws ABOVE its owner when they overlap. Most visible on small/
mobile viewports where overlap is forced.

## Root cause (investigated — evidence-backed)
Z-order lives in the KERNEL, not wm.c: `kernel.js` `_zOrder` array
(kernel.js:1991) is painted in order by `compositor.js` (603-660).
`_wmZNormalize()` (kernel.js:5411-5446) stable-sorts by layer and runs an
**anchored-child post-pass**: for each top-level it re-slots each child subtree
(via `parentSid`/`children`) immediately above its parent — "children can never
interleave with foreign windows." **This ALREADY implements the desired
child-above-parent behavior — but only for ANCHORED children.**

The Start menu's own furniture is NOT anchored — the WM creates it as bare,
ownerless, independent top-levels:
- `wm.c` `menu_open_root()` (~1760-1772): root panel via plain
  `SDL_CreateWindow(..., SDL_WINDOW_BORDERLESS)`.
- `wm.c` `wmmc_win_create()` (~1595-1627): the flyout/submenu factory RECEIVES
  a `parent` MCWIN but uses it ONLY for positioning (px/py offset); the surface
  is a fresh `SDL_CreateWindow(..., SDL_WINDOW_BORDERLESS)` with NO parent-
  surface linkage sent to the kernel.
- The z-inversion trigger — `wm.c` EV_CREATED flyout branch (~3629-3646): the
  flyout is put on the top layer (`WMP_SET_LAYER {sid,1}`), same layer as root
  (also layer 1), then the WM sends `WMP_FOCUS {smroot.sid}` to keep the
  keyboard on the root ("Flyouts must not hold focus"). In the kernel
  `wmFocus(smroot.sid)` raises the ROOT to the top of layer 1
  (kernel.js:5485-5489). Root and flyout are plain non-anchored siblings on the
  same layer → nothing keeps the flyout above the root → **child renders below
  parent.** For a real anchored child this is impossible: `wmFocus` on a child
  redirects to its root and `_wmZNormalize`'s post-pass re-slots the child above
  the parent after every z mutation.

## The foundation already exists (0256 anchored children) — NO new plumbing
- `WMP_F_ANCHORED 64` (wm_proto.h:250-262, todos/0256): "anchored child surface:
  pinned to a same-process parent, moved/hidden/raised/destroyed/scaled with it,
  never focused; always borderless."
- Surface records already carry `parentSid, dx, dy, children` (kernel.js:1989),
  populated at create, destroy-cascaded, used by `_wmAnchorLayout`/
  `_wmMoveWithChildren`/`_wmZNormalize`.
- Create API already wired: `SDL_CreatePopupWindow(parent, dx, dy, w, h, flags)`
  → kernel `surfaceCreate(..., parentSid, dx, dy)` with the anchored bit.
  **user32.c already uses this for its OWN menus** (user32.c:1127, 1373, 1488).
  The WM simply isn't using the popup API it already ships to apps.

## Plan (moderate, localized to wm.c — NO kernel change)
- `wmmc_win_create` (wm.c:~1620): create flyout levels via
  `SDL_CreatePopupWindow(parent, dx, dy, w, h, SDL_WINDOW_POPUP_MENU)`. For the
  level-0 Start flyout pass `smroot.win` as the parent (file-scope static at
  wm.c:~390, in scope).
- EV_CREATED flyout branch (wm.c:~3629-3646): REMOVE the now-redundant manual
  `WMP_MOVE` + `WMP_SET_LAYER` — anchored children are kernel-positioned from
  `parentSid+dx/dy` and inherit the parent's layer; policy ops on anchored
  children now return EPERM (kernel.js:5458, 5505). The `WMP_FOCUS {smroot.sid}`
  juggling becomes unnecessary — anchored children never take focus by
  construction (which is exactly the WM's existing "root keeps the keyboard"
  intent, so the design is an unusually good fit for the anchored model).
- **The one real risk / care-area:** reconcile wm.c's manual menu positioning +
  work-area clamp (wm.c:~1607-1612) with the kernel's own edge-clamp for
  anchored children — don't double-clamp or fight the kernel geometry.

## Relationship to 0281 (they do NOT share a foundation — separate needs)
0281 (modal dialog gets its own taskbar button) needs a NEW boolean "am I
transient/owned" flag on a FRAMED, FOCUSABLE, taskbar-buttoned surface — it
CANNOT reuse anchored children (those are borderless/unfocusable/no button).
This bug needs an owner-POINTER ("which surface owns me", to sort above it),
which already exists as `parentSid` via 0256. So 0282 rides 0256, 0281 needs its
own plumbing — genuinely separate. BUT both edit `wm.c` (0282: menu creation +
EV_CREATED; 0281: draw_bar) → if run near each other, SERIALIZE on wm.c (don't
run as parallel wm.c worktrees). 0282 is otherwise a clean standalone lane —
foundation is ready, no dependency on 0281.

## Acceptance
Start-menu flyouts/submenus always draw above the parent panel when they
overlap (verify on a small/mobile viewport where overlap is forced); keyboard
nav still stays on the root; kernel os-shell/os-wm sweeps + start-menu e2es
green; no golden regressions in menu geometry.
