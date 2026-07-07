# 0020 — wasm terminal + ptys

- **Status**: queued
- **Depends**: 0019 (resizable windows — a fixed-size terminal isn't
  worth landing); the kernel tty (done, 0002)
- **Design**: `todos/WM.md` ("The terminal"); `todos/KERNEL.md` (pty pairs
  wait for exactly this consumer)

## Goal

The pure-path terminal: a wasm terminal app on an SDL surface + a kernel
pty layer — xterm.js demotes to bootstrap chrome. Multi-session item;
split into sub-items when started.

- Kernel pty pairs: master/slave OFD kinds over the existing tty line
  discipline (the machinery is there; ptys are the missing rendezvous).
- Terminal app: freetype (vendored) text rendering into an shm surface;
  escape-sequence state machine scoped to what hush + vi actually need,
  not full vt100 on day one.
- Resize (0019) drives SIGWINCH / TIOCGWINSZ reflow.

## Acceptance

- `term &` opens a windowed terminal running hush on a pty; vi works
  inside it; drag-resize reflows.
- Headless: pty semantics driven by kernel tests; terminal screenshot
  shows rendered text (shm, bit-exact).
