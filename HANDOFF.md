# Handoff — start of thread (updated 2026-07-07, after 0011 busybox vi)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**OS.md Phase 1 is COMPLETE, and the OS now has an editor.** 0011 landed
2026-07-07: busybox `vi` as `/bin/vi`, the 28th applet in the coreutils
multicall. The port cost almost nothing (the investigation is the story:
hush's line editing already ran vi's entire input stack — read_key,
safe_poll, raw termios). New for the platform: libc `sigsetjmp`/
`siglongjmp` (macros over setjmp — cooperative signals have no mask to
save); two vi.c compiler-dialect patches (sigsetjmp if-form, 6 GNU `?:`
sites). `os/image.json` is **v8**. Full story:
`logs/2026-07-07/busybox-vi.md`; port doc: `vendor/busybox/README.md`.

The interesting artifact is the test: `tests/kernel/test_vi_e2e.js`
drives REAL edit sessions (insert/append/search/cw/undo/dd/:wq/:q!)
through `boot.js --tty-out` — keystrokes through the kernel tty into vi's
raw mode, file bytes asserted via cat+marker after every save. Harness
rules that took iteration: the file is the assertion (screen is scenery);
only full-line renders are expectable (vi paints incrementally —
`ESC[1;12H!`, never "world!"); ESC goes alone with air around it;
`ESC[?1049h/l` (alternate screen) are perfect vi-started/exited markers.
That harness is the template for any future full-screen-app test.

All green and verified: unit 697✓, blockfs✓, kernel incl. vi e2e✓,
browser os-boots.mjs (real Chromium)✓. Try it:

```bash
node serve.js .    # open the printed /os/os.html URL, run: vi /tmp/x.txt
node tests/kernel/test_vi_e2e.js
```

## The queue (todos/README.md is authoritative)

1. **`0007` WM/compositor — design doc first**
2. `0008` networking — AF_UNIX first

(`0006` threads + atomics stays deferred indefinitely.)

## Lingering small items (none blocking)

- Browser first boot seeds hush + coreutils + cc; `tools/mkimage.js`
  (pre-baked image) is the recorded fix if seeding time ever matters.
- Interactive job control (Ctrl-Z/fg/bg) still has no automated e2e —
  though test_vi_e2e.js's --tty-out harness is most of the pty-ish
  machinery that item was waiting for.
- The first-run path (serve.js → printed URL 200s) has no automated test.
- Bare `$(trap)` doesn't report parent traps (vendor README).
- `tests/browser/os-boots.mjs` is manual — run after touching os/,
  kernel.js, host.js fd/fs paths, or the busybox port.
- `FEATURE_VI_REGEX_SEARCH` is off (upstream default); we DO have regex
  (sed/grep use xregcomp) — flip it if someone misses regex search.
- Node-side stdout truncation items in `CONFORMANCE-REMAINING.md`.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing (`logs/YYYY-MM-DD/<topic>.md`), README next-up current.
- Conformance bugs: **failing test first, commit, then fix**.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (now v8).
- compiler.js must stay browser-clean (no bare `process.*`).
- busybox config changes: regenerate `autoconf.h` via kconfig
  (upstream tree lives at `/tmp/busybox-1.37.0`; rebuild it from
  `/tmp/busybox.tar.bz2` if the tmpdir got cleaned), re-apply the two
  `WASM PORT` hand-patches (exec path, NOMMU). `LONG_OPTS=y` is
  load-bearing.
- Don't re-litigate: posix_spawn-not-fork, hush-not-ash, kernel-owned
  fds, multicall-not-per-applet, builtin-in-pipe re-execs `/bin/sh`.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0007 compositor design, 0008 networking, a lingering item, or
something else."
