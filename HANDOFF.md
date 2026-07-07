# Handoff — start of thread (updated 2026-07-07, after the SAB ring fixes)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Phase 4 is open** (0008 AF_UNIX sockets + the jobctl tty e2e landed
earlier on 2026-07-07 — see `logs/2026-07-07/af-unix-sockets.md` and
`jobctl-tty-e2e.md`). The same day, the lingering-items sweep landed
(`logs/2026-07-07/lingering-items-sweep.md`):

- **runModule 'error' listener leak fixed** — exit-on-EPIPE handler is
  module-scoped now, idempotent per stream.
- **Node output path data loss fixed** (both CONFORMANCE-REMAINING
  items): host.js CLI drains stdout/stderr before exit (`flushAndExit`),
  and the default writers copy chunks out of wasm memory
  (`Buffer.from`) so memory.grow can't corrupt queued output.
- **First-run path is tested**: `tests/serve/test_first_run.js` parses
  serve.js's printed URL and asserts it 200s with COOP/COEP + all worker
  scripts servable.
- **New fast suite**: `node tests/host/run.js` (host-level Node tests —
  epipe listeners, stdout flush, first-run). Run it alongside
  unit/blockfs/kernel.

Later the same day, the **SAB ring fixes** landed
(`logs/2026-07-07/sab-ring-fixes.md`): the console ring got pty-style
blocking backpressure (producer Atomics.waits on a full ring; never
overruns the reader) and the audio ring's writePos is masked modulo
capacity (no more RangeError after ~2h of audio). Both test-first in
`tests/host/` — note the coprime-pattern gotcha in the log if you ever
write another ring test.

All green and verified: unit 700✓, blockfs✓, kernel✓, host✓, browser
os-boots.mjs (real Chromium)✓.

## The queue (todos/README.md is authoritative)

1. **`0007` WM/compositor — design doc first** (the ONLY queued item;
   its IPC prerequisite, AF_UNIX sockets, landed 2026-07-07)

(`0006` threads + atomics stays deferred indefinitely.)

## Lingering small items (none blocking)

- Browser first boot seeds hush + coreutils + cc; `tools/mkimage.js`
  (pre-baked image) is the recorded fix if seeding time ever matters.
- Bare `$(trap)` doesn't report parent traps (vendor README).
- `tests/browser/os-boots.mjs` is manual — run after touching os/,
  kernel.js, host.js fd/fs paths, or the busybox port.
- `FEATURE_VI_REGEX_SEARCH`: **verified 2026-07-07 to be HARD, not the
  1-2h flip previously estimated.** vi.c's `/search` needs the GNU regex
  API (`re_compile_pattern`/`re_search`/`re_syntax_options`/
  `not_bol`/`not_eol`) and `:s///` needs `REG_STARTEND` — all absent from
  the musl regex in libc-ext.js (POSIX regcomp/regexec only). Requires a
  GNU-compat shim in libc or hand-patching both vi.c search paths.
- AF_INET / fetch()-HTTP are future Phase 4 items (need a relay design);
  socket v1 non-goals listed in KERNEL.md "AF_UNIX sockets".

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing (`logs/YYYY-MM-DD/<topic>.md`), README next-up current.
- Conformance bugs: **failing test first, commit, then fix** — and prove
  the test fails pre-fix (this session's slow-consumer test initially
  failed OPEN by falling off the event loop; attach lifecycle listeners
  at spawn time).
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
