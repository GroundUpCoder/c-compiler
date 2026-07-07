# 0017 — audio mixing (the kernel sound server)

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/audio-mixer.md`)
- **Depends**: 0015 (the concurrent-audio consumers: doom, gameboy)
- **Design**: `todos/WM.md` ("Audio mixing — the kernel sound server");
  `todos/KERNEL.md` (SAB ring patterns); host.js audio ring

Landed: per-process source rings (AUDIO_OPEN/AUDIO_CLOSE, 0x2xxx) +
kernel-side mixer (`audioInit`/`audioPump` — linear-interp resample, mono
fan-out, sum + clamp into one page-owned f32/48k output ring, played by
the existing `createAudioReceiver`), drain-on-exit/SIGKILL lifecycle.
Suites: `tests/kernel/test_audio.js` (deterministic exact-value mixes) +
`test_audio_e2e.js` (real C SDL streams); browser `os-doom.mjs` grew the
audio-pipeline assertions (ring to page, gesture resume, output advancing
while doom's music plays).

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
