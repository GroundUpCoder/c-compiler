# Handoff — start of thread (updated 2026-07-06, after the 0005 arc + fresh-pull fixes)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

One day's arc (2026-07-06, eight commits `0b06aa4..5f00e19`, all green,
all pushed): kernel Phase 4 (pipes + job control) → the bootable `os/`
reference build → **busybox hush as `/bin/sh`** (the kernel design's
acceptance test, passed with zero kernel workarounds) → fresh-pull fixes
after the user tried it (serve.js now prints the real entry URL; first
browser boot cut 7.5s → 2.3s by memoizing the seed-time sync-XHR reads —
it was 18,722 blocking include-probe requests, not slow compilation).
OS.md Phase 1 is complete except coreutils. Verified working from a fresh
pull by the user. Try it:

```bash
node serve.js .    # prints http://localhost:PORT/os/os.html — open THAT
                   # (~2s first boot while it compiles the userland into
                   #  OPFS; instant + persistent afterwards)
printf 'echo hi | cat\nexit\n' | node os/boot.js   # same OS headless
node tests/kernel/run.js                           # 10/10, incl. OS acceptance
```

Orientation docs, in reading order: `todos/README.md` (queue + next-up),
`todos/OS.md` (north star + phase status), `todos/KERNEL.md`,
`vendor/busybox/README.md` (the port + its patch table), and the four
`logs/2026-07-06/*.md` dev logs for the why of everything above.

## The queue (todos/README.md is authoritative)

1. **`0010` busybox coreutils** — real applets in /bin; replaces the tiny
   `os/cat.c`/`os/ls.c` stopgaps. The vendor infrastructure from 0005 is
   waiting for it. Decision to make early: multicall vs per-applet builds.
2. `0007` WM/compositor — design doc first
3. `0008` networking — AF_UNIX first

(`0006` threads + atomics was **deferred indefinitely** on 2026-07-07 —
processes are the parallelism unit; rationale in `todos/0006` +
`logs/2026-07-07/threads-atomics-deferral.md`. Don't re-open without a
port that hard-requires pthreads.)

## Lingering small items (none blocking)

- ~~Compiler crash: `__attribute__((aligned(N)))`~~ — fixed 2026-07-07
  (turned out to be every-position, not just after-array; busybox ALIGN*
  workaround reverted; see `logs/2026-07-07/aligned-attr-fix.md`).
- **Interactive job control** (Ctrl-Z/fg/bg in the browser tab) works by
  construction and the kernel pieces are unit-tested, but no automated
  end-to-end test drives hush's `fg`/`bg` interactively — needs a pty-ish
  harness (`os/boot.js --tty-out` is the hook) or a Playwright script that
  types Ctrl-Z. Worth adding when touching the shell again.
- **The first-run path has no automated test** (the fresh-pull 404 was
  invisible to the browser test because it navigates straight to the
  page — see `logs/2026-07-06/first-boot-ux-and-seeding-perf.md`). A tiny
  "curl the printed URL" check would close it.
- `tools/mkimage.js` (pre-baked image blob) is the recorded next step if
  first-boot latency ever matters beyond the dev loop.
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
