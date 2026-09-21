# 0101 — taskbar polish: bar context menu, Show Desktop, clock date

- **Status**: DONE (2026-07-11). All three parts landed in `os/wm.c`
  (image v60→v61): (1) right-clicking the strip (empty run / clock /
  Show-Desktop region — anything past the Start strip that isn't a drawn
  button) opens a taskbar-strip menu — Cascade, Tile, Minimize All,
  Properties (→ ctlpanel) — over the 0091 popup furniture
  (`ctx_open_taskbar`); Cascade/Tile are wm.c policy loops (resizable →
  MOVE+RESIZE uniform-box / near-square grid, fixed-size → cascaded
  positions, never sheared). (2) A narrow Show Desktop sliver at the far
  right (`SHOWDESK_W`; the clock budgets against `clock_left()`) toggles
  minimize-all/restore, stashing the sids it minimized (`sd_stash`) so a
  second click restores exactly that set. (3) Hovering (or clicking, for
  agent parity) the clock raises a "datepop" date tooltip (the Aero-Peek
  borderless mechanism — hover idle-dismisses, click pins). Right-button
  routing added at `bar_rclick`; left-click byte-identical. Verified:
  `node tests/kernel/run.js` 53/0 over a fresh v61 bake, with new 0101
  legs in `test_wm_service_e2e.js` (strip-menu open, Minimize All, Show
  Desktop toggle, Cascade uniform box, datepop) and `test_ctxmenu_e2e.js`
  updated (empty-bar right-click now opens the strip menu; the Start strip
  is the reserved slot). Browser leg added to `tests/browser/os-shell.mjs`
  (manual tier — not run this session, no playwright here). Non-goals
  (Quick Launch strip, notification tray, button grouping, moving the bar)
  recorded, not built. No follow-ups filed.
- **Design**: `todos/WM.md` "The desktop shell" (taskbar block, todos/done/
  0031). Filed by the 0076 parity sweep. Sequenced after 0091 because the
  right-click popup look/dismiss rules should match the context-menu
  primitive 0091 establishes (wm.c side, the Start-menu borderless-window
  pattern — NOT user32 TrackPopupMenu; wm.c is a WMP client).

## Goal

The taskbar's empty strip and clock are draw-only today: `bar_click`
treats every mouse button identically, nothing between the window
buttons and the clock is hit-tested, and the clock cell ignores clicks
(0076 survey). Win95 puts a menu on the empty bar (Cascade / Tile /
Minimize All Windows / Properties), a date tooltip on the clock, and —
since the Quick Launch era — a one-click Show Desktop. 0091 owns the
taskbar *button* right-click (Restore/Min/Max/Close); this item owns the
rest of the bar.

## Plan

- **Right-click empty bar** → popup: Cascade, Tile (pick horizontal-only
  or both, record), Minimize All Windows, Properties (→ ctlpanel, the
  0089 hub). Cascade/Tile are pure wm.c policy loops over its window
  list (MOVE/RESIZE per window — resizable ones only for Tile; fixed-
  size windows get cascaded positions, never sheared, the 0021 rule).
- **Show Desktop** — a narrow always-visible strip at the far right edge
  of the bar (the Win7 affordance; cheaper than a Quick Launch icon
  area). Click = minimize-all with a stash of what was visible; second
  click restores the stash (windows minimized before the toggle stay
  minimized). Also reachable as the Minimize All menu row.
- **Clock date** — hovering the clock shows the full date (weekday,
  YYYY-MM-DD) — an Aero-Peek-style popup (0063 mechanism) rather than a
  native tooltip; click can toggle it for touch/agent parity. No
  calendar widget.
- Right-click needs `e.button.button` routing in wm.c's event loop —
  today every MOUSE_BUTTON_DOWN is treated as button 1; keep left-click
  behavior byte-identical.

## Non-goals (record, don't build)

- Quick Launch icon strip (post-95 shell; desktop icons + Start menu
  cover launching).
- Notification tray / balloon tips (no producer apps yet).
- Taskbar button grouping (overflow shrink suffices at current scale).
- Locking/moving the bar to other edges.

## Acceptance

- Headless (`test_wm_service_e2e.js`): injected right-click on the empty
  bar opens the menu; Minimize All minimizes every normal window;
  Show Desktop strip toggles minimize-all/restore; Cascade re-places
  windows deterministically.
- Browser (`os-shell.mjs`): the menu renders and dismisses on
  outside-click/Esc; clock hover shows the date; Show Desktop reveals
  the icon grid and restores.
