# 0066 — unified run/activate mechanism

- **Status**: open
- **Depends**: 0065 (shebang exec — so launcher scripts actually run)
- **Design**: `WM.md` (desktop grid + Start menu launching)

## Goal

One "activate a path" mechanism shared by the desktop double-click, the
Start menu, and any future file browser (`0048` fileman). Today the two
launch paths behave differently for the same file, for no principled
reason — just incremental history (0028 menu vs 0029 desktop):

- `menu_launch()` (`wm.c` ~L383): symlink → run; **plain file → parse
  first line as argv and spawn** (the `term snake` convention).
- `desk_launch()` (`wm.c` ~L503): symlink → run; **plain file → open in
  `term vi`**.

## Plan

- Factor a single `activate(path)` helper in `wm.c`. Rules:
  - **symlink** → spawn its target (as today).
  - **regular file that is runnable** → spawn it directly. "Runnable" =
    the kernel can exec it: WASM (magic `\0asm`) *or* a `#!` script
    (needs `0065`). Decide by peeking the first bytes.
  - **anything else** → open in its type's default viewer (`vi` for text
    today; leaves room for an image viewer etc. later).
- Point `desk_launch()` and `menu_launch()` at the shared helper; delete
  the divergent special-cases.
- Migration wrinkle: existing Start-menu entries (`/usr/share/menu/snake`
  = `term snake\n`) are the *old* first-line-argv format, **not** shebang
  scripts. Either keep a compatibility branch for them, or convert those
  seeded entries to real `#!/bin/sh` scripts (preferred — one true
  mechanism; touches the baked image, bump the image version).

## Acceptance

- Double-clicking a `#!/bin/sh` launcher on the desktop runs it (e.g. a
  `DrMario` launcher that execs `/bin/gameboy /root/roms/DrMario.gb`).
- The same launcher, placed in the menu dir, launches identically from
  the Start menu.
- Double-clicking a plain `.txt` still opens `vi`; symlink icons still
  run their target.
- `wmctl`-driven headless click of a launcher spawns the expected process;
  browser pixel tests stay green.
