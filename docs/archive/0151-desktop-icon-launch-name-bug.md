# 0151 — Desktop icon fails to launch for long/spaced filenames (menu_ent.name[32] truncation)

- **Status**: DONE (2026-07-12). Root cause was exactly the `menu_ent.name[32]`
  truncation: grew both `menu_ent.name` and `sm_item.name` to `ENT_NAME` (256 —
  a full BlockFS d_name of 255 chars + NUL), so a long/spaced Desktop or Start-
  menu filename is never truncated on the launch path. Audited every fixed-size
  name/path buffer on that path (`desk_launch` path[300], `.icons` line[320],
  the rename oldn/newp buffers, the flyout path[600]) — all comfortably fit a
  255-char name, no other change needed. Confirmed there is NO spaces-only
  failure beyond length (a SHORT spaced name launches even pre-fix), so
  truncation was the whole bug (Plan step 3 moot). Kernel e2e leg added to
  `test_wm_service_e2e.js` (a 36-char spaced launcher dblclick — proven
  regression witness: fails `LN-LONG-DELTA-0` without the fix, passes with);
  browser leg added to `os-shell.mjs` (operator-owed run under the standing
  0064 browser-sweep debt — Playwright not installed here). Image v72.
- **Design**: WM.md (desktop grid, todos/0028–0033, 0066 activate())

## Goal

Reported bug: double-clicking a desktop icon whose filename contains spaces
"won't seem to launch." Fix desktop-icon launch so every valid `/root/Desktop`
entry launches, regardless of name length or spaces. **P0 — correctness bug in
a shipped feature** (per CLAUDE.md priority policy).

## Findings so far (verification)

The core launch mechanism handles spaces CORRECTLY end-to-end — verified
headless against the real kernel:

- `activate()` (os/wm.c:1051) passes the full path as a single `argv[0]`
  basename + spawn; `spawn_path` → `posix_spawn(path, …)` never word-splits.
- Shebang re-dispatch (kernel.js `_spawnShebang`) pushes the script path as ONE
  argv element.
- `ow_build` (os/openwith.h:175) splits only the COMMAND words and appends the
  file path as one trailing arg.
- win32 `GetCommandLineW` builder (os/win32/kernel32.c:1122, todos/0111) quotes
  every later arg; `cmdline_split` round-trips it losslessly; notepad's
  `HandleCommandLine` strips the quotes and opens the spaced path.

Empirical repro: a `#!/bin/sh` launcher named `"My Cool App"` on the Desktop
spawns fine via the real kernel (`node os/boot.js`).

**Confirmed real defect (root cause of the "won't launch" symptom):**
`menu_ent.name` is a fixed `char name[32]` (os/wm.c:286). `load_entries`
(os/wm.c:1086) truncates any Desktop filename ≥ 32 chars via
`snprintf(e->name, sizeof e->name, …)`. `desk_launch` (os/wm.c:1856) then builds
`"/root/Desktop/<truncated>"`, and `activate`'s `stat()` fails → **silent
no-launch, no error**. Long names disproportionately contain spaces, which is
almost certainly what was observed ("My Really Long Application Name Here" = 36
chars → truncated → dead icon).

## Plan

1. Reproduce in the browser (os-shell.mjs leg): create a Desktop file with a
   ≥32-char name (with spaces) and one short spaced name; `wmctl dblclick` each;
   assert both spawn (the short one already should, the long one should after
   the fix). This pins whether there is ANY spaces-only failure beyond the
   length truncation — if the short spaced name already launches, truncation is
   the whole bug.
2. Fix the name-length limit: grow `menu_ent.name` (and the mirrored `sm_item`,
   os/wm.c:310) to at least `NAME_MAX`-ish (256), or store names heap-side.
   Audit every fixed-size name/path buffer on the desktop/menu launch path
   (`desk[]`, `.icons` load/save, `desk_launch`'s `char path[300]`) so nothing
   silently truncates. Keep `load_entries` shared with the Start menu correct.
3. If step 1 surfaces a genuine spaces-only failure (not length), trace and fix
   that too.

## Acceptance

- Browser leg: a Desktop icon with a long name AND a spaced name both launch on
  double-click (`wmctl dblclick`), asserted by the child process appearing /
  window opening.
- `node tests/browser/os-sweep.mjs --filter os-shell` green; kernel suite green.
- No fixed-size truncation left on the desktop-icon launch path.
