# 0020 — wasm terminal + ptys

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/wasm-terminal-ptys.md`)
- **Depends**: 0019 (resizable windows — a fixed-size terminal isn't
  worth landing); the kernel tty (done, 0002)
- **Design**: `todos/WM.md` ("The terminal"); `todos/KERNEL.md` (pty pairs
  wait for exactly this consumer)

## Goal

The pure-path terminal: a wasm terminal app on an SDL surface + a kernel
pty layer — xterm.js demotes to bootstrap chrome.

- Kernel pty pairs: master/slave OFD kinds over the existing tty line
  discipline (the machinery is there; ptys are the missing rendezvous).
- Terminal app: freetype (vendored) text rendering into an shm surface;
  escape-sequence state machine scoped to what hush + vi actually need,
  not full vt100 on day one.
- Resize (0019) drives SIGWINCH / TIOCGWINSZ reflow.

## Plan (sub-items, this session)

1. **Kernel pty layer** (kernel.js):
   - `PTY_CREATE` (0x0105) → master OFD kind `ptm` + slave OFD kind `tty`
     over a fresh brokered `Tty` (line discipline REUSED verbatim) plus one
     pipe-shaped slave→master output direction (`_streamRead`/`_pipeNotify`
     reused; echo pushes kernel-side like sockServe's peer.send).
   - Slave writes get OPOST/ONLCR processing, whole-or-block into the out
     dir (256K cap so a split \r\n can never wedge), EIO when master gone.
   - Master writes feed `tty.input()` (echo/signals/canon all for free).
   - Lifecycle: master close → SIGHUP to the pty's fg pgroup + slave EOF;
     slave close (last ref anywhere) → master read EOF. SIGKILL-safe via
     the existing `_exitProcess` fd release.
   - Per-Tty read-waiter queues (the global `_ttyWaiters` becomes
     `tty.waiters` — multiple ttys now exist).
   - fd-aware termios: TCGETATTR/TCSETATTR/TCGETPGRP/TCSETPGRP resolve the
     tty through the caller's fd table (fallback: `pcb.tty` — ring mode and
     old callers keep working). `TIOCSWINSZ` (0x0106) → `tty.resize` →
     SIGWINCH.
   - Spawn attaches `pcb.tty` from the child's post-actions fd 0 (slave →
     that pty; ttySab/TIOCGWINSZ follow), first attach claims fgPgid.
2. **Process side**: RemoteFS `openpty`/`setWinsize`; toWasmEnv grows
   `__openpty` + `__ioctl_tiocswinsz` (ENOSYS/ENOTTY without a kernel);
   `__tty_*` env passes the real fd through the hooks. compiler.js:
   `<pty.h>` (openpty), TIOCSWINSZ in `<sys/ioctl.h>`.
3. **Terminal app** `os/term/` (bin.json project over vendor/freetype):
   SDL shm surface, freetype glyph cache (robotomono), escape parser
   scoped to hush lineedit + busybox vi (CUP/CUU-CUB/ED/EL/SGR/DECSTBM/
   IL/DL/ICH/DCH/alt-screen 1049/?25), SDL key → bytes (SDL3 keysyms are
   modifier-applied), WINDOW_RESIZED → grid realloc + TIOCSWINSZ.
   Seeded as `/bin/term` + `/etc/fonts/mono.ttf` (image.json v15).
4. **Tests**: tests/kernel/test_pty.js (SAB protocol, fake workers);
   test_term_e2e.js (headless boot: `term &`, keys via WM inject, shot
   pixel assertions, vi-in-term file roundtrip, resize ack); browser
   os-term.mjs (manual).

## Acceptance

- `term &` opens a windowed terminal running hush on a pty; vi works
  inside it; drag-resize reflows.
- Headless: pty semantics driven by kernel tests; terminal screenshot
  shows rendered text (shm, bit-exact).
