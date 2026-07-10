# 0078 — Start menu shell v2 (Win95 restyle)

The 0028 Start menu was a flat single-column picker over `/etc/menu`.
This lands the Win95-classic shell structure on top of it: cascading
program groups, a fixed section with a working Run… dialog, the sidebar
band, full keyboard navigation, and a real Start chord. The Win7
two-pane stage the item listed as optional was descoped to **todos/0098**
(this item's substrate — tree loader, columns, type-ahead, chord — is
exactly what 0098 needs); the Shut Down fixed row was descoped to
**todos/0051**, which owns halt/reboot (a dead menu row helps nobody).

## Shape of the change

- **os/wm.c** — the menu is now an array of `menu_col` columns
  (`MENU_DEPTH` 4), each its own borderless window ("startmenu",
  "startmenu2", …) parked by its EV_CREATED echo. Subdirectories of the
  menu dir (and symlinks to directories) are groups; `load_entries`
  grew `is_dir` and a dirs-first sort. The flat 0028 list is the
  degenerate case — `/etc/menu` overrides keep working unchanged.
- **Fixed section** below a separator groove on the root column:
  SETTINGS → `activate("/bin/ctlpanel")` (the baked top-level ctlpanel
  menu link is gone — the fixed row replaces it), RUN… → a "startrun"
  dialog window whose Enter spawns `/bin/sh -c <input>` — full shell
  semantics (PATH, args, pipes) for one spawn_path call.
- **Kernel/protocol** — Ctrl+Esc is intercepted at the `wmKey` seam
  under the exact EV_CYCLE rules (subscriber-gated, keyup swallowed,
  pass-through with no WM): WMP **EV_MENU 0x8C**, command **MENU 0x1C**,
  `wmctl menu`. MUST-MATCH updated in kernel.js, wm_proto.h,
  test_wm_policy.js; the chord is documented in the VT2 tab tooltip.
- **os/image.json v48** — the baked menu became a tree:
  `Games/` (doom quake gameboy sameboy snake winmine),
  `Accessories/` (term calc notepad fileman),
  `Demos/` (winbox gpubox cairodemo gdidemo ctldemo).

## Decisions worth keeping

- **Only the root column ever holds kernel focus.** A flyout's
  create-focus is handed straight back at its EV_CREATED echo (the Aero
  Peek precedent). This is load-bearing, not cosmetic: flyouts are
  destroyed on every hover re-target, and destroying a focused surface
  makes the kernel's focus fall land on an app window — which the
  EV_FOCUS dismiss rule would read as "user clicked elsewhere" and tear
  the whole menu down. With flyouts never focused, re-targeting is
  focus-silent. Keys still work because the root has focus and wm.c
  routes keys by menu-open state, not windowID.
- **Hover policy is timer-free**: hovering a group opens/re-targets its
  flyout; hovering a non-group row leaves the flyout alone. Win95 uses
  open/close delays; the forgiving-diagonal variant gets the same feel
  with zero timer state and stays deterministic for tests.
- **Run… gates its focus-dismiss on the echo**: between `run_open()` and
  the EV_CREATED echo, the focus fall from the menu teardown arrives
  first — dismissing on `p[0] != run_sid` while `run_sid == 0` would
  kill the dialog it just opened. The rule is `run_win && run_sid &&
  p[0] != run_sid`.
- **The chord is Ctrl+Esc** (the authentic Win95 chord). It's
  deliverable in-browser on macOS/Linux; on Windows the OS eats it —
  acceptable, the Start button and `wmctl menu` cover those, and the
  cycle-chord precedent already accepts per-OS chord loss (OS Alt+Tab).
- **Empty programs list still opens the menu** (fixed section remains
  useful) — 0028 refused to open on an empty dir; the new behavior is
  strictly more useful and no test relied on the refusal.

## Tests

- `test_wm_policy.js`: chord down/keyup-swallow/plain-Esc-pass-through +
  MENU command legs (mirrors the cycle legs).
- `test_wm_service_e2e.js`: new root geometry (168x116 — 3 groups +
  2 fixed rows), menu-shot pixel asserts (band navy, separator groove,
  group arrows, fixed-section text), hover→flyout geometry, nested
  launch, `wmctl menu` toggle + no-WM refusal, type-ahead 'g' → Games
  flyout, Esc, RUN… typed launch (240x70+6+664), keyboard-only nested
  launch over an /etc/menu tree. 78/78.
- `os-shell.mjs`: sidebar-band histogram, hover-cascade + re-target,
  nested winbox launch, Esc + Ctrl+Esc chord legs, override-menu new
  geometry (76 tall), RUN… end-to-end through the real page keyboard.

Gotcha for future menu geometry edits: THREE places move together —
image.json's menu tree, test_wm_service_e2e.js's MENU_GROUPS/DEMOS/GAMES
lists, os-shell.mjs's copies (the standing entry-lists rule, now over
trees).

**Browser-test race worth remembering**: both baked flyouts are taller
than the space under their group row, so both bottom-clamp to the bar
and share most of their footprint. A "flyout is up" waitPixel on a
SHARED pixel passes instantly during a Games→Demos re-target (the old
column still covers it), and the follow-up click races the flyout swap —
it can land on the desktop (dismissing the whole menu, the observed
sweep failure) or on the dying column. The settle pixel must be
DISCRIMINATING: the top strip only the taller flyout covers (wait for it
to go teal, then for the new column's face). Not a wm.c bug — the swap
is 1–2 frame-loop ticks, invisible to humans; only injected input is
that fast.
