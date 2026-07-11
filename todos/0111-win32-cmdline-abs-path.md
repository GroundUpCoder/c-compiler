# 0111 — win32 cmdline: absolute POSIX paths misparse as option flags — default.gui notepad open shows an ERROR box

- **Status**: open
- **Design**: `os/win32/kernel32.c` (`proc_info_init` cmdline builder),
  `vendor/notepad/main.c` (`HandleCommandLine`), `todos/done/0108`
  (which surfaced it while realigning test_openwith_e2e).

## Goal

Opening ANY file through the openwith `default.gui → /bin/notepad` route
(fileman Open on an unassociated extension, desktop double-click, `open
foo.md`) lands on an ERROR MessageBox ("…does not exist / create?") and an
"Untitled - Notepad" window instead of the file. Mechanism, verified on
v54: kernel32's `proc_info_init` space-joins argv into `GetCommandLineW`
quoting only args WITH SPACES, so notepad's `lpCmdLine` is a bare
`/root/owtest/readme.md`; ReactOS `HandleCommandLine` treats leading `/`
as a Windows option prefix, consumes `/r`, and tries to open
`oot/owtest/readme.md`. Every UNICODE port that parses `/`-options from
its command line has the same exposure — this is a veneer-vs-POSIX-paths
convention gap, not a notepad-only bug.

## Plan

- Preferred: make kernel32's cmdline builder quote EVERY arg after argv0
  (Windows-canonical; `"..."`-first args skip the option loop and
  notepad's existing quote-strip path at `HandleCommandLine` already
  handles them). Audit the other cmdline consumers (winmine takes no
  args; calc takes none; k32demo's CreateProcess tokenizer round-trip)
  before flipping — the tokenizer in kernel32's CreateProcess must agree
  with the new quoting.
- Alternative (if quoting regresses a port): patch
  `vendor/notepad/main.c` to drop `/` from the option-prefix set (POSIX
  world; keep `-`), with a `README.md` patch-table entry.
- Then tighten test_openwith_e2e's default.gui check from "a window
  matching /Notepad\$/ exists" to the real title `readme.md - Notepad`
  and assert NO `ERROR` window in list3 — 0108 deliberately left that
  check loose so it guards launch, not the still-broken file load.

## Acceptance

- In-OS: fileman Open on `readme.md` (no association) opens notepad WITH
  the file loaded — title `readme.md - Notepad`, no ERROR box.
- `node tests/kernel/run.js --filter=openwith` passes with the tightened
  check; `--filter=notepad`, `--filter=winmine`, `--filter=calc`,
  `--filter=kernel32` stay green (cmdline convention audit).
