# 0077 — desktop icon selection & manipulation (wm.c-only)

**Item**: `todos/done/0077-desktop-icon-selection.md` · **Image**: v48 → v49
(wm.c + wmctl.c are baked sources).

The desktop layer graduates from launch-only (0029) to a real selectable
surface: single/ctrl/shift/marquee selection, drag-move with persisted
positions, and keyboard driving. Exactly as the item predicted, this
needed **zero protocol or kernel change** — the layer already receives
ordinary client events; everything landed in `os/wm.c`, plus thin
injection wrappers in `os/wmctl.c`.

## What landed

- **Selection set** — a `uint64_t` bitmask over the entries (`MAX_DESK`
  is 64, so the mask covers it by construction) + a range/keyboard
  anchor. Highlight = the existing 0029 navy label strip, now per-set;
  unselected rendering is byte-identical to pre-0077 (the desk1 cell-0
  histogram golden passes unchanged).
- **Free placement** — icons live in explicit grid cells
  (`desk_col/desk_row`), resolved each ~1s re-read by `desk_place()`:
  saved cells from `/root/Desktop/.icons` (`col row name` lines) win
  when in-bounds and collision-free; everything else auto-flows
  column-major into free cells. **A virgin Desktop reproduces the 0029
  layout exactly**, which is what kept every existing coordinate-pinned
  test green. `desk_save()` rewrites the whole layout on each drop
  (pins the arrangement; later-added files still auto-flow). An
  out-of-bounds saved cell (transient small screen) falls back to
  auto-flow WITHOUT rewriting the file — display-only clamping.
- **Gestures** — press/drag state machine: `DRAG_SLOP` (4px) of
  button-held travel turns a press into a marquee (empty-desktop press;
  white 1px outline, selects tile-intersecting icons, ctrl adds) or an
  icon move (selected-icon press; cell-outline ghosts, snapped cell
  delta on release, all-or-nothing validation — any target out of
  bounds or on an unselected icon reverts the whole move). A plain
  press on an already-selected icon defers to mouseup and collapses
  the set to it (the Win95 rule), so a drag can still move the set.
- **Keyboard** — arrows pick the nearest icon in the pressed direction
  (least perpendicular offset, then least forward distance), Enter
  launches an unambiguous SINGLE selection, Esc clears, Ctrl+A selects
  all. **Decision (the item asked for one): Enter on a multi-selection
  is a deliberate no-op** — never silently spawn N windows.
- **wmctl growth** — `keydown`/`keyup` (one key edge: hold a modifier
  across a separately-injected click), `down`/`up` (one pointer edge),
  `drag X1 Y1 X2 Y2 [BTN]` (down, two button-held motions, up, on one
  connection). All pure wrappers over the existing INJECT_KEY /
  INJECT_POINTER ops — no kernel change.

## The two load-bearing decisions

1. **A desktop left-click sends WMP_FOCUS on the desktop sid.** The
   kernel's click-to-focus deliberately exempts borderless surfaces
   (taskbar-class must act on the focus state they see), and that
   exemption STANDS — the wm *policy* asks for focus explicitly on its
   own desktop layer. Without this, no key event (modifier or arrow)
   would ever reach the grid. Windows semantics agree: clicking the
   desktop focuses the desktop.
2. **Modifiers are tracked from key events BY KEYSYM** (LCTRL/RCTRL/
   LSHIFT/RSHIFT down/up edges), because pointer records carry no mod
   word anywhere in the ring. Reset when the desktop loses focus (the
   matching keyup may land elsewhere). Known residue, documented in
   WM.md "Known issues": a modifier held *before* the desktop first
   takes focus is invisible to that first click — self-healing,
   vanishingly rare; the fix (mod word in the pointer record — a ring
   word is free) is noted there and only worth scheduling if it bites.

## Gotchas for future rounds

- **The tile's white ring is 6px** — the center block is navy. A
  "tile present" pixel probe must sample the ring (`ix+2, iy+2`), not
  the tile center; the first e2e run failed exactly there.
- The kernel hit-tests per event (no pointer capture), so a drag whose
  mouseup lands on another surface never delivers that up to the
  desktop; `desk_motion` treats a cleared button bit as the release
  (browser motion carries `e.buttons`, injected motion passes the
  mask). `make_desk()` also resets press state on EV_SCREEN recreates.
- `desk_load()` skips reloads while a press is live (never reshuffle
  under a drag), and clears the selection whenever the entry set OR
  layout actually changes — but our own post-drop `.icons` rewrite
  resolves to the cells already shown, so the memcmp early-return keeps
  the selection across the next re-read tick (the e2e asserts this).
- Injected double-clicks: successive `wmctl click`s on the SAME icon
  can pair within the 500ms window (spawn latency usually saves you,
  but don't rely on it) — a held modifier suppresses the pair in
  wm.c, and distinct icons never pair. The new drag legs were arranged
  so no same-icon click precedes a drag within the window.
- Right-button routing is deliberately untouched (`e.button.button != 1`
  now short-circuits before selection) — 0101 owns right-click.

## Tests

- `tests/kernel/test_wm_service_e2e.js` grew a 0077 tail: plain /
  ctrl / shift-range selection (label-strip pixel asserts from surface
  shots), marquee-replaces, drag-move term (0,8)→(2,1) with `.icons`
  content + survival across the re-read tick, Ctrl+A, the Enter
  multi-launch-guard no-op (window-count delta 0), Esc, and
  arrow+Enter launching exactly one app (delta 1). All 100 checks pass.
- `tests/browser/os-shell.mjs` grew the interactive twins: real
  Ctrl+click via the DOM modifier path, marquee via mouse
  down/move/up, drag-reposition of quake (0,5)→(2,5), Esc clear —
  plus the pre-existing single-click/dblclick legs unchanged.
- Follow-ups already owned elsewhere: rename-in-place → 0103 (queued
  "after 0077"), right-click context menus → 0091/0101.
