# 0094 — Sound scheme: startup chime + event sounds

**Item**: `todos/done/0094-sound-scheme.md` · **Image**: v54 → **v55**

Windows isn't Windows when it's silent. This lands the event-sound
scheme: a startup chime when the desktop comes up, MessageBox beeps by
icon, a real WINMM `PlaySound`, and a Control Panel Sounds applet with a
mute toggle — all over the existing 0017 kernel mixer, no kernel opcode
changes (one pump fix, below).

## Shape: one header-only core, two consumers

The policy lives in **`os/sounds.h`** (the openwith.h/fileops.h
precedent — wm.c is not a win32 app, so the shared code can't live in
the veneer):

- **Store**: first existing of `~/.config/sounds`, `/etc/sounds`,
  `/usr/share/sounds/scheme` — whole-file, `EVENT<ws>WAV-PATH` lines,
  case-insensitive keys. `none` silences one event *explicitly* (no
  default fallback); the reserved key `mute on` silences everything.
  `snd_set_mute` rewrites the user store with the effective table
  carried forward (ow_set verbatim), so baked mappings survive the
  first write.
- **Playback**: parse the WAV (PCM u8/s16, mono/stereo, 4k–192k — the
  AUDIO_OPEN limits), open an SDL3 audio stream at the *clip's* spec
  (the mixer resamples), push the whole clip, resume, destroy.
  Fire-and-forget works because AUDIO_CLOSE marks the kernel stream
  dying and dying streams *drain dry* before reclaim — no process-side
  pump needed. Pumpless kernels (headless boot.js) drop the clip on
  close: silent by design, never an error. Clips must fit the 256 KB
  source ring (~5.9 s at 22050 mono s16); ours are ≤ 2.2 s.

Consumers: `os/wm.c` plays `SystemStart` right after `make_bar()`
(per wm start, deliberately — a `wm &` respawn is a new logon);
`os/win32/winmm.c` implements PlaySound over it; user32's new
`MessageBeep` (icon nibble → Win95 alias) rides PlaySoundA, and
`MessageBox` calls MessageBeep(type) at open, so every dialog in the
system beeps its icon with zero per-app work.

## The PlaySound contract (winmm.c)

One current sound per process; a new play stops it (clear + destroy =
instant reclaim), `SND_NOSTOP` refuses instead while frames are queued.
Name resolution: `SND_FILENAME` path / `SND_MEMORY` image /
alias-by-default; unknown alias falls back to `SystemDefault` unless
`SND_NODEFAULT`; an alias mapped `none` (or a muted scheme) returns
TRUE silently. `SND_SYNC` polls the queue capped at clip duration +
250 ms — the cap matters because a pumpless kernel never drains, and
the poll is `usleep`, **not** `SDL_Delay`, which throws by design in
this runtime (found the hard way: the e2e's SYNC phase crashed the
process). Deliberate cuts, recorded in 0113: `SND_RESOURCE` stays
silent success (the 0068 decision — winmine's per-second timer tick
must not become a default-ding metronome), `SND_LOOP` plays once.

Gotcha for future readers: `SND_RESOURCE` is `0x00040004` — it
CONTAINS the `SND_MEMORY` bit, so the test is `(flags & SND_RESOURCE)
== SND_RESOURCE`, never a truthy `&`.

## The clips are synthesized

Real Windows media is copyrighted, so `tools/mksounds.js` synthesizes
four clips (bell-partial + pad additive synthesis, pure deterministic
math → byte-identical re-runs) committed under `os/sounds/` (~215 KB,
the robotomono.ttf precedent) and baked to `/usr/share/sounds/` by
image.json v55: `startup.wav` (rising D-major arpeggio over a pad),
`chord.wav` (stern minor cluster = SystemHand), `ding.wav`
(SystemDefault/Asterisk/Question), `chimes.wav` (SystemExclamation).
Nobody has *heard* them yet — the listen check is on 0064's operator
checklist next to the pointer-lock one.

## The kernel bug this flushed out: the stranded resample tail

The one kernel.js change beyond docs. A dying stream was reclaimed only
at `queued == 0` — but at a non-integer resample ratio the fractional
cursor strands the last source frame(s): `avail = floor((srcFrames -
frac)/ratio)` hits 0 with `queued > 0`, forever. Continuous apps
(doom) never hit it (they die with either lots of data or a paused
ring), but every one-shot PlaySound clip ended as a wedged dead entry
in `_audioStreams` — a slow leak, one per ding. Fix: in the pump's
snapshot loop, a **dying** stream that can't back one more output frame
is *spent* → reclaimed; live streams keep their tail (the next push
extends it). New exact-value case in `tests/kernel/test_audio.js`
(pushes 5 frames at 22050, closes, proves 2 stranded bytes reclaim);
WM.md's Lifecycle paragraph now defines "dry" accordingly.

Also new: `SDL_AUDIO_U8` was missing from the builtin SDL header
(compiler.js) — host and kernel always supported format 0x0008.

## ctlpanel: the fifth applet

"Sounds" (label distinct from the "Sound" volume knob; class
`CplSndScheme` so the ctlpanel e2e's `/CplSound/` negative regex can't
substring-match it): an Enable-event-sounds AUTOCHECKBOX driving
`snd_set_mute`, plus a Test button (PlaySound SystemDefault). The e2e's
hub keyboard leg now presses Right twice — Sounds sits between Sound
and System.

## Tests

- `tests/kernel/test_sounds_e2e.js` (registered in run.js — the 0108
  orphan lesson): a real win32 app under a direct kernel seeds its own
  scheme + WAVs into its private fs, with **distinct frequencies per
  phase** so `kernel.audioList()` tells the phases apart (alias 22050,
  default-fallback 8000, filename 11025, memory 16000, SystemHand
  32000). 16 checks: flags, mute store, MessageBeep, MessageBox beep,
  SYNC drain-dry, SIGKILL teardown.
- `tests/kernel/test_ctlpanel_e2e.js`: +4 Sounds-applet checks (store
  write + carry-forward proven via `cat` on the tty).
- `tests/browser/os-sounds.mjs` (auto-discovered by os-sweep): chime
  mixed into the output ring BEFORE any gesture (autoplay holds
  playback, not mixing), plays out once after the resume gesture,
  About-box beep advances the producer cursor, applet mute freezes it,
  unmute + Test plays. Flake trap fixed during the run: wm's worker
  boots ~1 s after the page's `ready`, so the first assert *waits* for
  ring bytes instead of sampling instantly.

Full kernel suite green (51 files); os-sounds ALL OK standalone.

## Residue → owners

- 0113 (new, P2): preset schemes + per-event applet UI + SND_LOOP.
- 0064 (existing): the human listen check.
- Browser acceptance lives in the new `os-sounds.mjs`, not os-shell.mjs
  as the item guessed — a dedicated file is the post-0081 sweep shape.
