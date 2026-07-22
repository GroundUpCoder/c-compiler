# 0282 — Start-menu flyouts render below their parent (anchored-child conversion)

**Bug** (jku-reported, P0): when a Start-menu flyout/submenu overlaps the panel
it cascades from — forced on small/mobile viewports, where the work-area clamp
slides the column back over the root — the child rendered BELOW the parent.
At 360x640 the "All Programs" tree flyout was almost entirely hidden under the
root panel (only the sliver past the root's right edge showed).

**Root cause** (todos/0282): wm.c created its menu columns as bare ownerless
top-levels (`SDL_CreateWindow`, parent used only for positioning math), then on
every flyout open sent `WMP_FOCUS {smroot.sid}` to keep the keyboard on the
root — and `wmFocus` raises its target to the top of its layer, hoisting the
root ABOVE the just-created flyout. Plain same-layer siblings have nothing
keeping child over parent. For real anchored children (todos/0256) the
inversion is impossible: `_wmZNormalize`'s post-pass re-slots each child
subtree immediately above its parent after EVERY z mutation.

**Fix — ride the 0256 foundation, don't invent a z rule:**

- `wm.c wmmc_win_create`: every chain level with an owner surface is now a
  kernel anchored child via `SDL_CreatePopupWindow(owner, dx, dy, w, h,
  SDL_WINDOW_TOOLTIP)` — deeper levels anchor to the previous column, the
  level-0 Start flyout to the root panel. TOOLTIP (not POPUP_MENU) is
  deliberate: the kernel grab's press-outside-dismisses/press-consumed
  semantics would replace wm.c's 0091 focus-leave dismissal rule; anchoring is
  wanted, the grab is not. The ctx-menu ROOT keeps the old path — it opens at
  the pointer with no owner surface (anchoring it to the desktop would sink it
  to layer -1, since children inherit the parent's layer).
  The existing work-area clamp still runs in screen coords, then converts to
  parent-relative offsets — the kernel's own into-the-screen clamp for
  anchored children is already satisfied, so the two clamps never fight.
- `wm.c` EV_CREATED: anchored echoes carry no title (the popup API takes none;
  the "startmenu2"/"ctxmenu2" titles land via SET_TITLE right after create, so
  tests keep their handles) — they're recorded into `ov[]` by CREATION ORDER
  (echoes are emitted inside the synchronous create RPC). The chain-level
  MOVE + SET_LAYER + FOCUS juggling is gone: anchored children are
  kernel-positioned, layer-inherited, and never focused by construction —
  which was the WM's "root keeps the keyboard" intent all along, now with
  zero hand-back races (previously keys could land on a flyout in the window
  between its create-focus steal and the root FOCUS hand-back).
- `kernel.js` (the ONE kernel-side line, a 0069 × 0256 interaction the
  wm-as-popup-consumer case exposed): subscriber-owned anchored children are
  exempt from map-on-placement gating. Their placement IS decided at create
  (`_wmAnchorApply` runs before the map check), and no map ack could ever
  land — every WM geometry/stacking op refuses children with EPERM — so a
  gated one (only possible when the SUBSCRIBER creates popups, which nothing
  did before this) would strand invisible on the 200ms backstop timer.
- `os/boot.js --screen=WxH`: headless screen dims (kernel default stays
  1024x768) — the small-viewport repro/confirm knob.

**Deliberate non-change:** the menu subtree now sits below the taskbar within
layer +1 (pre-fix, the FOCUS side effect hoisted the root above the bar). This
is invisible — root and flyouts clamp to the work area, so they never overlap
the bar band — and asserting nothing about it keeps the z story honest: the
bar is furniture, the menu is furniture, neither occludes the other.

**Evidence:** headless 360x640, Start → All Programs. Before (v141): `wmctl
list` z bottom→top = startmenu2(1) < taskbar(2) < startmenu(3) — flyout under
everything, screenshot shows it buried. After: startmenu(1) < startmenu2(2),
flyout draws fully above the root; root keeps `f`, and Esc injected at the
FOCUSED window (sid 0) closes just the deepest level — keyboard nav still
routes via the root.

**Tests:** `test_wm_policy.js` — subscriber-owned anchored child maps AT
CREATE + stays above its owner across an owner raise (the exact inversion
trigger); `test_wm_service_e2e.js` — startmenu2 z-sorts above startmenu,
startmenu3 above startmenu2 (red on v141, green here).
