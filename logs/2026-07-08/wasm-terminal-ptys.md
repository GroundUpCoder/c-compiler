# 0020 — the wasm terminal + kernel ptys

The pure-path terminal lands: `/bin/term`, an ordinary SDL surface app
holding a kernel pty master, rendering hush (and vi inside it) with
freetype into an shm framebuffer. xterm.js demotes to bootstrap chrome.
The todo item called this "multi-session"; it landed in one because the
existing machinery really did cover everything but the rendezvous —
KERNEL.md's "pty pairs wait for exactly this consumer" note was accurate.

## The pty design: the slave IS a Tty

The single decision that made this small: `PTY_CREATE` instantiates the
existing `Tty` class as the slave. Line discipline (ICRNL, canonical
editing, echo), termios, ISIG control-char → fg-pgroup signal routing,
deferred FS_READ service, select readiness — all reused verbatim, already
covered by test_tty.js. What's genuinely new:

- **The slave→master direction** is one pipe-shaped buffer (`{buf, cap,
  rOpen, wOpen, readWaiters, writeWaiters}`), so master reads/select ride
  `_streamRead`/`_pipeNotify` unchanged, and echo pushes kernel-side the
  way `sockServe`'s `peer.send` does (never blocks; closed master drops).
- **Slave writes get OPOST/ONLCR** processing per the pair's termios, and
  are **whole-or-block**: a partial landing could split a `\r\n`
  expansion, and the count reported to the writer must be in
  PRE-processed bytes. `_pipeNotify`'s write-waiter service grew
  `whole`/`n` fields (and an EIO-not-EPIPE flag) for this. PTY_OUT_CAP is
  256K so the worst RemoteFS chunk (60000 bytes, ONLCR-doubled) always
  fits eventually — the whole-write can never wedge.
- **Per-Tty read-waiter queues.** The kernel-global `_ttyWaiters` array
  assumed ONE tty; each Tty now carries its own `waiters` and the waiter
  record names its tty. Mechanical, but it's the one structural change
  the "many ttys" world forced.
- **fd-aware termios** (`_ttyForFd`): TCGETATTR/TCSETATTR/TCGETPGRP/
  TCSETPGRP resolve the tty THROUGH the caller's fd table (slave → its
  pty, master → same pair, std fds → system tty), falling back to the
  attached tty for fd-less callers and ring mode. This is what lets hush
  run raw-mode lineedit on a pty while the system tty stays canonical.
  The host env passes the real fd through the hooks now (the old
  `fd <= 2` gate on getattr/setattr is gone; pgrp never had it because
  hush parks the tty at fd 255 — todos/0005).
- **Spawn attachment**: after fd_actions, if the child's fd 0 is a pty
  slave, `pcb.tty` becomes that pty — the winsize SAB handed to the
  worker (TIOCGWINSZ stays a SAB read), control-char signals, and the
  SIGTTIN background-read gate all follow. First attach claims fgPgid
  (term spawns hush as a pgroup leader; hush then owns tcsetpgrp).
- **Lifecycle**: master close → SIGHUP to the pty's fg pgroup + slave
  EOF + slave-write EIO (pty semantics, deliberately not EPIPE/SIGPIPE);
  last slave ref anywhere (including SIGKILL teardown — kernel-owned
  fds) → master EOF after the buffer drains. Closing the terminal
  window is therefore exactly `exit(0)`: fd release does the rest.

New opcodes: `TIOCSWINSZ` 0x0105 (master resize → winsize words +
SIGWINCH via the existing `Tty.resize`), `PTY_CREATE` 0x0106. libc:
`<pty.h>` `openpty()` (`__openpty`), `TIOCSWINSZ` in `<sys/ioctl.h>`
(`__ioctl_tiocswinsz`); both env entries live on BlockFS.toWasmEnv (ENOSYS/
ENOTTY in-process) and light up through RemoteFS's `openpty`/`setWinsize`
RPCs — no process-worker bootstrap changes needed.

