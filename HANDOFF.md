# Handoff — start of thread (updated 2026-07-07, after 0010 coreutils)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**OS.md Phase 1 is COMPLETE.** 0010 landed 2026-07-07: 27 busybox
coreutils applets (ls cat cp mv rm mkdir rmdir head tail wc sort pwd true
false ln touch basename dirname grep egrep fgrep sed echo printf test `[`
kill) as ONE multicall `/bin/coreutils` with `/bin` symlinks. The
`os/cat.c`/`os/ls.c` stopgaps are gone. Key call, made by measurement:
per-applet builds cost ~26s of first-boot seeding vs ~2s for the
multicall, so the multicall won — but it's a hand-rolled dispatch table
(`vendor/busybox/port/multicall_main.c`), NOT upstream appletlib, so
0005's stubs survive. Full story: `logs/2026-07-07/coreutils-multicall.md`;
port doc: `vendor/busybox/README.md`.

The applet symlinks flushed out real bugs now fixed: kernel FS_READLINK
had never worked (signature mismatch both sides), BlockFS.open ignored
its create mode (now honored under a fixed 022 umask), the Node-fs host
lacked the `link` import, and the libc grew mkstemp/strcasestr/AT_*/
nlink_t-family/chown-noops/mknod-stub. `os-common.js` buildProject
learned bin.json `deps`; image manifests learned `link` entries;
`os/image.json` is v7.

All green and verified: unit 697✓, blockfs✓, kernel incl. OS acceptance
with new coreutils pipelines✓, browser os-boots.mjs (real Chromium)✓.
Try it:

```bash
node serve.js .    # open the printed /os/os.html URL
printf 'ls -l /bin | head\nexit\n' | node os/boot.js   # headless
node tests/kernel/run.js
```

## The queue (todos/README.md is authoritative)

1. **`0007` WM/compositor — design doc first**
2. `0008` networking — AF_UNIX first

(`0006` threads + atomics stays deferred indefinitely — don't re-open
without a port that hard-requires pthreads.)

## Lingering small items (none blocking)

- Browser first boot now seeds hush + coreutils + cc (~2s slower than the
  2.3s from 2026-07-06). `tools/mkimage.js` (pre-baked image) is the
  recorded fix if it ever matters.
- Interactive job control (Ctrl-Z/fg/bg) still has no automated e2e test
  (kernel pieces unit-tested; needs a pty-ish harness or Playwright
  typing Ctrl-Z).
- The first-run path (serve.js → printed URL 200s) has no automated test.
- Bare `$(trap)` doesn't report parent traps (vendor README "Known
  limitations").
- `tests/browser/os-boots.mjs` is manual — run after touching os/,
  kernel.js, host.js fd/fs paths, or the busybox port. (It types
  `ls -1 /` now: busybox ls prints columns on a tty.)
- Node-side stdout truncation items in `CONFORMANCE-REMAINING.md`
  (host.js §) still stand.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing (`logs/YYYY-MM-DD/<topic>.md`), README next-up current.
- Conformance bugs: **failing test first, commit, then fix**.
- Seeded OS sources changed? **Bump `os/image.json` `version`**.
- compiler.js must stay browser-clean (no bare `process.*`).
- busybox config changes: regenerate `autoconf.h` via kconfig, re-apply
  the two `WASM PORT` patches (exec path, NOMMU). `LONG_OPTS=y` is
  load-bearing (see vendor README).
- Don't re-litigate: posix_spawn-not-fork, hush-not-ash, kernel-owned
  fds, multicall-not-per-applet, builtin-in-pipe re-execs `/bin/sh`.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0007 compositor design, 0008 networking, a lingering item, or
something else."
