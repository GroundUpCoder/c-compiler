# 0002 — kernel Phase 3: the tty object + line discipline

- **Status**: queued
- **Depends**: 0001
- **Design**: `todos/KERNEL.md` (TTY and line discipline)

## Goal

The tty becomes a kernel object: full termios (replacing the 3-bit
`SI_TERMIOS` word and canned `__tcgetattr`), kernel-side canonical-mode
editing + echo, control chars routed as signals to the foreground pgroup
(Ctrl-C finally means SIGINT), SIGWINCH, tcsetpgrp/tcgetpgrp, and
stdin-read/select EINTR via the doorbell.

## Plan sketch

- tty SAB as the evolution of the live-stdin SAB (ring + fg-pgid word +
  termios block); UI-bridge protocol for feeding raw bytes/resizes into the
  kernel and rendering output/echo.
- tcgetattr/tcsetattr/tcsetpgrp/tcgetpgrp as 0x01xx RPCs; TIOCGWINSZ stays a
  SAB read.
- Background tty read → SIGTTIN (the stop class lands fully in 0003; only
  the detection/routing parts land here).
- host.js stdin paths park on the doorbell so tty input and signals share
  one wake channel.

## Acceptance

- tests/kernel: canonical vs raw transitions, erase/kill/EOF editing, echo
  bytes, VINTR→SIGINT to fg pgroup only, SIGWINCH, blocked read EINTR.
- A scripted fake UI bridge drives it all under Node (no browser needed).
