# 0072 — file associations + pickable default open app

- **Status**: DONE (2026-07-10). ONE resolver, `os/openwith.h` (header-only
  — image.json `c` entries are single-source, so sharing is by textual
  inclusion), routed through wm.c `activate()`, fileman `open_selected()`
  AND the new `/bin/open` CLI (the terminal context; execve is a stub, so
  spawn+wait). Store: first existing of `~/.config/openwith`,
  `/etc/openwith`, `/usr/share/openwith` (the /etc/menu first-existing-wins
  precedent; `ow_set` rewrites the effective table forward, tmp+rename).
  Baked seed (image v43→v44): gb/gbc → /bin/gameboy, default.gui →
  /bin/notepad, default.term → vi. Pickable: fileman's "With" button opens
  the OpenWith picker (command EDIT prefilled, "Always for .ext" /
  "Always (GUI default)" checkbox → ow_set), and `open --set KEY CMD` is
  the CLI editor. activate() dispatch is now stat()-based: runnable after
  symlink resolution spawns, everything else (incl. links to
  non-runnables, previously a silent spawn-fail) opens via association.
  Tests: new `tests/kernel/test_openwith_e2e.js` (15 checks: CLI legs via
  a probe script; .gb legs via a synthesized minimal Peanut-GB cartridge
  so the window stays up; picker drive; cross-boot persistence);
  fileman/wm_service e2e re-baselined term-vi → notepad. Deliberately NOT
  done (no follow-up owed): seeded Desktop ROM launcher scripts stay
  scripts (converting to ROM symlinks churns three tests' entry lists and
  user sections only seed virgin volumes); a full GUI association-list
  editor (ctlpanel) — the picker + `open --set` cover the v1 "pickable"
  goal. Dev log `logs/2026-07-10/0072-openwith-associations.md`.
- **Design**: `todos/OS.md` / `todos/WM.md` (the activate() launcher,
  todos/done/0066). Deferred from 0048 ("an `/etc/openwith` map is a
  later idea, not v1", `todos/0048-desktop-apps-wave1.md`).

## Goal

Open files with the **right** program instead of always `vi`. Concretely:
- GUI double-click default → **notepad**; terminal-context default →
  **vi**.
- The default is **pickable** (user-configurable), not hardcoded.
- Extension associations, e.g. double-clicking a `*.gb` / `*.gbc` file
  launches `/bin/gameboy <file>`.

## Current state (found)

The default open is hardcoded to `term vi <file>` in **two** places that
duplicate the same policy:
- `os/wm.c` `activate()` — the shared launcher (desktop double-click +
  Start menu).
- `os/win32/fileman.c` `open_selected()` — fileman's own copy.

`/usr/bin/notepad` and `/usr/bin/gameboy` already exist in the image and
take a file argument; the ROMs are currently reachable only via pre-wired
per-ROM launcher scripts (`gameboy $HOME/roms/…`), so `.gb` files
themselves aren't double-click-openable.

## Plan

- **One policy, one place.** Add an `open(path, context)` resolver
  (`ext → program`, with a GUI-vs-terminal default fallback) and route
  BOTH `activate()` and fileman's `open_selected()` through it — kill the
  duplicated `term vi` literal.
- **Association store**: a simple map file (proposed `/etc/openwith`,
  overridable per-user, e.g. `~/.config/openwith`) — `ext<TAB>program`
  lines, plus a `default.gui` / `default.term` fallback. Seed it in the
  image with `gb`/`gbc → /bin/gameboy`, `default.gui → /bin/notepad`,
  `default.term → vi`.
- **`.gb`/`.gbc`**: resolve to `/bin/gameboy <file>` from both the
  desktop and fileman.
- **Pickable**: an "Open with…" affordance in fileman (pick a program
  for this file, optionally "always") that writes the association; a
  minimal defaults editor (fileman menu, or a ctlpanel entry) to change
  `default.gui`. Keep the picker scope small in v1 — the store + the
  resolver is the substance.

## Acceptance

- Double-clicking a `.gb`/`.gbc` on the desktop and in fileman launches
  `/bin/gameboy` with that ROM.
- A plain text file opens in **notepad** from the GUI and in **vi** from
  a terminal context.
- Changing the default (via the picker/editor) persists and is honored
  by the next open — verified headlessly (`wmctl` injection + an
  associations fixture).
- Existing Start-menu / desktop launch behavior (runnables, symlinks)
  unchanged; browser pixel tests green.
