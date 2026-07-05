# kernel Phase 3: the tty object — Ctrl-C means SIGINT (todos/0002)

The line discipline moved from the page into the kernel, where it can see
process groups. The tty SAB deliberately keeps the exact SI_* ring format
BlockFS's stdin path already consumes — the kernel simply became the
producer where the page used to be, so host.js's read machinery needed no
layout changes, only an EINTR probe.

## What landed

- **Tty class in kernel.js**: full termios state (flags + c_cc), canonical
  editing (VERASE/VKILL/VEOF), echo (ECHOE erase as `\b \b`, ^C caret
  form), ICRNL/INLCR/IGNCR, raw mode, TCSAFLUSH input discard, SIGWINCH on
  resize, sticky EOF. ISIG control chars route as signals to the
  **foreground pgroup**; `tcsetpgrp` moves it. UI bridge protocol is
  bytes-in (`tty.input`) / bytes-out (output callback) — the scripted
  bridge in the e2e is literally the agent-driving interface promised in
  OS.md.
- **termios goes full-struct**: the old `__tcgetattr`/`__tcsetattr` imports
  only carried 4 flag words — no c_cc, so VINTR wasn't even expressible.
  New `__tty_getattr`/`__tty_setattr`/`__tty_getpgrp`/`__tty_setpgrp`
  imports transfer the whole struct; termios.h rewired (plus new
  `tcgetpgrp`/`tcsetpgrp`). Host defaults added in BOTH fs paths (BlockFS:
  canned values + legacy mode-word publish; node-fs: the real
  `setRawMode` switching), so kernel-less runtimes keep working and old
  binaries keep their old imports.
- **Blocked reads become interruptible**: the kernel rings the tty's SI_SEQ
  futex whenever it posts a signal to an attached process; the woken read
  loop runs `ctx.deliverSignals` and surfaces EINTR (or restarts under
  SA_RESTART). Same probe in both select() wait paths. `isatty(0..2)`
  now reports 1 when a tty ring is attached (a worker's process.stdin
  said 0 before).

## Bug the tests caught

`fgPgid = 1` → `kill(-1, SIGINT)` — which POSIX reserves for "every
process" (our kernel EPERMs it). Ctrl-C to a foreground pgroup with pgid 1
(i.e. init's group, the common boot case!) silently did nothing. Fixed by
routing tty signals through a direct `_killPgid(pgid, sig)` instead of the
pid encoding. A textbook encoding-collision bug that only shows up for the
first process group in the system.

## Verification

- test_tty.js: 27 line-discipline/routing checks against the real SAB ring
  (the test plays both bridge and consumer).
- test_tty_e2e.js: real C driven interactively by a scripted bridge with
  marker-based sequencing (no timing races): canonical fgets with live
  erase editing, ^C interrupting a blocked read() (EINTR + handler),
  cfmakeraw + 3 single-byte raw reads (unechoed), SIGWINCH + TIOCGWINSZ
  after a resize, EOF, isatty=1 — 15 checks, green on first full run.
- Full suites: kernel green, units 694/0, spawn parity, BlockFS green.

Next: `todos/0003` (pipes + job control) or `todos/0004` (os/ page +
protoshell — the tty now makes an interactive boot actually pleasant).
