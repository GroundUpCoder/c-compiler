# 0101 — taskbar polish: bar context menu, Show Desktop, clock date

- **Status**: open
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
