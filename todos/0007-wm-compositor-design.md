# 0007 — window manager / compositor: design doc

- **Status**: queued
- **Depends**: 0004 (a booting OS page to design against)
- **Design**: to be written (future todos/WM.md); groundwork in
  `todos/OS.md` (Phase 3) and `todos/KERNEL.md` (WM extension, 0x1xxx
  opcodes reserved)

## Goal

The design doc (not the implementation): compositor in the kernel/UI bridge
(per-process offscreen surfaces composited onto the canvas), WM as a wasm
client speaking a small control protocol, `SDL_CreateWindow` retargeted to
"create a surface" so every existing SDL vendor app becomes a windowed app
for free — that's the acceptance test to design toward.

## Must answer (from OS.md open questions)

- Surface pixel transport: shm framebuffer first vs WebGPU texture sharing.
- Input routing: focus ≈ foreground-pgroup analogy, keyboard/mouse capture.
- Who owns the terminal: xterm.js as privileged surface vs wasm terminal app.
- Decorations/hit-testing split between compositor and WM client.
