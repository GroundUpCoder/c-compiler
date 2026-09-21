# 0095 — Aero Snap — drag-to-edge tiling + Win+arrow

- **Status**: done 2026-07-11 (image v56; log
  `logs/2026-07-11/0095-aero-snap.md`; design record WM.md
  "Implementation status — Aero Snap"). Landed on the 0025/0032
  mechanism/policy split. Kernel: pointer-vs-edge-zone tracking inside
  the title drag (WM_SNAP_MARGIN 8px; subscriber-gated; nothing arms
  until the pointer travels WM_SNAP_SLOP 4px — a click is not a drag,
  or the dblclick's first click would drag-off-restore) → WMP
  EV_SNAP_EDGE {sid, edge} on zone change + EV_SNAP_DROP {sid, edge,
  preX, preY} at the release of every drag that moved (preX/preY = the
  pre-drag rect for the floating save); Win+arrow as a wmKey chord (EV_CYCLE rules) →
  EV_SNAP_KEY, with SNAP/`wmctl snap` the same event; INJECT_SCREEN /
  `wmctl sdown|smove|sup|sdrag` (screen-coord chrome-path injection —
  the headless title-drag driver that didn't exist). wm.c: per-window
  snap edge + ONE saved floating rect shared with maximize (top snap IS
  0025's maximized state), halves/quarters off the work area (bottom
  quarters drop one TITLE_H), fixed-size letterbox via fit_dst, the
  translucent "snappreview" furniture window (0063 alpha, peek-style
  focus hand-back), drag-off restore, wrap-across Left/Right,
  restore-or-minimize Down, EV_SCREEN re-fit. Tests:
  `tests/kernel/test_snap_e2e.js` (new, registered) + mechanism legs in
  test_wm.js/test_wm_policy.js + `tests/browser/os-snap.mjs` (the
  browser acceptance lives there, not os-shell.mjs — the post-0081
  sweep shape). Residue owned: **0064** grew the operator snap FEEL
  check (zone size, preview latency, at-release drag-off). Recorded
  simplifications (WM.md + dev log, deliberately un-queued): drag-off
  restores at RELEASE not mid-drag; a border-resize of a snapped window
  keeps the snap state; corner zones are 8x8px.
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
