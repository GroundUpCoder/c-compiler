# 0273 — term: scrollback + scrollbar + menu bar + settings window (macOS Terminal parity)

- **Status**: open — children (a) scrollback + (b) scrollbar DONE; c/d remain (user-requested 2026-07-21)
- **Design**: — (source `os/term/term.c`, ~1118 lines; VT100/ANSI emulator)
- **Difficulty**: heavy (umbrella — split into children when scoped)
- **Progress**: child **(a) scrollback history ring SHIPPED in v145** (2026-07-23,
  merge `24a97c0`, image bump `5cb90c4`, live on apex). Ring (`SCROLLBACK_MAX=2000`,
  view-offset, wheel + PageUp/PageDown + snap-to-live) independent of the ANSI
  scroll region (`scroll_up` gained a `to_hist` flag fed only by true top-of-screen
  main-grid scrolling). Child **(b) side scrollbar built** (2026-07-23, branch
  `term-scrollbar`; design log `logs/2026-07-23/term-scrollbar-0273b.md`): an 8px
  macOS-style OVERLAY bar at the right edge — pure view/controller over (a)'s
  `hist_count`/`view_off` (no second position state), hidden when no history (a
  no-history term renders byte-identical to v145) and on the alt screen,
  proportional thumb (12px floor), thumb drag + track paging, presses in the bar
  never anchor a selection, output-snap held only while the thumb is gripped.
  Reuse call: user32's SCROLLBAR/EDIT bars are HWND/GDI-coupled — term draws its
  own in its pixel idiom (rationale in the log). e2e: `test_term_e2e.js` session
  `scrollbar` (hidden/appears/thumb-drag/track-page via wmctl pointer injection).
  Remaining children: **(c) menu bar** (must ride the anchored-child uniform-menu
  facility — `notes/menu-uniform-arch-2026-07-16.md`, NOT a 2nd menu path),
  **(d) settings window + persistence**. Sequence c → d as separate lanes.

## Goal

Bring the gucOS **term** app (`os/term/term.c`) up toward **macOS Terminal**
as the general reference. The user wants, concretely:

1. **Proper scrollback.** Today `term.c` keeps only the visible `grid`
   (`rows*cols` cells) plus an ANSI *scroll region* (`scroll_top`/`scroll_bot`
   — lines 91, 158–178) for in-screen scrolling; lines that scroll off the top
   are **discarded**. Add a real scrollback history ring (N lines, e.g. a few
   thousand) so the user can scroll UP into output that has left the viewport.
   Mouse-wheel and PageUp/PageDown scroll through history; typing / new output
   snaps back to the live bottom (xterm/Terminal behaviour).
2. **A scrollbar on the side.** Render an interactive vertical scrollbar
   showing position within the scrollback and letting the user drag/click to
   scroll. (Check whether to reuse the user32 SCROLLBAR control or draw term's
   own — term is not a win32 EDIT app, so likely its own; verify the seam.)
3. **A top menu bar** with real menu items (Shell / Edit / View / Window-style,
   per macOS Terminal), including at minimum the actions the settings and
   clipboard flows need.
4. **A Settings window** reachable from the menu that lets the user modify
   term's configuration — font / font size, colours (fg/bg / palette / theme),
   number of scrollback lines, cursor style, maybe bell behaviour. Persist the
   settings (registry / config file) so they survive a relaunch.
5. **Parity with macOS Terminal "as much as possible"** — treat macOS Terminal
   as the general reference for look, menu structure, and behaviour wherever a
   choice is open. Don't cut a capability just because "nothing uses it yet";
   build the clean general version (see the repo's no-shortcut core principle).

## Notes / scope

- This is a large item; break into children at design time, e.g.
  (a) scrollback history ring + wheel/PageUp scroll-into-history + snap-to-live;
  (b) interactive side scrollbar wired to (a);
  (c) menu bar (coordinate with the uniform-menu work — anchored-child
  subsurfaces, `notes/menu-uniform-arch-2026-07-16.md` — so term's menu rides
  the same facility rather than forking a second menu path);
  (d) settings window + persistence.
- The scrollback ring should be independent of the ANSI scroll region already
  in `term.c`; don't conflate `scroll_top/scroll_bot` (in-screen VT100 region)
  with user-facing history scrollback.
- Verify current input/geometry seams in `term.c` before coding (how it draws
  the grid, handles resize/`cols`/`rows`, and where wheel/key events arrive).

## Acceptance

- Run a command that produces more output than fits; scroll up (wheel +
  PageUp) and see the earlier lines; new output / a keypress snaps back to live.
- A draggable side scrollbar reflects and controls the scrollback position.
- A menu bar is present with working items; a Settings window opens from it,
  changes (font size, colours, scrollback length, …) take effect and PERSIST
  across a relaunch.
- e2e/browser leg covering scrollback scroll + a settings change round-trip;
  no regression in existing term legs.
- Behaviour/menus read as close to macOS Terminal as the platform allows.
