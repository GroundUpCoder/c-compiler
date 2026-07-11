# 0095 — Aero Snap: drag-to-edge tiling + Win+arrow

**Item**: `todos/done/0095-aero-snap.md` · **Image**: v55 → **v56**

The single most recognizable Win7 interaction, on the Win95-bones-plus-
Aero desktop: drag a title bar to a screen edge and a translucent
preview shows the tile; drop commits it — left/right halves, corner
quarters, top = maximize. Drag a snapped window away and its floating
size comes back. Win+Left/Right/Up/Down does the same from the
keyboard. Zero new rendering machinery: the preview is just a 0063
per-pixel-alpha window.

## Shape: mechanism in the kernel, policy in wm.c — again

The 0025/0032 split repeats and it's worth recording *why* it fits so
cleanly:

- **The kernel owns the title drag** (it moves the surface live), so
  only the kernel can see the pointer cross an edge zone. It reports
  zone changes (`EV_SNAP_EDGE {sid, edge}` — 0 = left the zone, 1/2 =
  L/R, 3 = top, 4–7 = corners; `WM_SNAP_MARGIN` = 8px on the POINTER,
  not the window) and the release (`EV_SNAP_DROP {sid, edge, preX,
  preY}`, after the drag-end EV_MOVED). It commits **no geometry** and
  keeps **no snap state**. No subscriber → no zones, byte-identical
  pre-0095 drags (kernel-chrome has no snap, the maximize precedent).
- **wm.c owns what a "half" is** (the work area is BAR_H/TITLE_H
  policy), the per-window snap edge, the saved floating rect, and the
  preview window. Quarters drop the bottom row one TITLE_H so both
  stacked title bars stay grabbable. Fixed-size windows letterbox with
  the same aspect-fit SET_DST maximize uses — snap dispatches on the
  resizable bit exactly like 0025.
- **Win+arrow is the EV_CYCLE chord pattern verbatim**: intercepted at
  the wmKey seam only with a WM subscribed, both edges swallowed,
  plain arrows pass through, `wmctl snap` = the same event
  (`EV_SNAP_KEY`). Left/Right wrap across the screen when pressed
  toward the edge already held; Up maximizes; Down restores
  snapped/maximized and minimizes floating.

Maximize (0025) got refactored ONTO the snap helpers rather than beside
them: top-snap sets the same `maximized` bit `title_activate` toggles,
and both restore through one `restore_floating`. So the title-bar
double-click un-snaps too, and the taskbar context menu's Restore row
un-snaps for free.

## The pre-drag-rect subtlety (worth remembering)

The drop needs to save the window's *floating* rect for a later
restore. But kernel emit order is EV_MOVED (drop position) →
EV_SNAP_DROP, and wm.c processes both from one drain — by snap time the
model already holds the DROP position, not where the window lived
before the drag. Fixed in the mechanism, not with policy-side stashing:
`_wmDrag` records `x0/y0` at drag-start and `EV_SNAP_DROP` carries them;
wm.c rewinds its model x/y to the pre-drag point before saving (the
snap's own MOVE echo re-syncs immediately). Without this, Win+Down
after a drag-snap "restored" the window to wherever the pointer had
dragged it mid-gesture — half off-screen at x=-84 in the repro.

## Headless title drags needed a new injection tier

`wmctl drag` (0077) is INJECT_POINTER — post-hit-test client injection
targeted at a sid, which by design can never touch chrome. Title drags,
and therefore edge snap, had no headless driver at all (0024/0025
tested chrome gestures via kernel-JS `wmPointer` calls in-process,
which can't reach a real `/bin/wm` through boot.js). New WMP
`INJECT_SCREEN {kind, x, y, a}` → `wmctl sdown|smove|sup|sdrag`: raw
screen coordinates through the full `wmPointer` path — hit test, title
bars, resize frames, snap zones — exactly what the browser mouse feeds.
The kernel drag state is global, so separate wmctl invocations compose:
`sdown; smove; wmctl list; wmctl shot screen; sup` holds the drag open
across processes, which is how the e2e asserts the mid-drag preview
(window record AND exact src-over pixels: 0x50 white over teal =
(80,168,168), the 0063 integer math).

## Gotchas hit

- **A click is not a drag** — the round's real bug, caught by re-running
  os-wm/os-scale after the "green" run: a title mousedown+up with no
  motion is still a kernel drag-start/drag-end, so the first version
  emitted EV_SNAP_DROP {edge 0} for it — and a double-click's FIRST
  click restored the maximized window (drag-off), letting the second
  click re-maximize with a clobbered saved rect. Symptom: dblclick-
  restore left the window maximized forever. Fix in the mechanism:
  nothing snap-related arms until the pointer travels WM_SNAP_SLOP
  (4px) from the mousedown — no zone events, no drop event, jitter
  included. Corollary for tests: EV_SNAP_DROP fires at every drag end
  *that actually moved* (edge 0 included — that IS the drag-off
  signal); a scripted-WM title drag with motion must consume the extra
  frame, a motionless one gets none.
- **The unswallowed Meta keydown**: the chord swallows GUI+arrow, not
  the GUI key itself (the kernel never eats plain modifiers — the app
  may bind them). winbox toggles its fill on ANY keydown, so each
  browser-test chord flips orange↔green once. os-snap.mjs tracks the
  toggle parity instead of fighting it.
- Preview create steals focus like all furniture — the peek-style
  hand-back keeps the dragged window focused (asserted in the e2e:
  the winbox row keeps `f` mid-drag).

## Recorded simplifications (not bugs)

- Drag-off restores the floating size **at release**, not mid-drag
  (Win7 restores under the cursor while dragging). Mid-drag restore
  would mean a RESIZE renegotiation inside a live kernel drag.
- A border-resize of a snapped window keeps `snapped` set (the
  EV_CONFIGURED echo of a user resize is indistinguishable from our own
  snap configure). Consequence: the next EV_SCREEN re-fits it to the
  half. Minor, revisit only if it annoys.
- Corner zones are 8×8px targets (both axes within margin). Win7 had
  no drag-quarters at all; this is already a superset.

## Tests

- `tests/kernel/test_snap_e2e.js` (NEW, 22 checks, registered in
  run.js): the full ladder over real /bin/wm + wmctl via boot.js.
- test_wm.js / test_wm_policy.js mechanism legs: zone enter/leave/
  corner, drop payload incl. preX/preY, chord edges + RGUI + pass-
  through, SNAP command, INJECT_SCREEN round-trip.
- `tests/browser/os-snap.mjs` (NEW, in the sweep): real-mouse drags
  with the preview pixel-asserted mid-drag, Meta+arrow chords, VT1
  wmctl geometry cross-checks.

Design record: WM.md "Implementation status — Aero Snap". Protocol
docs: kernel.js WMP block + os/wm_proto.h (MUST MATCH, both updated).
