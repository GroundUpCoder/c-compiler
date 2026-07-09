# Shebang (`#!`) exec support (todos/0065)

The kernel now honours `#!` interpreter lines: a text file starting
`#!/bin/sh` is directly executable — `./foo`, `posix_spawn("/root/foo")`,
a desktop double-click — with no explicit `sh`. This is the enabling
primitive for 0066's unified run/activate mechanism, where a desktop
launcher becomes a plain executable shell script
(`#!/bin/sh\nexec /bin/gameboy roms/DrMario.gb`).

## What landed

`kernel.js`: `_spawnBytes` peeks the loaded image before anything else.
Bytes starting `#!` (0x23 0x21) go to the new `_spawnShebang` instead of
`_moduleFor`/`WebAssembly.compile`; everything else takes the exact old
path (wasm's `\0asm` magic can't collide with `#!`, so no existing binary
changes behavior).

`_spawnShebang` follows execve(2):

- Interpreter line = `#!` + optional whitespace + interpreter path + at
  most **one** optional argument — the rest of the line verbatim, no word
  splitting (`#!/bin/sh -e -x` passes `-e -x` as ONE arg, per Linux).
  Line budget 256 bytes (BINPRM_BUF_SIZE); no newline inside the budget →
  `ENOEXEC`. A trailing `\r` is stripped (CRLF-edited scripts work).
- Re-dispatched argv is `[interp, optarg?, scriptPath, ...origArgv[1:]]`
  — the *script path* replaces the caller's argv[0], per Unix. The rest
  of the spec (envp, cwd, fd actions, pgroup flags) carries over
  unchanged, so the interpreter lands exactly where the script would
  have (pipelines, redirections, job control all just work).
- A relative interpreter path resolves against the child's cwd
  (shebang interpreters are conventionally absolute anyway).
- Interpreter-is-itself-a-script chains re-enter `_spawn` with a depth
  counter, capped at 4; past that (i.e. cycles) → `ENOEXEC`.

## Decisions / gotchas

- **ENOEXEC, not ELOOP, for cycles**: the libc's `<errno.h>` has no
  ELOOP, and host.js's `errnoMap` would *throw* on an unknown name.
  ENOEXEC is in both, and "Exec format error" is a fine user-facing
  story for a busted interpreter chain.
- **Shebang check runs BEFORE the module cache** (`_moduleFor`), so
  scripts never allocate a cache entry. Previously a script spawn
  compiled the text as wasm, failed, and *cached the null* under the
  script's immutableKey; now scripts just re-read on each spawn (they're
  tiny). The interpreter itself still module-caches normally — spawning
  ten scripts compiles `/bin/sh` once.
- **hush has no ENOEXEC fallback** in our busybox build (no
  run-it-as-a-shell-script retry in `execvp_or_die`): a rejected exec is
  a clean `can't execute './loop': Exec format error` + exit 2. The e2e
  asserts that exact rc so we notice if a busybox bump grows the
  fallback.
- Depth is threaded as a third parameter through `_spawn`/`_spawnBytes`
  rather than riding the spec — RPC-supplied specs are attacker-ish
  input (a process could set `_shebangDepth: -1e9` if it lived on the
  spec).
- The cache-hit leg of `_spawn` forwards depth into its bytes-path
  fallback too. Strictly it's unreachable for scripts today (a `#!`
  image never creates a cache entry, so a cached-null can't be a
  script on an immutable volume) — but the forward keeps the counter's
  invariant local instead of depending on that global argument.

## Tests

- `tests/kernel/test_kernel.js` (fake workers, no threads): argv
  assembly incl. original-args append, one-arg optarg semantics,
  relative-interpreter cwd resolution, CRLF/padding tolerance, a
  two-hop chain's final argv, cycle → ENOEXEC, over-budget line →
  ENOEXEC, `#!\n` → ENOEXEC, missing interpreter → ENOENT.
- `tests/kernel/test_os_boot.js` (real hush, headless OS): `./foo world`
  and `/root/foo direct` print through `$1`; `sh /root/foo` unchanged;
  `#!/bin/sh -e` aborts on `false` (rc 1 — the optarg really reached
  hush); a self-referential `#!/root/loop` exits 2 instead of hanging.

Suites this session: kernel — ALL pass; blockfs 12/12; unit 699/0/3
(no compiler/libc change); browser subset serial: `os-boots.mjs`,
`os-shell.mjs`, `os-wm.mjs` all PASS (spawn path is the only kernel
change; the two-byte magic peek can't affect wasm binaries, so the
full sweep was not re-run).

No image bump: nothing seeded changed (the feature is kernel-side JS).
