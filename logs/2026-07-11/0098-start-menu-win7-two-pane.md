# 0098 — Start menu: Win7 two-pane stage

**Landed 2026-07-11.** Restyled the Start menu's ROOT from the Win95
cascading-column shell (0078) into the Win7 two-pane panel, plus two small
persistence bits. The 0078 flyout substrate is untouched — this is a new
root layout + recents/search, exactly as the item scoped it.

## What changed (os/wm.c only, no kernel/protocol change)

- **The root ("startmenu") is now a fixed 290×234 two-pane panel.** Left
  pane (170px): pinned entries (`~/.config/pinned`) + **MRU recents**
  (`~/.config/recent`) + an **All Programs** row, with a **search box** at
  its foot. Right pane (120px): the fixed places SETTINGS / RUN… (a
  distinct 176-gray band split from the left by a divider). Height is fixed
  (10 left rows + the search box) so geometry never shifts with the recents
  count — that determinism is load-bearing for the headless test.
- **Recents** are pushed to the head of `~/.config/recent` by the shared
  `activate()` on every real program launch (menu, desktop, or run dialog
  — the one launch choke), de-duplicated, capped at 8. So "recent
  programs" spans the whole shell, not just the menu.
- **Live search**: typing (the root holds kernel focus) filters a flat
  recursive walk of the menu tree into the left pane, highlighting and
  preselecting the top hit; Enter launches it. Reuses the 0078 type-ahead
  matcher, generalized to a case-insensitive substring over the walk.
- **All Programs** cascades the menu tree via the existing
  `menu_open_flyout` machinery — startmenu2 lists the GROUPS, startmenu3 a
  group's leaves (one level deeper than the 0078 root-lists-groups
  layout). `sm_open_allprogs` anchors the flyout to the All Programs row,
  reusing the parent-right − 3 / row-aligned / work-area-clamp rule.
- **Keyboard**: printable → search; arrows walk the left pane; Enter
  launches the cursor row (top hit in search mode); Right cascades All
  Programs; **Esc clears a non-empty search, THEN closes**. Once a flyout
  is open its deepest column owns the keys (the 0078 path, unchanged) —
  `menu_key` routes depth 0 to `sm_root_key`, everything else stays.
- **Gone**: the Win95 sidebar band (`draw_vtext_s` deleted with it) and the
  below-programs separator + fixed section. `col_rows/menu_row_y/
  menu_row_hit` keep their now-dead depth==0 arithmetic (harmless; the root
  hit-tests via `sm_root_hit`) rather than churn the flyout math.

`mcol[0]` still owns the root WINDOW (sid/geometry/parking/dismiss through
the shared plumbing); only its CONTENTS moved to the `sm_*` globals, so the
EV_CREATED park, `menu_owns_sid`, EV_FOCUS dismiss, and Ctrl+Esc chord all
work verbatim.

## Gotchas found while landing

- **Recents only record launches THROUGH the wm** (`activate()`); a shell
  `winbox &` does not. Tests that want a recent must launch via the menu or
  desktop.
- **Esc from within a flyout still closes the WHOLE menu** (the 0078
  rule) — only Esc from the root-with-a-search clears-then-closes. A
  headless test navigating a flyout must back out with **Left**, not Esc.
- **The search highlight paints the row navy with WHITE text** — sample the
  navy background PAST the label (x≈100), not over the glyphs (x=20 landed
  on white text and failed the first browser run).
- **Browser `winCount` helper reads `window.__osOut` via `page.evaluate`**,
  not directly in Node (the first run threw "window is not defined"); it
  also splits the echo marker (`WBQ""$(…)`) so the typed command line can't
  match its own `WBQ\d` output.

## Tests

- `tests/kernel/test_wm_service_e2e.js` — rewrote the Start menu legs for
  the two-pane geometry: All Programs → tree flyout → nested leaf launch
  (records a recent, asserted), the 290×234 shot's pane/search/arrow/ghost
  pixels, live-search + Enter launch, Esc clear-then-close, the right-pane
  RUN… place, and the keyboard All Programs cascade over an /etc/menu
  override. PASS.
- `tests/browser/os-shell.mjs` — rewrote the Start menu section: two-pane
  render (right band + search box), All Programs cascade + nested launch,
  MRU recents relaunch, live search highlight + Enter launch, right-pane
  RUN…, /etc/menu override searched, plus the unchanged toggle/Esc/Ctrl+Esc
  dismiss legs. PASS.

Image bumped **v59 → v60** (seeded source `wm.c` changed).

## Non-goals (recorded, not built)

Jump lists, tiles, live-filesystem search (only the menu tree), Aero glass
on the menu — the same exclusions 0078 recorded. No follow-ups filed.
