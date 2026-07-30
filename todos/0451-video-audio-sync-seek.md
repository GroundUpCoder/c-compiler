# 0451 — Video audio, A/V sync and seek: AudioDecoder into the mixer ring, audio-master clock

- **Status**: open
- **Design**: this ticket. Origin: the gucOS video-player viability investigation (2026-07-30),
  commissioned by jku and reported to him by email.
- **Difficulty**: medium. **Run this lane on Fable** (jku's call for this stream).
- **Blocked by**: 0450 (the player). **Stream**: C of A→B→C (+D).

## Goal

Give the 0450 player **audio, A/V sync and seek**: `AudioDecoder` output into the existing mixer
source ring, an **audio-master clock**, late video frames dropped, and working seek.

## Plan

1. **`AudioDecoder` → the existing mixer source ring** (48 kHz stereo f32). Follow the `AUDIO_OPEN`
   and audio-sab precedent already in the kernel — do not invent a second audio path.
2. **Audio-master clock.** The audio clock is the reference; **video follows it**. Video is the
   cheap thing to correct and audio glitches are the expensive thing to hear.
3. **Drop late video frames** rather than queueing them (and close them — a held frame stalls the
   decoder).
4. **Seek**: reset both decoders, resync to the new audio position.

## Acceptance

1. An MP4 with H.264 video and audio plays with **both** streams, through the existing mixer ring —
   no parallel audio path added.
2. Sync is proven, not asserted: measure drift over a sustained play (state the duration and the
   measured drift) rather than reporting "looks in sync".
3. Late frames are **dropped and closed**; sustained playback under induced load does not stall the
   decoder or desync the audio.
4. Seek works to an arbitrary position, resyncs, and does not leak decoder resources across repeated
   seeks.
5. If audio decode is unavailable for a given codec, the player still plays **video** and says why
   audio is absent — silence with no explanation is not acceptable (see 0452's fail-loud rule).

## Notes for the lane

- 🔴 **Grep for symbols; never trust a cited line number.** Re-derive every anchor at spawn.
- 🔴 Per **(FA)**, re-run each acceptance arm at spawn and report which were already green.
- Work in a **worktree** (`~/worktree/c-compiler/<slug>`), one repo.
- On a `todos/queue.json` rebase conflict: **drop your own close commit and re-run
  `node todos/queue.js done 0451`** on the new base, verify the staged blob, **never hand-merge**.
