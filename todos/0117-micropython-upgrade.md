# 0117 — MicroPython: script runner + FS import (multi-round, unlocks /bin/python)

- **Status**: open (META — expect multiple rounds; close each round as its
  own commit, keep this item open until Round 2 lands then reassess)
- **Design**: this file. Precedent: `todos/done/0036` seeded the REPLs
  (`/bin/micropython`, `/bin/lua`, `/bin/sqlite3`) — deliberately the
  *minimal* MicroPython port.

## Why

`/usr/bin/micropython` (image.json) is MicroPython **1.28.0 minimal port**
— REPL-only and, as shipped, a footgun to alias as `python`:

- `vendor/micropython/main.c` never reads `argc`/`argv` → `micropython
  foo.py` silently drops into the interactive REPL and ignores the file.
- `mp_lexer_new_from_file` is a hard stub raising `OSError(ENOENT)`;
  `mp_import_stat` always returns `MP_IMPORT_STAT_NO_EXIST` → no FS
  `import`, only frozen modules.
- `MICROPY_PY_BUILTINS_OPEN` / `MICROPY_PY_IO` / `MICROPY_PY_SYS_STDFILES`
  are all `0` (`mpconfigport.h`) — no `open()`, no file objects.

So a `python` symlink today would break the single most common thing
anyone types. The goal is to make MicroPython a real script runner over
the OS filesystem, **then** alias `/bin/python` honestly (MicroPython
dialect — curated stdlib, no C-extension packages; that caveat is
documented, not a bug). CPython is explicitly **not** the plan here
(threads dropped per 0006, configure-less build, no dlopen — see WIN32.md's
"rest of Windows" precedent for the same "value/effort is bad" reasoning;
MicroPython is the pragmatic Python story for this constrained,
static-linked, single-threaded world).

## Plan (rounds)

**Round 1 — argv + run a script file + basic file I/O.**
- Move off the minimal-port config toward the upstream **unix-port**
  config for the file/stream object set (this is adopting an existing
  upstream config, not inventing objects — the unix port already does all
  of this). Keep the build a hand-listed `bin.json` (no configure runner
  in this repo — sqlite/lua precedent).
- Implement `mp_lexer_new_from_file` and `mp_import_stat` against the OS
  filesystem (POSIX `open`/`read`/`stat` via the veneer libc).
- `main.c`: honour argv — `micropython foo.py [args]` compiles+runs the
  file, sets `sys.argv`, exits with its status; no-arg stays the REPL.
- Enable `MICROPY_PY_BUILTINS_OPEN` + `MICROPY_PY_IO` +
  `MICROPY_PY_SYS_STDFILES` and supply the stream objects they need.
- **Then** seed `/bin/python` → `/bin/micropython` in image.json (or a
  thin argv0 alias) and bump the image version.

**Round 2 — FS `import` of real .py modules + a usable stdlib slice.**
- Filesystem module import (`import foo` finds `/…/foo.py`); `sys.path`
  seeded sensibly (cwd + a site dir under `/usr/lib/micropython` or
  similar).
- Curate which built-in modules to compile in (the minimal port ships
  `math`/`sys`/`gc`/`array`/`collections`/`struct`/`errno`/…; decide the
  target set — `os`, `json`, `time`, `re` are the obvious next ones).
- Consider a shebang story: `#!/bin/python` scripts run via the 0065
  `_spawnShebang` path.

**Round 3+ (reassess after R2) — dialect breadth as demand appears.**
- More stdlib, `subprocess`-ish spawn shim over `__spawn`, whatever the
  first real in-OS Python scripts actually need. Driven by demand, not
  speculation.

## Acceptance

- R1: `echo 'print("hi")' > /root/t.py && python /root/t.py` prints `hi`;
  `python` with no args is still the REPL; `open('/root/t.py').read()`
  works from the REPL.
- R2: a two-file `import`-ing script runs; a curated `import os, json`
  succeeds.
- New kernel e2e test alongside `tests/kernel/test_repl_pty_e2e.js`
  (script-file + import legs), plus a note in CLAUDE.md's REPL paragraph
  updating the "argv ignored, no open()/import" description once it's
  false.
- Image version bumped; `vendor/micropython/README.md` created (it's
  currently missing) pinning the config choice + patch list.
