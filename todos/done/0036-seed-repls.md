# 0036 — seed the REPLs: lua, micropython, sqlite

- **Status**: open
- **Depends**: — (mkimage/image-layering makes the seed cost moot but is
  not blocking)
- **Design**: `todos/OS.md` (reference build / image.json), vendor
  READMEs (`vendor/lua`, `vendor/micropython`, `vendor/sqlite`)

## Goal

`/bin/lua`, `/bin/micropython`, `/bin/sqlite3` in the OS image — all
three vendor projects already build with this compiler; each is one
`"project"` entry in `os/image.json`. The tty's `interactiveOut` +
brokered fs should make the REPLs Just Work at the hush prompt.

## Plan

- image.json entries + ONE version bump; update the CLAUDE.md/OS.md
  seeded-binaries lists.
- **Measure the fresh-seed delta per project before committing all
  three** — sqlite's amalgamation is likely the slowest single TU in the
  repo. If any one blows the budget (fresh seed is ~5s-class today),
  options recorded in `logs/2026-07-06/first-boot-ux-and-seeding-perf.md`:
  wait for `tools/mkimage.js` (the unnumbered pre-baked-image item,
  unlocked by 0026) or leave the heavy one out until then.
- micropython: the REPL-spins-on-stdin-EOF class of bug was fixed
  upstream-side in this repo's port — verify piped use
  (`echo ... | micropython`) exits cleanly under the kernel fs/tty
  before seeding; same check for lua and the sqlite3 shell (`.quit`
  and EOF paths).
- Interactive line editing: lua and sqlite3 read raw lines (fine over
  the tty's canonical mode); micropython has its own line editor —
  check it against the pty like vi/hush were.

## Acceptance

- Headless: `echo 'print(1+1)' | node os/boot.js` piped into each
  binary produces the expected output and EXITS (no EOF spin):
  lua `print(1+1)`, micropython `print(1+1)`, sqlite3
  `select 1+1;`.
- Interactive smoke over the pty/term path for at least one of them.
- Fresh-seed time recorded before/after in the dev log.