## The terminal app (os/term/)

A bin.json project over the vendored freetype (the sdl-demo already
proved SDL+freetype under this compiler). ~700 lines:

- **Glyph cache**: ASCII 32..126 rendered once at init (robotomono @14px
  → 8x18 cells; 80x24 = 640x432, fits the 800x500 default screen).
  Alpha-blend blits against per-cell bg — pure CPU, so headless
  screenshots are bit-exact.
- **Escape parser** scoped to hush lineedit + busybox vi under
  TERM=xterm-256color (verified against what test_vi_e2e.js pins):
  CUP/CUU..CUB/CHA/VPA, ED/EL, IL/DL/ICH/DCH/ECH, SU/SD, DECSTBM, SGR
  (16-color + 38;5/48;5 mapped to nearest-16 + bold/reverse), alt screen
  ?1049 (+?47/?1047), ?25, ?7, ?1 (DECCKM switches arrow encoding),
  DSR-6 and DA replies (written back to the master), OSC 0/2 →
  SDL_SetWindowTitle. Deferred-wrap (wrap_pending) semantics.
- **Keys → bytes**: SDL3 keysyms are modifier-applied characters
  (Shift+1 is '!' already — the SDL3.md decision pays off here), so
  printables pass through; Ctrl folds to control codes, Alt prefixes
  ESC, Backspace sends 0x7f (VERASE), named keys send CSI sequences.
- **Resize**: WINDOW_RESIZED → SDL_GetWindowSurface re-derive (0019) →
  grid realloc (top-left crop/pad, both screens) → TIOCSWINSZ → SIGWINCH
  → vi reflows. The 0019 renegotiation means the kernel only shows the
  new geometry once term presents at the new size — no torn frames.
- **Session end**: child reaped (WNOHANG poll per frame) or master EOF
  or window close → exit(0).

Seeding: `/bin/term` project entry + `/etc/fonts/mono.ttf` bin entry
(the freetype demo's robotomono), image.json → **v15**. `term cmd...`
runs an arbitrary program on the pty instead of /bin/sh.

## What the tests pin

- `test_pty.js` (62 checks, no wasm): pair semantics over the real SAB
  protocol — echo/ONLCR byte flow, fd-aware termios resolution (raw pty
  vs canonical system tty), TIOCSWINSZ→SIGWINCH + SAB words, spawn
  attachment (ttySab + fgPgid claim), select on both ends, SIGTTIN for
  background pty readers, whole-write blocking past the cap, and the
  close lifecycle in all three directions (master close, slave close,
  SIGKILLed slave holder).
- `test_pty_e2e.js` (real C): openpty/TIOCSWINSZ from `<pty.h>`, session
  scripted through a spawned child — winsize before/after, echo, pause()
  + SIGWINCH, master-close EOF for a read-parked child.
- `test_term_e2e.js` (acceptance, headless over os/boot.js): `term &`
  windowed at 640x432; injected SDL keys type `ls /bin` (shot pixel
  delta proves echo+output); **vi runs inside the terminal** (alt screen
  asserted by pixels, `:wq` file content asserted via the system shell);
  `wmctl resize` → geometry only changes at the SURFACE_CONFIGURE ack →
  post-resize shot at 500x260 still renders text; typed `exit` ends the
  session and the window disappears.
- `os-term.mjs` (browser, manual): the same flow through the real page —
  client-click focus, typing through the canvas key path, SE drag-resize,
  close box, shell survival.

## Gotchas found

- Playwright's `page.keyboard` into the desktop canvas works fine for
  the terminal (no pointer-lock-style permission gate — unlike 0018).
- busybox vi's lone-ESC keystroke needs air on both sides (read_key
  resolves ESC by timeout) — same pacing the vi e2e already used; the
  term e2e injects ESC as its own wmctl key with sleeps around it.
- The IDE's clangd flags os/term/term.c (`SDL.h not found` etc.) — noise;
  the headers are compiler.js built-ins, same as every vendored app.
