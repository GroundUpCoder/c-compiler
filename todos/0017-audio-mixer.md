# 0017 — audio mixing (the kernel sound server)

- **Status**: queued
- **Depends**: 0015 (the concurrent-audio consumers: doom, gameboy)
- **Design**: `todos/WM.md` ("Open questions" — audio mixing);
  `todos/KERNEL.md` (SAB ring patterns); host.js audio ring

## Goal

Today's audio ring assumes one process ↔ the page. Give the kernel a small
mixer — the sound-server analog of the compositor — so windowed apps are
audible.

- Per-process audio rings (SAB, same pattern as the existing single ring);
  kernel mixes into the one page-owned output ring.
- Short design section first (in WM.md or KERNEL.md): format/rate
  normalization, where mixing happens, lifecycle (process exit drains or
  drops its ring, never wedges the mixer).
- doom sfx+music and gameboy audio become audible in-OS.

## Acceptance

- Two processes playing simultaneously are both audible, no glitching or
  starvation.
- Process exit/SIGKILL reclaims its ring; the mixer keeps running.
- Headless: deterministic mix unit test (kernel-side mixing is pure math —
  no browser needed).
- doom in-OS has sound.
