# 0430 — desktop icon grid (0077) as a drag SOURCE and drop TARGET for the kernel drag session

- **Status**: open
- **Design**: reuse 0077's existing slop/ghost/persist code; add 0428's transport underneath it.

## Goal

Make the `/bin/wm` desktop icon grid a first-class participant in 0428's drag session, in **both**
directions:

- **as a SOURCE** — drag an icon off the desktop into an open window (e.g. into fileman);
- **as a TARGET** — drag a file out of a window and drop it onto the desktop.

🔴 **HARD-BLOCKED ON `todos/0429`** (which is itself blocked on `0428`). The desktop is one endpoint
of a session whose other endpoint is a win32 window, so the win32 landing must exist first.

## 🔴 P2 HERE MEANS *SEQUENCE*, NOT *OPTIONAL*

This ticket sits at P2 **only** because it is third in a forced serial chain. **It is part of jku's
stated ask** — he named *"from one gucOS window **(or the desktop icon grid)**"* explicitly. Under
the standing build-to-the-goal rule, **do not drop this as "not needed yet" once 0428/0429 make the
fileman-to-fileman case work.** The feature is not delivered until the desktop participates.

## Context you need

`todos/0077` already built the desktop layer in `os/win32/wm.c`, and it already does
**press → slop → marquee → icon drag → snapped drop → persisted layout**. `compositor.js` already
draws drag ghosts, cell outlines and a separate overlay layer for the snap preview.

🔴 **But 0077 is INTRA-PROCESS**: wm draws and owns the desktop layer itself, so its drag never
crosses a surface boundary. It is a **UI precedent, not a transport.** Your job is to keep 0077's
existing feel — the same slop threshold, the same ghost, the same grid snapping, the same layout
persistence — while routing the cross-surface cases through 0428's session.

## Plan

1. **`os/win32/wm.c` as a SOURCE** — when a desktop-icon drag leaves the desktop layer and enters a
   surface, hand the session over to `WMP_REQ_DRAG_START` with the icon's file list (same 0090
   format-2 payload). Below that threshold it stays the existing intra-process 0077 drag.
2. **`os/win32/wm.c` as a TARGET** — take the accepts-drops bit, handle `EV_DROP` at a desktop point,
   run the same `SHFileMove` / `SHFileCopy` decision as fileman, and **persist the dropped icon's
   grid cell through 0077's existing layout persistence**.
3. **The hand-off boundary is the design risk.** A drag that starts on the desktop and ends on the
   desktop must remain a pure 0077 drag with no session churn; a drag that crosses out and comes
   back must not leave a stranded session or a duplicated ghost. Pin the behaviour in tests.
4. Extend `tests/browser/os-dnd.mjs` (from 0429) with the desktop legs, both directions, plus the
   out-and-back case in (3).

## Acceptance

- Dragging a desktop icon into an open fileman window moves/copies the file and refreshes the view.
- Dragging a file from a fileman window onto the desktop lands it, snaps it to the grid, and the
  position **survives a restart** (0077's persistence).
- A desktop-to-desktop drag still behaves exactly as 0077 shipped it — same slop, same ghost, same
  snap — with no drag session created.
- The out-and-back case leaves no stranded session and no duplicate ghost.
- Full kernel suite green, full browser sweep green, **artifact tallied** (`recorded == total` is
  not enough — tally `results[].status`; if `carried > 0` / `runs > 1` / a `filter` is set, report
  the **first full run's** numbers). `node tests/todos/run.js` 5/5.
- ⚠️ A full browser sweep rewrites 3 tracked `logs/` PNGs and drops 1 untracked one. **Restore them.**
