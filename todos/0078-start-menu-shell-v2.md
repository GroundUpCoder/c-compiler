# 0078 — start menu shell v2 (Win95/Win7 restyle)

- **Status**: open
- **Design**: `todos/WM.md` "The desktop shell" (Start-menu block,
  todos/done/0028); `todos/WIN32.md`. Extends the Start menu in
  `os/wm.c` (a borderless second window, live while open — state ~L118).

## Goal

The Start menu today (0028) is a flat single-column list of `/etc/menu`
(else `/usr/share/menu`) entries — functional launcher, zero shell
structure. This item gives it the affordances a real Win95/Win7 Start
menu has, so it reads as a shell and not a bare picker.

## Plan

Two eras; ship Win95-classic first (it's the smaller lift and the whole
structure), then the Win7 two-pane layout on top if wanted.

**Win95 classic (core):**
- **Program groups / All Programs flyout** — nested submenus from a
  directory tree under the menu dir (`menu/Games/`, `menu/Accessories/`),
  rendered as hover-open cascading columns. The flat list is the degenerate
  one-level case, so 0028 entries keep working.
- **Fixed section + separator** — a pinned top section above the programs
  list (Programs ▸, Documents, Settings ▸, Find, Run…, Shut Down), each an
  ordinary activate() target or a builtin (Run… → a text field that
  activate()s its input; Shut Down → the 0051 halt/reboot path when landed).
- **Sidebar band** — the vertical "Windows 95" title strip; cosmetic but
  it's what makes it *read* as Win95.

**Win7 two-pane (optional second stage):**
- Left pane = pinned list + MRU recent (a small persisted recents file,
  activate() writes it); right pane = the fixed places column.
- **Search box** at the bottom that filters the menu tree live.
- Jump lists / power submenu are explicit non-goals for v2.

**Keyboard:** open on the Start chord, arrow/Enter navigation, type-ahead,
Esc closes — the menu already grabs the top layer and dismisses on
outside-click (0028), so focus handling is in place.

## Non-goals (record, don't build)

- Theming/gradients beyond the sidebar band — the Aero glass look is 0063.
- Jump lists, tiles, live search of the filesystem (only the menu tree).

## Acceptance

- Headless (os-shell legs): opening Start shows the fixed section +
  programs; hovering a group opens its flyout; injected activate on a
  nested entry spawns the right target; Run… input launches; Esc closes.
- Browser (`os-shell.mjs`): the restyled menu renders (histogram over the
  sidebar band + a flyout column), a nested launch works, outside-click
  and Esc dismiss, and the taskbar/desktop still composite correctly.
- 0028's existing Start-menu tests stay green (flat `/etc/menu` still
  launches as the one-level case).
