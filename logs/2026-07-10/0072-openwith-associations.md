# 0072 — file associations + pickable default open app

The desktop's "anything that isn't runnable opens in `term vi`" policy —
duplicated verbatim in `wm.c activate()` and fileman's `open_selected()` —
became ONE resolver with a user-editable store: `os/openwith.h`.

## What landed

- **`os/openwith.h`** — header-only by necessity, not taste: image.json's
  `c` entries are single-source compiles (staged + in-image `cc`), so a
  shared `.c` would have needed a build-system change. Static functions by
  textual inclusion cost a few hundred duplicated wasm bytes per binary and
  zero manifest machinery. API: `ow_resolve(path, gui, …)` (extension key →
  context default → hardcoded pre-0072 fallback), `ow_set` (persist),
  `ow_is_runnable` (the `\0asm`/`#!` peek — the two per-app copies died),
  `ow_build` (split the command, resolve a bare word through
  /usr/local/bin:/bin, append the path).
- **Store**: first existing of `~/.config/openwith`, `/etc/openwith`,
  `/usr/share/openwith` — whole-file, NO per-key merge, deliberately the
  `/etc/menu` first-existing-wins precedent (todos/0040). The merge
  question is instead answered at WRITE time: `ow_set` rewrites the
  effective table with the key updated, so the baked defaults carry
  forward into the first user file (tmp+rename, the registry discipline).
  Values are argv prefixes (`term vi`, `/bin/gameboy`), so "what wraps a
  tty program in a terminal" is the user's line, not resolver magic.
- **`activate()` semantics change**: the old dispatch was
  `S_ISLNK || (S_ISREG && runnable)` → spawn. Now it's `stat()` (follows
  links) + runnable → spawn, else associate. Net effect: a symlink to a
  non-runnable (a Desktop link to a ROM, say) opens through its
  association instead of spawn-failing silently; symlinks to binaries
  behave exactly as before (fopen follows the link for the magic peek,
  spawn still goes through the link path). fileman keeps its own copy of
  the shape (different spawn plumbing) but every policy byte is in the
  header.
- **`/bin/open`** (`os/open.c`) — the terminal context needed a consumer,
  and execve is a stub in the posix_spawn world, so `open FILE` is
  spawn-inherit-everything + waitpid, exiting with the child's status
  (same pgroup → a tty program is a normal foreground command).
  `open --set KEY CMD...` is the minimal defaults editor from the item's
  "pickable" bullet — and what makes association writes testable without
  the GUI.
- **fileman picker**: a "With" button + an `OpenWith` top-level window
  (command EDIT prefilled from `ow_resolve`, an "Always for .ext" /
  "Always (GUI default)" BS_AUTOCHECKBOX, OK/Cancel). Agent-drivable like
  everything else: `wmctl settext EDIT:1 …`, `wmctl click "Always for
  .txt"`, `wmctl click OK`.
- **Baked seed** (`/usr/share/openwith`, image v43→v44): `gb`/`gbc` →
  `/bin/gameboy`, `default.gui` → `/bin/notepad`, `default.term` → `vi`.
  So GUI double-click of a text file now lands in notepad, terminal `open`
  lands in vi, and a `.gb` anywhere launches the emulator with that ROM.

## Testing

`tests/kernel/test_openwith_e2e.js` (15 checks): the `open` CLI legs use a
probe launcher script (`echo opened:$1 >> probe.out`) instead of real
interactive viewers — deterministic, no pty. The desktop/fileman `.gb`
legs synthesize a minimal Peanut-GB-valid cartridge (0x150 bytes: entry
JP, Nintendo logo, header checksum — the `build_test_rom` recipe) and
base64 it in through the shell, so the emulator window STAYS up for the
`wmctl list` assert; a garbage file would exit before the check. Picker
legs drive prefill/settext/Always/OK and verify both the spawn and the
persisted `~/.config/openwith`; a second boot on the same image proves
persistence. `test_fileman_e2e.js` and `test_wm_service_e2e.js`
re-baselined from `term vi` to notepad. Kernel suite + browser sweep
green (see the item's Status line for numbers).

## Gotchas

- `strncasecmp` lives in `<strings.h>` (not `<string.h>`) in this libc —
  the first bake failed on it.
- Test-ordering matters with the label-addressed agent protocol: `wmctl
  click`/`settext` take the FIRST app that accepts the label, so the
  openwith test drives all fileman clicks BEFORE spawning notepad (which
  brings its own menus full of clickable labels).
- Seeded Desktop ROM launchers (`pokemon`, `mario`, `drmario` scripts)
  were left as-is: converting them to symlinks-to-ROMs would exercise the
  new association path but churns the entry lists three tests share, and
  the user section only seeds virgin volumes anyway.
