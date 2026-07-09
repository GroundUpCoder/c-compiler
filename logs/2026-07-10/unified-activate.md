# Unified run/activate — one launch rule for menu + desktop (todos/0066)

Closed the gap 0028/0029 left behind: the Start menu and the desktop
double-click had *different* rules for the same file — menu parsed a
plain file's first line as an argv (the `term snake` convention), the
desktop opened it in `term vi`. Purely incremental history, no design
behind it, and it blocked treating launchers as ordinary files (0067
drag-drop, 0048 fileman would each have had to pick a side).

## What landed

One `activate(path)` in `os/wm.c`, called by both `menu_launch()` and
`desk_launch()` (and ready for any future file browser):

- **symlink** → spawn via the link path (the fs resolves it) — as today.
- **regular file that is runnable** → spawn it directly. "Runnable" =
  the kernel can exec it, decided the way the kernel decides: peek the
  first bytes for wasm magic `\0asm` or `#!` (shebang exec, todos/0065 —
  the launcher primitive this item waited on).
- **anything else** → the type's default viewer, `term vi` today.

The first-line-argv menu format is **deleted**, not kept as a compat
branch — launchers are now ordinary executable scripts, the one true
mechanism. Its single seeded user, `/usr/share/menu/snake`
(`term snake\n`), became a real script (`#!/bin/sh\nterm snake\n`) in
`os/image.json` → **image v36** (menu file content + the wm binary
changed; `os/os-system.img` rebaked with `tools/mkimage.js`).

## Decisions / notes

- `activate()` does its own `lstat` rather than trusting the cached
  `menu_ent.is_link` — the entry list is a UI snapshot (coarse 1s
  re-read); the launch should judge the file as it is *now*. `is_link`
  stays for drawing (the desktop link notch).
- The runnable peek uses `fopen`/`fread`, mirroring the kernel's
  `_spawnBytes` dispatch (`#!` checked on ≥2 bytes, `\0asm` on ≥4).
  A wrong guess is harmless in both directions: a non-runnable spawn
  fails in posix_spawn (ENOEXEC path), a runnable-in-vi just shows
  bytes — but the peek IS the kernel's own rule, so they can't drift
  apart in what "runnable" means.
- No chmod/X-bit semantics: the kernel spawn path doesn't check exec
  permission (0065 precedent — `./foo` runs an un-chmod'ed script), so
  `is_runnable` doesn't either. Content decides, not mode bits.
- Behavior deltas beyond the goal: a *runnable* plain file on the
  desktop now runs instead of opening in vi (the point), and a
  *non-runnable* plain file in the menu now opens in vi instead of
  being misparsed as an argv line (strictly better).

## Testing

`tests/kernel/test_wm_service_e2e.js` grew a 0066 section (all PASS):
drop a `#!/bin/sh` launcher + a `notes.txt` into `/root/Desktop` at
runtime, wait out the re-read tick, dblclick both — launcher spawns
winbox (+1 window), notes opens the viewer (term +1); an `/etc/menu`
override dir with one launcher script launches identically from the
Start menu (same `activate()` path); `head -c 2` asserts the seeded
snake entry really starts `#!`. The window-count deltas cross-check the
peek: a misfire flips which window type appears, so the legs can't
false-pass together. Existing symlink legs (desk3/menu winbox) cover
the unchanged branch. Suites: kernel ALL PASS, blockfs 12/12, browser
subset os-boots/os-shell/os-wm PASS (menu still 9 entries, same names —
the 150x188 geometry constants hold).

Concurrent landing note: `dec3424` (queue single-sourcing) landed
mid-session from another thread; only `todos/`-shape changes, no code
overlap — staged files kept separate.
