# 0007 — window manager / compositor: design doc

- **Status**: DONE 2026-07-07 — the design doc landed as `todos/WM.md`
  (dev log: `logs/2026-07-07/wm-design.md`); implementation spikes queued
  as `todos/0012`.
- **Depends**: 0004 (a booting OS page to design against)
- **Design**: `todos/WM.md`; groundwork in `todos/OS.md` (Phase 3) and
  `todos/KERNEL.md` (WM extension, 0x1xxx opcodes reserved)

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

## Hard requirements (OS.md "agent-friendly by construction")

- **Headless surface screenshot** as a kernel op: read any surface's pixels
  without a display (shm transport makes this free); PNG encoding in the
  harness. WebGPU surfaces via readback where possible.
- **Agent control channel**: enumerate windows (id/title/geometry/z/focus),
  focus, synthetic key/pointer input targeted at a window, screenshot —
  same protocol from the outside (test harness/agent) and inside (wmctl).
- **Win95-ish management** as the reference WM look: overlapping windows,
  decorations, taskbar — deterministic layout is an agent feature too.
