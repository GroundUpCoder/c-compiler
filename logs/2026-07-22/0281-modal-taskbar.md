# 0281 — modal dialogs (MessageBox) get their own taskbar buttons

**Branch**: `modal-taskbar-0281` (base origin/main @359a4c7, v142). Ships as v143.

## The bug
A MessageBox / modal dialog is just another framed top-level surface, so wm.c
gave it its own taskbar button — a notepad-style "Save changes?" confirm shows
as a SECOND app button. Win95 never lists owned/modal popups. WMP had no
ownership/transient concept.

## Mechanism (the WMP_F_ALPHA precedent, end-to-end)
A NEW boolean **transient/owned** flag, threaded SDL flag → kernel surface bit →
WMP record bit — deliberately SEPARATE from 0256/0282's anchored-child flag
(anchored children are borderless/unfocusable/button-less; a modal is the
OPPOSITE — framed, focusable, would otherwise get a button):

- **compiler.js** — `SDL_WINDOW_UTILITY 0x20000` (real SDL3 value; documented
  "doesn't appear in the taskbar").
- **host.js** `surfaceCreate` — `SDL_WINDOW_UTILITY` → kernel surface flag **bit4**
  (16). (bits 0-3 taken; anchored/grab at 6/7; 4/5 were free.)
- **kernel.js** — `surf.transient` (create-only, never settable via SET_FLAGS);
  `_wmpRecord` emits **WMP_F_TRANSIENT 128** (record bit7; 64 is anchored).
- **wm_proto.h** — `WMP_F_TRANSIENT 128`.
- **user32.c** `create_window_impl` — sets `SDL_WINDOW_UTILITY` for the `#32770`
  class (MessageBox + DialogBox, modal AND modeless — owned dialogs are never
  taskbar entries).
- **wm.c** EV_CREATED — a transient surface is **placed** (so the 0069
  map-on-placement still maps it and it becomes visible; the kernel owns its
  chrome/drag) but kept **OUT of wins[]**. Since wins[] drives the taskbar,
  cycle, cascade/tile, and minimize-all, ALL of those skip it for free — no
  button, not a cycle stop. Its create-focus stands (we send no FOCUS), so the
  modal has the keyboard as it should.

wm.c-out-of-wins[] was chosen over "keep it in wins[] and skip in draw_bar"
because the taskbar buttons are index-keyed on wins[]; skipping mid-array would
misalign every button's position + click mapping. Excluding it is cleaner and
covers cycle/cascade/tile uniformly.

**Scope note (not implemented, per the todo):** the same flag could later
suppress the min/max title-bar boxes on modals. Left as a code comment only.

## Alt-Tab / cycle (decided + pinned)
Cycling **skips transients** — cycle() walks wins[], transients aren't in it. A
modal is not a cycle stop of its own.

## Observability
`wmctl` FLAGS column grew an 8th char **`U`** for transient (was 7). This
widened the column, so three width-sensitive test matches needed updating
(NOT product regressions):
- `test_wm_service_e2e.js:874` `f---R-` → `f---R---`
- `os-quake.mjs` ×2: `f..r--` → `f..r----`
(All other FLAGS readers use substring/index checks — width-robust.)

## e2e (red→green, pinned)
Notepad isn't seeded (compile-stage only), so the seeded MessageBox acceptance
app `/bin/ctldemo` stands in (identical bug shape). `test_user32_e2e.js`, on the
existing `mblist` `wmctl list` capture with the "About ctldemo" modal up:
- the modal surface carries `U` in FLAGS;
- **taskbar-button count == 1** (non-borderless, non-transient rows).

RED (clean pre-fix build, verified by reverting the 7 sources + rebaking):
modal FLAGS `f-----` (no U), buttons = `Control Demo | About ctldemo` (**2**).
GREEN: modal `f------U`, buttons = `Control Demo` (**1**). Taskbar pixel shot
with the modal up shows a single app button.

## Gate
- Kernel suite green (test_clang_pkgs_e2e is the known -j4 dist/packages race —
  green in isolation).
- Full browser sweep (all 35 os-*.mjs) green.
- Flake gate 3× under load: user32 + wm_service stable 3/3; os-wm + os-user32
  stable 3/3. **os-shell is FLAKY under load but PRE-EXISTING** — clean
  origin/main flakes 0/3 (vs my build 1/3) on the SAME clipboard Ctrl+C/V/X
  leg, zero transient/modal/FLAGS involvement; my change is a strict no-op for
  every non-transient window (the new EV_CREATED branch is unreachable for
  them).
