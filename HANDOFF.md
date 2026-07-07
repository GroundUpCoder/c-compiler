# Handoff — start of thread (updated 2026-07-07, after 0008 AF_UNIX + jobctl e2e)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Phase 4 opened: the OS has sockets.** 0008 landed 2026-07-07: AF_UNIX
stream sockets as OFDs over the pipe machinery — the "trivial: pipes with
names in BlockFS" prediction held because 0009 made new OFD kinds cheap.
A connection is two pipe-shaped directions; the pipe read/write bodies
became shared `_streamRead`/`_streamWrite`; new 0x05xx opcodes are control
plane only. bind mknods a real S_IFSOCK inode (no format change; open()
on one is ENXIO now). libc grew `<sys/socket.h>`/`<sys/un.h>` + socket
errnos. IPC for the 0007 WM protocol is unlocked. v1 non-goals (DGRAM,
abstract ns, SCM_RIGHTS, O_NONBLOCK, MSG_PEEK) recorded in KERNEL.md.
Story: `logs/2026-07-07/af-unix-sockets.md`.

**The interactive job-control e2e gap is closed — and it caught a real
0003-era kernel bug on its first run.** `tests/kernel/test_jobctl_tty_e2e.js`
(vi-harness pattern: boot.js --tty-out, hush, `cat` as tty reader, `$?`
markers) drives Ctrl-C, Ctrl-Z→jobs→fg, bg→SIGTTIN, kill %1. The bug: a
stopped `cat`'s parked tty read sat at the head of `_ttyWaiters` and STOLE
the shell's next typed line — `_ttyNotify` had no serve-time eligibility.
Fix: stopped waiters consume nothing (stay queued); waiters whose pgroup
lost the tty since parking get the dispatch-time SIGTTIN/EIO treatment.
Same first-user-of-a-path class as 0010's FS_READLINK and 0011's
TIOCGWINSZ. Also pinned: hush (unlike bash) /dev/null's stdin of `cmd &`
even interactively — the SIGTTIN route in hush is Ctrl-Z then `bg`.
Story: `logs/2026-07-07/jobctl-tty-e2e.md`.

All green and verified: unit 697✓, blockfs (incl. new socket-node case)✓,
kernel incl. test_sockets/test_sockets_e2e/test_jobctl_tty_e2e✓, browser
os-boots.mjs (real Chromium)✓. Try it:

```bash
node tests/kernel/test_sockets_e2e.js      # C client/server over AF_UNIX
node tests/kernel/test_jobctl_tty_e2e.js   # Ctrl-Z/fg/bg through hush
```

## The queue (todos/README.md is authoritative)

1. **`0007` WM/compositor — design doc first** (now the ONLY queued item;
   its IPC prerequisite just landed)

(`0006` threads + atomics stays deferred indefinitely.)

## Lingering small items (none blocking)

- Browser first boot seeds hush + coreutils + cc; `tools/mkimage.js`
  (pre-baked image) is the recorded fix if seeding time ever matters.
- The first-run path (serve.js → printed URL 200s) has no automated test.
- Bare `$(trap)` doesn't report parent traps (vendor README).
- `tests/browser/os-boots.mjs` is manual — run after touching os/,
  kernel.js, host.js fd/fs paths, or the busybox port.
- `FEATURE_VI_REGEX_SEARCH` is off (upstream default); we DO have regex
  (musl regcomp in libc-ext.js; sed/grep use it) — flip it if someone
  misses regex search (~1-2h: kconfig regen + image bump + a vi e2e case).
- Node-side stdout truncation items in `CONFORMANCE-REMAINING.md`.
- AF_INET / fetch()-HTTP are future Phase 4 items (need a relay design);
  socket v1 non-goals listed in KERNEL.md "AF_UNIX sockets".

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing (`logs/YYYY-MM-DD/<topic>.md`), README next-up current.
- Conformance bugs: **failing test first, commit, then fix**.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v8 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- busybox config changes: regenerate `autoconf.h` via kconfig
  (upstream tree at `/tmp/busybox-1.37.0`; rebuild from
  `/tmp/busybox.tar.bz2` if tmp got cleaned), re-apply the two
  `WASM PORT` hand-patches. `LONG_OPTS=y` is load-bearing.
- Don't re-litigate: posix_spawn-not-fork, hush-not-ash, kernel-owned
  fds, multicall-not-per-applet, connect-never-blocks (v1 socket
  semantics, KERNEL.md).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0007 compositor design, a lingering item, or something else."
