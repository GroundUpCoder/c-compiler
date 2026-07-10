# 0077 — desktop icon selection & manipulation

- **Status**: DONE 2026-07-11 — landed wm.c-only (zero kernel/protocol
  change), image v49. Selection bitmask (click/ctrl/shift-range/marquee,
  navy label strips), drag-move with all-or-nothing cell snapping +
  `/root/Desktop/.icons` persistence (absent entries auto-flow — a
  virgin Desktop keeps the 0029 layout), keyboard (arrows/Enter/Esc/
  Ctrl+A; **decided: Enter on a multi-selection is a no-op** — the
  multi-launch guard). Desktop left-click now takes kernel focus via
  WMP_FOCUS (wm policy; the kernel borderless exemption stands);
  modifiers tracked by keysym from key events (pointer records carry no
  mod word) — the held-before-first-focus nuance is recorded in WM.md
  "Known issues". wmctl grew keydown/keyup/down/up/drag. Tests:
  test_wm_service_e2e.js 0077 tail + os-shell.mjs legs. Residue owners:
  rename-in-place → 0103 (already queued after this), right-click menus
  → 0091/0101 (non-goals here by design). Dev log
  `logs/2026-07-11/0077-desktop-icon-selection.md`.
- **Design**: `todos/WM.md` "The desktop shell" (desktop-icons block,
  todos/done/0029). Extends the icon grid in `os/wm.c` (grid draw ~L484,
  double-click hit-test ~L521–526).

## Goal

Turn the desktop layer from launch-only into a selectable surface: the
Win95/Win7 affordance of selecting one or many icons and acting on the
set. Today `/root/Desktop` renders as a grid whose only interaction is
double-click-to-launch (0029) — single click, marquee, and drag all do
nothing.

## Plan

Client-side state in the desktop wm surface — no protocol addition (the
layer already receives ordinary clicks; drag/mouseup already arrive since
0067's file drop). Build in behavior order:

1. **Single-select** — left-click an icon selects it (selection set =
   {idx}); click empty desktop clears. Draw a selection highlight
   (inverted label + tinted cell), matching the flat-rect icon style.
2. **Additive select** — Ctrl+click toggles one; Shift+click ranges from
   the anchor; Ctrl+A selects all. Track anchor + selection set.
3. **Marquee / rubber-band** — press-drag on empty desktop draws a
   selection rectangle; on release, icons intersecting it become the set.
   (Distinct from the window-resize rubber-band in WM.md — this is
   desktop-layer-local, never emits EV_SCALE_REQ.)
4. **Drag-move** — press-drag *on a selected icon* moves the whole set;
   snap to grid on release. Needs persisted positions (below).
5. **Keyboard** — arrows move selection, Enter launches the selection,
   Esc clears.

**Icon positions.** Free-placement + drag-move implies persistence.
Simplest: a dotfile in /root/Desktop (`.icons` — name→cell) the layer
reads alongside the readdir and rewrites on move; absent entries fall
back to auto-arrange (current grid order). Keep the ~1s readdir watch;
reconcile new/removed files against saved positions.

**Multi-launch guard.** Double-click still launches a single icon;
Enter-on-a-multi-selection either launches each (bounded) or is a no-op —
decide and document, don't silently spawn N windows.

## Non-goals (record, don't build here)

- Right-click context menu (New ▸ / Sort by / Refresh) — a 0076 spinoff.
- Rename-in-place, delete/trash — those want fileman's file ops (0073
  notes fileman is launcher-only); scope separately.

## Acceptance

- Headless (`test_wm_service_e2e.js` / os-shell legs): injected clicks
  build the expected selection set (highlight histogram over cells);
  marquee drag selects the intersected icons; a drag-move relocates a
  selected icon and its position survives the next readdir tick.
- Browser (`os-shell.mjs`): click selects (visible highlight), Ctrl+click
  extends, marquee box selects, drag repositions; double-click still
  launches exactly one app; minimize still reveals the desktop.
- Existing desktop/icon pixel tests stay green (selection highlight must
  not trip os-quake's 5% / os-doom's 2% icon-band allowances — see
  todos/0064's standing checklist).
