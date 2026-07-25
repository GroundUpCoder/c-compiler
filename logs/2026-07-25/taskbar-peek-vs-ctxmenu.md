# Taskbar hover preview killed the right-click menu (wm.c transient policy)

Reported 2026-07-25: "at the bar at the bottom for a running gui program, if I
right click, the menu will show up, but if I move the mouse at all to get the
entries, the menu will instantly disappear and I see the hover preview."

## Root cause — two independent kill paths, one cause

All of this is wm.c policy; kernel.js only routes and compositor.js only draws.

Motion over the taskbar reaches `bar_motion()`. Its only stand-down guard was
for the Start menu (`if (smroot.win) return;`), so with a context menu open the
taskbar-BUTTON branch fell straight through to `peek_show()`. From there:

1. **The create-focus steal.** `peek_show` makes an ownerless borderless
   top-level, and kernel.js focuses every parentless new surface
   (`if (!parent) this._wmSetFocus(sid)`), emitting EV_FOCUS. wm.c's EV_FOCUS
   handler force-closes the ctx menu when focus lands on a sid the menu does
   not own — and the peek's sid is not ctx-owned.
2. **The hand-back.** Independently, the peek's EV_CREATED handler sends
   WMP_FOCUS back to the focused app window ("a hover preview must not steal
   focus from the app"). That app sid is *also* not ctx-owned, so it would have
   dismissed the menu even with (1) suppressed.

Patching only one of those looks correct and still fails.

The adjacent clock branch of the *same function* already got this right —
`!(__mc.open && mc_kind == MK_CTX)`, commented "whose root must keep focus".
The button branch two lines down was simply never given the same gate.

## Why not the one-line copy of that gate

The hole is general, not peek-specific: **any** transient ownerless surface
raised while a focus-owning popup is up kills it, and any transient merely
still *alive* when one opens kills it later — the frame loop's PEEK_IDLE_MS
auto-dismiss destroys the surface and focus falls again. Same class: the date
tooltip (already special-cased), the Run… dialog (`run_dismiss` is focus-leave
driven too — hovering a taskbar button with Run… open had the identical bug),
and any future tooltip/OSD. Copying the gate would have made it the second
hand-rolled copy in one function and the third site that must remember a rule
nobody wrote down.

## What landed — one invariant, two seams

> While a focus-owning popup is up, **no transient surface exists.**

- `popup_holds_focus()` — Start menu ∪ Run… dialog ∪ screensaver ∪ ctx menu.
  (`sys_mode` needs no entry: keyboard move/size keeps the sysmenu popup up as
  the grabber, so MK_CTX covers it.)
- **Creation seam:** `peek_show()` / `date_show()` return early on it —
  inside the creators, not at their call sites, so a future caller inherits
  the rule. `bar_motion`'s inline copy was *deleted*, not duplicated.
- **Popup-open seam:** `transients_dismiss()` from `ctx_begin()` (the one
  choke for all five `ctx_open_*`), `menu_open_root()` and `run_open()`.

Killing the CREATE is what makes this structural rather than a patch per focus
op: no surface ⇒ no create-focus steal, no EV_CREATED echo, no hand-back, and
nothing left for the idle timer to destroy. Both kill paths die at once.

Ordering detail worth keeping: `transients_dismiss()` runs *before* the popup
is created. The destroy's focus fall is emitted by the kernel ahead of the
create, so it arrives while `ov[0].sid` is still 0 and the EV_FOCUS gate
already ignores it — the same reason `bar_rclick` dismissed in that order.

## Semantics settled

- Hovering a *different* taskbar button with the menu open: menu stays, no
  preview (Windows behavior) — falls out of the creation-seam refusal.
- Preview already showing when the right-click lands: dropped, not stranded
  (`bar_rclick` already did this locally; `ctx_begin` now covers the desktop /
  icon / title-bar openers too, which did not).
- The PEEK_IDLE_MS auto-dismiss cannot fire into an open menu: it only ever
  *destroys*, and the invariant means there is nothing to destroy.
- Start menu: unchanged. `bar_motion`'s `smroot.win` early return stays (with
  the root panel over the strip there is nothing there worth computing).

## Test

`tests/kernel/test_ctxmenu_e2e.js` grew five checks driven by `wmctl hover`
over the taskbar with the window menu open. Verified RED on the pre-fix wm.c:
`wait flag $WSID m` times out because the MINIMIZE row never fires — the menu
was already dead when the click landed.

The two `wait nowin peek` legs use a deliberately SHORT 1500ms timeout:
PEEK_IDLE_MS is 2500, so a longer wait could nap past the auto-dismiss and
pass without the fix.

Image bumped v163 → v164 (wm.c is baked in).

## Surfaced, not fixed

`tests/browser/os-drop.mjs:143` has a needle satisfied too early:
`waitForFunction(... __osOut.includes('run-winbox'))` is met by the FIRST row
of columnar `ls` output, then line 145 asserts on `blob-1.bin`, which is in a
later row still streaming. It failed once in a 12-file batch and passed 3/3
under load afterwards — a latent flake of the class `todos/0171` retires, in a
file unrelated to this change.
