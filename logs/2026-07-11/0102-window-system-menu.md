# 0102 — window system menu + keyboard move/resize (Alt+Space)

**Landed** 2026-07-11. Image **v61 → v62** (seeded `wm.c`/`wmctl.c` changed).
Item: `todos/0102`. Follow-up filed: title-bar right-click → sysmenu (see
Status line).

## What & why

The classic Win95 window system menu was entirely absent — no Alt+Space,
no keyboard path at all to move or resize a window (kernel drag is
pointer-only, the 0076 survey). This is the *accessibility* story for
window management and pairs with 0095's Win+arrow snap chords. Landed the
menu (Restore/Move/Size/Minimize/Maximize/Close) plus Move/Size as
arrow-key modes.

## Shape — the EV_CYCLE chord pattern, one more time

Nothing new architecturally: this is the fifth rider on the
subscriber-gated chord seam (cycle 0032 / start-menu 0078 / snap 0095 /
saver 0096 → **sysmenu 0102**).

- **Kernel** (`kernel.js`): `wmKey` intercepts **Space with Alt held**
  (scancode 44, `mod & 0x300`) and emits **WMP EV_SYSMENU 0x91** carrying
  `this._focusSid` — only with a subscriber, keyup swallowed, plain Space
  passes through. `wmSysMenu()` + the **WMP SYSMENU 0x33** dispatch case
  ride the same event (`wmctl sysmenu`). The OP map doubles as the strace
  decode table, so both constants live in the kernel.js WMP block, mirrored
  in `os/wm_proto.h`.
- **wm.c**: `ctx_open_sysmenu(w)` reuses the 0091 popup furniture (a
  "ctxmenu" root at the window's top-left), rows grayed per state (Restore
  only off the floating rect; Move/Maximize off while minimized; **Size
  only on a resizable window**; Maximize off when maximized). The
  Restore/Min/Max/Close rows reuse the existing chrome ops.

## The one genuinely new bit — the modal move/size grabber

Move/Size can't just fire-and-dismiss: wm.c only receives keys while one of
its own furniture windows holds kernel focus. So picking Move/Size does
**not** dismiss the popup — it stays up as the **key grabber**. New module
state (`sys_mode` 0/1/2, `sys_target`, stashed `sys_x0..h0`); `ctx_key`
short-circuits to `sys_key` while `sys_mode` is set: arrows nudge the
target 8px via ordinary MOVE/RESIZE (the echo re-syncs the model),
non-arrow keys swallowed (modal), **Enter commits**, **Esc reverts** to the
stashed rect. `sys_end` tears the popup down and hands focus back. Any
`ctx_dismiss` clears the mode; `EV_DESTROYED == sys_target` ends it
(defensive).

Handling CM_MOVE/CM_SIZE happens at the TOP of `ctx_activate`, before its
generic `ctx_dismiss()` — otherwise the grabber window would be destroyed
before the mode began.

### Recorded v1 simplification

The popup stays **visible** during the mode (the window slides out from
under it) rather than Win95's hidden-menu + rubber-band move outline. The
grabber IS the popup — no separate outline window, no furniture focus
juggling, maximal reuse. If the operator finds the lingering menu
distracting, hiding it is a cheap follow-up (shrink/offscreen the grabber,
or a dedicated borderless focus-holder).

## Deferred (a possible follow-up, filed)

The plan offered title-bar right-click as an *option* ("decide there or
defer to keep this keyboard-only"). Deferred — the chord + `wmctl` cover
the acceptance, and the kernel chrome hit-test already knows the title
region, so it's a clean standalone add. Filed as a new queue item (named in
the 0102 Status line).

## Tests

- `test_wm_policy.js` — EV_SYSMENU chord round-trip: gated on a subscriber,
  keyup swallowed, plain Space reaches the app, SYSMENU command = the chord.
- `test_wm_service_e2e.js` — real wm.c over boot.js: sysmenu opens, Move +
  arrows relocate (+32,+16) and Enter commits, Esc reverts, Size grows the
  resizable winbox (+32,+32), Size disabled on fixbox, Close tears down.
  Fresh winbox + fixbox so the leg is independent of the earlier churn.
- `tests/browser/os-wm.mjs` — Alt+Space opens the menu (VT1 wmctl check +
  fill-unchanged proves the swallow), keyboard-only Move commits, Close via
  the menu, and **no-WM Alt+Space reaches the app** (fill toggles).

**Verified**: `node tests/kernel/run.js` **53/0** over a fresh v62 bake.
Browser tier NOT run this session (no Playwright in this env) — the
operator should run `node tests/browser/os-sweep.mjs --filter=os-wm`.

## Gotchas for next time

- **Sysmenu row Y math**: rows 0–4 are 20px each, then an 8px SEP, then
  CLOSE — so CLOSE's center is `4 + 5*20 + 8 + 10 = 122`, not `4 + 6*20 +
  10`. The e2e's `rowYsys(i)` accounts for the sep.
- **The grabber is the "ctxmenu" popup**: during move/size the window
  `wmctl list | grep ctxmenu$` is still present. Tests target injected keys
  at its sid (INJECT_KEY, focus-independent).
- **`ctx_key` Down skips SEP but NOT GRAY** — keyboard nav lands on a grayed
  row (RESTORE when floating); Enter there is a no-op (`ctx_activate` bails
  on GRAY). So Down×2 reaches MOVE, Down×6 reaches CLOSE.
- **`wmctl key` sends down THEN up**; only the down edge nudges (dispatch
  gates on `if (down)`), so one `wmctl key` = one 8px step.
