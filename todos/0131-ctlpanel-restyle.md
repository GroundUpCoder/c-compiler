# 0131 — Control Panel restyle — XP/Win7-era category hub + search

- **Status**: open
- **Design**: `todos/done/0089-control-panel-v2.md` (the Win95 applet hub
  this restyles — 0089 deliberately matched "the current Win32 look";
  this item is the next aesthetic tier), `todos/WIN32.md` (the user32/
  gdi32 surface the restyle draws on), `todos/OS.md` (agent-drivable
  pillar — every applet stays label-addressable through the redesign)

## Goal

ctlpanel (`os/win32/ctlpanel.c`, ~613 lines) is a single horizontal row
of custom-drawn Win95 applet icons (Sound, Sounds, System, Display,
Date/Time, Screen Saver) — genuinely iconized (per-applet 32×32 GDI
pictograms, navy selection strip) but flat: no categories, no tree, no
search, and the Display applet is still a stub. Win95's folder is the
floor; XP's category view and Win7's breadcrumb/search hub read as nicer
and more featureful, and the user32/gdi32 substrate to build them
(controls, custom paint, layout) already exists. This item is the
cosmetic/structural tier that 0089 explicitly left as "matching the
current look."

This is a LOOSER, more subjective item than the applet work — it's about
the hub chrome, not new settings surfaces. Keep every applet
independently agent-drivable (labels unchanged) so the existing e2e
legs survive the reskin.

## Plan

Scope to taste at pickup time; candidate directions (pick, don't do all):

- **Category grouping** (the XP move): group applets under headings
  (e.g. Sound & Audio, System, Appearance & Personalization) instead of
  one flat row — a grouped grid or a left rail of categories + a content
  pane. Reuse the existing per-applet `open_applet()` launch.
- **A search/filter box** (the Win7 move): type-to-filter the applet set
  by name, like the Start-menu search (0098) precedent — flat recursive
  match, Enter opens the top hit.
- **Chrome polish**: a title/breadcrumb band, larger icons with
  descriptions, hover affordances — the 0063 Aero furniture is available
  if it fits.
- Fill the **Display applet stub** only if 0049 (wallpaper) has landed by
  then; otherwise leave it to 0049 and just restyle the shell.

## Non-goals (record, don't build)

- New applets — Default Programs is 0130; Mouse/Keyboard wait on live
  kernel state per 0089. This item is the HUB, not its contents.
- A theming engine / skinning system — match a specific era's look by
  hand, don't build a generic theme layer.
- Breaking agent addressability — applet labels and `wmctl click`
  targets must survive the restyle (the e2e legs are the guard).

## Acceptance

- The hub reads as an XP/Win7-era Control Panel, not a flat Win95 row
  (category grouping and/or a working search box — at least one lands).
- Every existing applet still opens and its 0048/0089/0113/0096 e2e legs
  still pass unchanged (`tests/kernel/test_ctlpanel_e2e.js`,
  `tests/browser/os-shell.mjs`).
- A browser leg captures the restyled hub compositing correctly (manual
  human aesthetic check noted, the 0064 sweep precedent).
