# Handoff — start of thread (written 2026-07-06, after todos/0005)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

One day's arc (2026-07-06, five commits `0b06aa4..f2cc759`, all green, all
pushed): kernel Phase 4 (pipes + job control) → the bootable `os/` reference
build → **busybox hush as `/bin/sh`** — the kernel design's acceptance test,
passed with zero kernel workarounds. OS.md Phase 1 is complete except
coreutils. Try it:

```bash
node serve.js .                        # → open /os/os.html: real shell in a tab
printf 'echo hi | cat\nexit\n' | node os/boot.js   # same OS headless
node tests/kernel/run.js               # 10/10 (includes the OS acceptance)
```

Orientation docs, in reading order: `todos/README.md` (queue + next-up),
`todos/OS.md` (north star + phase status), `todos/KERNEL.md`,
`vendor/busybox/README.md` (the port + its patch table), and the three
`logs/2026-07-06/*.md` dev logs for the why of everything above.

## The queue (todos/README.md is authoritative)

1. **`0010` busybox coreutils** — real applets in /bin; replaces the tiny
   `os/cat.c`/`os/ls.c` stopgaps. The vendor infrastructure from 0005 is
   waiting for it. Decision to make early: multicall vs per-applet builds.
2. `0006` threads + atomics (big; compiler + host joint effort)
3. `0007` WM/compositor — design doc first
4. `0008` networking — AF_UNIX first

## Lingering small items (none blocking)

- **Compiler crash to fix someday**: `__attribute__((aligned(N)))` after an
  array declarator → internal error (top entry in
  `todos/CONFORMANCE-REMAINING.md` §compiler.js; busybox works around it).
- **Interactive job control** (Ctrl-Z/fg/bg in the browser tab) works by
  construction and the kernel pieces are unit-tested, but no automated
  end-to-end test drives hush's `fg`/`bg` interactively — needs a pty-ish
  harness (`os/boot.js --tty-out` is the hook) or a Playwright script that
  types Ctrl-Z. Worth adding when touching the shell again.
- Bare `$(trap)` doesn't report parent traps (vendor README "Known
  limitations"; niche POSIX idiom, everything else about traps works).
- `tests/browser/os-boots.mjs` is manual (repo convention for browser
  tests) — run it after touching os/, kernel.js, or the port.
- The Node-side stdout truncation items in `CONFORMANCE-REMAINING.md`
  (host.js §) predate this work and still stand.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing (`logs/YYYY-MM-DD/<topic>.md`), README next-up current.
- Conformance bugs: **failing test first, commit, then fix**
  (`tests/unit/conformance/`).
- Seeded OS sources changed? **Bump `os/image.json` `version`** or existing
  images won't re-seed.
- compiler.js must stay browser-clean (no bare `process.*`).
- Don't re-litigate: posix_spawn-not-fork, `__spawn` grows by spec field,
  hush-not-ash, kernel-owned fds (all documented with rationale).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0010 coreutils, 0006 threads, one of the lingering items, or
something else."
