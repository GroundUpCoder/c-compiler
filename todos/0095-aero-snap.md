# 0095 — Aero Snap — drag-to-edge tiling + Win+arrow

- **Status**: open
- **Design**: `todos/WM.md` (placement policy + drag-move live in `os/wm.c`;
  the Aero visual layer landed in 0063). Extends the existing window-drag path
  with edge-snap regions and the Win+arrow chords.

## Goal

The single most recognizable Win7 interaction, and the compositing it needs
(alpha, the snap preview overlay) already shipped with Aero (0063). Since the
OS is already Win95-bones-plus-Aero, snap is the highest-leverage way to make
it *read* as Win7.

## Plan

- **Drag-to-edge** — while dragging a title bar (`os/wm.c` already owns the
  drag), detect the pointer entering a screen edge: top → maximize, left/right
  → left/right half, corners → quarter. Show a translucent snap-preview
  rectangle (0063 alpha) before drop; commit the geometry on release.
- **Restore-on-drag-off** — dragging a snapped window away restores its
  pre-snap floating size (stash the rect on snap, Win7 semantics).
- **Keyboard** — Win+Left/Right snap to halves (and cycle across the edge),
  Win+Up maximize, Win+Down restore/minimize, via a kernel chord that emits an
  event the way `EV_CYCLE` does (0032).
- **Metrics** — snap to the work area (excludes the taskbar), consistent with
  maximize (0025).

## Non-goals (record, don't build)

- Win11 snap *layouts* / zones grid — halves and quarters only.
- Multi-monitor edge behavior — single surface for now.
- Shake-to-minimize — that's a separate 0076 wishlist entry.

## Acceptance

- Headless: `wmctl`-injected drag to the left edge snaps a window to the left
  half of the work area (assert geometry); Win+Right event moves it to the
  right half; drag-off restores the prior rect.
- Browser (`os-shell.mjs`): dragging a window to the top maximizes with a
  visible snap preview; left/right edges tile to halves; Win+arrow reproduces
  it from the keyboard.
