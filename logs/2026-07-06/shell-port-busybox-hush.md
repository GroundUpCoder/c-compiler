# THE SHELL — busybox hush as /bin/sh (todos/0005)

The kernel design's acceptance test, passed: busybox 1.37.0 hush runs as
pid 1 of the OS — pipelines, `$( )`, redirections, here-docs, control
flow, functions, job control, interactive line editing with a prompt in
the browser tab — **with zero kernel workarounds**. Every patch is
shell-side or a pre-existing libc gap the port exposed.

## Why hush, and why it fit

ash hard-requires fork (`shell/ash.c` Kconfig: `depends on !NOMMU`). hush
has run on fork-less NOMMU Linux for years: subshells, `$( )`, and
builtins-in-pipes all **re-exec the shell binary with serialized state**
(`re_execute_shell` packs vars/functions/traps into argv), and external
commands are vfork+exec. Build hush with `CONFIG_NOMMU=y` and every
fork-shaped site is already "prepare declaratively, then exec" — which is
`__spawn`'s exact shape.

Critical config lesson: BB_MMU comes from `ENABLE_NOMMU` (kconfig), NOT
from patching fork calls. First build silently took the MMU paths —
`$( )` ran in-process and wrote to the terminal. If porting busybox
bits: `CONFIG_NOMMU=y` first, then look at what's left.

## The vfork-on-__spawn shim (`vendor/busybox/port/`)

No vfork here either — but hush's NOMMU children are journalable, so the
"child" runs in the parent in journaling mode: intercepted close/dup2/open
become `__fd_action`s, `setpgid` becomes the spawn spec's SETPGROUP,
`tcsetpgrp` defers until the pid exists, exec issues ONE `__spawn` and
longjmps back with the pid; `_exit` (children that never exec) longjmps
back with a synthetic pid whose status waitpid() serves locally. hush
already restores its globals after a memory-sharing child — upstream did
the hard part. Three call sites patched into the compiler's supported
`if (setjmp(x) == 0)` shape (our setjmp lowering rejects value-using
forms). Full patch table: `vendor/busybox/README.md`.

Here-docs took a different route: upstream feeds >pipe-capacity bodies
from an orphaned grandchild (impossible without fork, and a spawned
feeder would deadlock — the consumer execs only after setup returns).
bash's answer is ours too: unlinked temp file.

## What the port surfaced (the real value of shell-sized test loads)

1. **Compiler: void-pointer arithmetic compiled to +0** (GNU
   `sizeof(void)==1`; difference /0 trapped). libbb's mempcpy fallback is
   `memcpy(d,s,n)+n` — every expanded word lost its head ('echo' → '',
   'hi' → 'i'). Fixed at the two codegen scale/div helpers + three
   constEval sites; `tests/unit/conformance/void_ptr_arith` (test-first).
2. **libc: `_exit()` was `for(;;){}`** — a pre-kernel stub. Every hush
   exit hung. Now does the `__exit` handshake (KERNEL.md specified this;
   never implemented).
3. **libc: `fcntl()` was a no-op inline** (`return 0`, kept for SQLite's
   advisory locks) — F_DUPFD **never worked from C**, so hush's
   interactive init (`dup_CLOEXEC` to fd 255) silently produced fd 0 →
   non-interactive shell. Now variadic-unpacks int-arg commands into a
   real `__fcntl3` import (host keeps lock commands as success no-ops).
4. **host: `__tty_getpgrp` gated on fd<=2** — shells hold the tty on a
   high dup'd fd; tcgetpgrp(255) returned -1 and hush's "wait until
   foreground" loop spun forever on `kill(-1, SIGTTIN)` (EPERM). v1 has
   one tty: any fd maps to it.
5. **kernel: `_setpgid` was dispatched but never defined** (latent since
   Phase 1 — no libc wrapper existed to trigger it). Defined; libc grew
   setpgid/getpgid/getpgrp over the existing RPCs.

Also new: `interactiveOut` (a createTty opt) — the UI bridge declares "a
human terminal is attached" and fd 1/2 become tty-kind, so isatty(1) is
true and shells go interactive (prompt/lineedit/job control). Piped runs
keep 'out'-kind fds and byte-exact stdout. os.html sets it; boot.js sets
it on a real TTY (or `--tty-out` to force).

## Infrastructure that rode along

- `os/image.json` entries can be `project` (a repo-relative bin.json):
  seeding builds hush from source via the CompilerJS library — Node reads
  files; the kernel worker uses synchronous XHR (legal in workers).
  compiler.js honors a script-loaded `EXT_LIB_MAP` global so the browser
  worker gets fnmatch/glob (libc-ext.js via importScripts).
- Tiny native `cat`/`ls` seeds (`os/cat.c`, `os/ls.c`) until the real
  coreutils land (`todos/0010`). hush's NOMMU builtin dispatch was
  repointed at the full builtin table (no multicall binary to re-exec, so
  echo/test/printf/kill in pipelines re-exec /bin/sh itself).
- boot.js `--dump-state` (kernel-state peek) and `--tty-out`.

## Verification

- `tests/kernel/test_os_boot.js` (kernel suite): 31 checks — the full
  gauntlet incl. `cc hello.c && ./a.out`, and a here-doc-written C
  program compiled in-OS whose `popen("… | cat")` and `system("… >
  file")` round-trip. Failure modes leave the OS alive; `$?` propagates.
- `tests/browser/os-boots.mjs`: interactive hush in headless Chromium —
  real prompt, typed pipelines, OPFS persistence across reload.
- Suites: units 695/0, kernel 10/10, spawn, BlockFS all green.

Next: `todos/0010` coreutils. Phase 1's exit criterion ("open the tab,
land in a shell, pipelines, Ctrl-C, `cc hello.c && ./a.out`") is met.
