# 0089 — Control Panel v2 — old-school Windows applet hub

- **Status**: done (2026-07-11). Landed the Win95 applet hub: the main
  window is a folder of CplIcon applet icons (single-click activation —
  a decided deviation from Win95 double-click so one `wmctl click
  "Sound"` = one open; keyboard Left/Right/Home/End + Enter), each
  applet its own sibling top-level window: Sound (0048 volume controls
  verbatim), System (os-release + /proc/uptime), Display (stub naming
  todos/0049 — that item owns filling it), Date/Time (live
  SetTimer/WM_TIMER clock, built here since it was thin). Grew the
  veneer: the kernel close request is now PER-WINDOW when several
  top-levels are live (SDL_EVENT_WINDOW_CLOSE_REQUESTED 0x210 through
  compiler.js SDL + host.js handle pass + user32 pump; only/last window
  keeps process-wide SDL_EVENT_QUIT — single-window apps unchanged), so
  closing an applet leaves the hub alive; closing the hub quits the
  panel. Mouse/Keyboard applets deliberately not built (recorded below
  as opportunistic): no live kernel state exists for them to control —
  the item that introduces such state owns creating its applet. Image
  v49 → v50; zero kernel.js change. Tests:
  `tests/kernel/test_ctlpanel_e2e.js` extended per the acceptance
  (per-window close, keyboard nav, WM_TIMER tick, cross-process gain
  legs added), `tests/browser/os-shell.mjs` grew the 0089 leg. Dev log
  `logs/2026-07-11/0089-control-panel-v2.md`.
- **Design**: `todos/WIN32.md` (the Win32 desktop platform); `todos/OS.md`
  (agent-drivable pillar). Grows `os/win32/ctlpanel.c` from the 0048
  single-window stub into a Win95-style applet hub. Display applet folds in
  the 0049 wallpaper picker; Sound/System applets reuse the code already in
  ctlpanel.c (0048).

## Goal

Today's Control Panel (0048, `/bin/ctlpanel`) is a single fixed window: a
master-volume scrollbar + step/set buttons (the 0017 mixer via `__audio_gain`)
and a system-info readout (`/usr/share/os-release` + `/proc/uptime`). It reads
as one dialog, not a *control panel*. This item restyles it as the classic
Windows Control Panel: a folder of applet icons, each opening a focused applet
window — so settings have somewhere to live and grow, and each applet stays
independently agent-drivable/testable (OS.md pillar).

## Plan

Ship the hub + reuse what exists first; add applets incrementally.

**The hub (core):**
- **Applet grid** — ctlpanel's main window becomes a grid of labelled icons
  (the Win95 Control Panel folder), each `activate()`-launching an applet.
  Keyboard + click selection; agent-drivable via the existing `wmctl` click
  path.
- **Applet model** — each applet is its own small window (the Win95 `.cpl`
  model), launched as a child/sibling window rather than swapped in-place, so
  applets are isolated and testable on their own. Reuse ctlpanel's existing
  window/message plumbing.

**Applets (seed set — reuse before building new):**
- **Sound** — the existing master-volume scrollbar/step/set + label readback,
  lifted verbatim out of 0048's window into its own applet.
- **System** — the existing os-release + uptime readout, as its own applet;
  room to grow (memory, build id).
- **Display** — the wallpaper picker. This is **0049's** work; the Display
  applet is its Control Panel home. Land 0049 first or stub the applet to
  shell out to it.
- **Date/Time**, **Mouse/Keyboard** — thin additions once the hub exists
  (record here; build opportunistically).

## Non-goals (record, don't build)

- Registry-backed settings persistence / a settings database — applets act on
  live kernel state (volume) or files (wallpaper) as they already do.
- Theming beyond matching the current Win32 look (Aero glass is 0063).
- An "Add/Remove Programs" applet — the image is a sealed RO volume (0040),
  so there's nothing to install/uninstall at runtime.

## Acceptance

- Headless (os-shell legs): launching `/bin/ctlpanel` shows the applet grid;
  injected activate on the **Sound** icon opens the Sound applet, and
  `wmctl click "Vol +"` / `settext`+`Set` still drive the volume the way the
  0048 e2e does (`tests/kernel/test_ctlpanel_e2e.js` extended, not replaced);
  the **System** applet shows the os-release/uptime lines.
- Browser (`os-shell.mjs`): the Control Panel opens as an icon folder, an
  applet opens in its own window and composites correctly, and the 0048
  volume/system behaviour still works through its applet.
