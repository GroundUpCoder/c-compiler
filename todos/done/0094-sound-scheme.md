# 0094 — Sound scheme — startup chime + event sounds

- **Status**: done 2026-07-11 (image v55; log
  `logs/2026-07-11/0094-sound-scheme.md`). Landed: `os/sounds.h` (the
  ONE header-only scheme core — store resolution, mute, WAV parse,
  drain-dry fire-and-forget), real `PlaySoundA/W` in winmm.c,
  `MessageBeep` + MessageBox icon beeps in user32.c, the wm.c
  SystemStart boot chime, four synthesized clips (`tools/mksounds.js` →
  committed `os/sounds/*.wav`, baked to `/usr/share/sounds/` + the
  `scheme` map), the ctlpanel Sounds applet (mute checkbox writing
  `~/.config/sounds` with carry-forward + Test), and the 0017 pump's
  spent-tail reclaim fix (a dying stream's non-integer-ratio resample
  tail wedged forever — one leaked table entry per one-shot clip).
  Tests: `tests/kernel/test_sounds_e2e.js` (registered in run.js),
  ctlpanel-e2e Sounds legs, `tests/browser/os-sounds.mjs` (the browser
  acceptance lives there, not os-shell.mjs — the post-0081 sweep
  shape), a `test_audio.js` stranded-tail case. Residue owned:
  **0113** (preset schemes, per-event applet UI, SND_LOOP — v1 plays a
  looped clip once; SND_RESOURCE stays 0068's silent success so
  winmine's timer tick can't ding), **0064** (the operator LISTEN check
  — the clips are synthesized and untuned by ear).
- **Design**: `todos/WIN32.md` (WINMM `PlaySound`), the 0017 audio mixer
  (`__audio_gain` / mixer opcodes) that ctlpanel already drives. A Sounds
  applet lands in Control Panel v2 (0089).

## Goal

Silence is a big part of why it doesn't *feel* like Windows — no startup
chime, no error *ding*, no *tada*. The audio path already exists (0017 mixer,
`winmm`), so this is cheap and high-nostalgia. Add an event-sound scheme.

## Plan

- **`PlaySound`** — implement the WINMM `PlaySound(name, flags)` entry in
  `os/win32/winmm.c` playing a WAV through the 0017 mixer (async, `SND_ASYNC`;
  `SND_LOOP` optional).
- **Event → sound map** — a scheme file (`/usr/share/sounds/scheme` or
  `/etc/sounds`) mapping named events to WAVs: SystemStart, SystemError (the
  MessageBox on MB_ICONERROR), SystemAsterisk, SystemExclamation, Default
  (menu/click optional). Ship a small set of short WAVs under
  `/usr/share/sounds/` in the image (`os/image.json`).
- **Wire the emitters** — startup chime on desktop-ready (`os/wm.c` / init);
  MessageBox plays the icon-appropriate sound (`os/win32/user32.c`); optional
  empty-trash / menu blips later.
- **Sounds applet** — a Control Panel (0089) applet to pick the scheme /
  mute events (distinct from master volume, which is the Sound applet).

## Non-goals (record, don't build)

- MIDI / the full Win95 `.wav` corpus — a handful of iconic events only.
- Per-app sound overrides or a scheme *editor* — pick from presets.
- Recording/synthesis — ship prebaked WAVs.

## Acceptance

- Headless: `PlaySound("SystemStart", SND_ASYNC)` submits a buffer to the
  mixer (assert the mixer received it); MessageBox(MB_ICONERROR) triggers the
  error event.
- Browser (`os-shell.mjs`): booting to the desktop plays the startup chime
  once; raising an error dialog plays the ding; muting events in the applet
  silences them.
