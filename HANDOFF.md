# Handoff — start of thread (updated 2026-07-08, after 0017 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**Windowed OS apps have sound.** This thread landed **0017**: the kernel
is now the sound server (design: WM.md "Audio mixing — the kernel sound
server"). Per-process source rings (same SAB layout as the standalone
audio ring) register via `AUDIO_OPEN`/`AUDIO_CLOSE` (new 0x2xxx opcode
block, `{type:'audio-sab'}` FIFO handshake = wm-sabs verbatim);
`Kernel.audioInit()` allocates ONE page-owned f32/48k output ring;
`Kernel.audioPump()` mixes — linear-interp resample, mono fan-out, sum,
clamp, pure deterministic math, scheduled by the embedder (kernel-worker:
20ms). os.html plays it with host.js's `createAudioReceiver` UNCHANGED
(page now loads host.js just for that), resumed on first user gesture.
host.js: `createSurfaceSDL` grew real audio imports (both flavors);
the producer is `audioRingPush`, factored out of createBrowserSDL —
standalone pages behaviorally untouched. Dev log:
`logs/2026-07-08/audio-mixer.md`.

Decisions made in 0017 (don't re-litigate): pump tops up to ~80ms bounded
by the MOST-available active stream (starved app pads silence, lone app
never gets silence manufactured ahead of its data); **surface-flavor
producer pushes whole frames only** (the mixer derives readPos from
writePos−queuedBytes — partial accepts would misalign it); clear() vs
pump is a benign store-0 race the pump self-heals; dying streams drain
dry then reclaim, paused/output-less dying streams drop instantly;
`os/boot.js` stays silent by design (no audioInit — apps self-pace, no
memory blowup); output format fixed f32 stereo 48k.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓ (incl.
test_audio_ring_wrap over the refactored producer), blockfs✓, kernel 24
files✓ (new: test_audio — 45 exact-value mixer checks; test_audio_e2e —
real C SDL streams, two-stream exact mix, SIGKILL drain), browser
os-boots✓ + os-wm✓ + os-gpubox✓ + os-doom✓ (grew audio-pipeline asserts:
ring reaches page, gesture resume, output writePos advances while doom's
music plays). No image.json bump (no seeded sources changed — v12 stays).

## The queue (todos/README.md is authoritative)

1. **`0018` quake windowed** — relative-mouse/pointer-lock surface flag +
   pak0.pak seeding (trivial via `bin` entries)
2. `0019` client resize (SURFACE_CONFIGURE)
3. `0020` wasm terminal + ptys
4. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- SDL3 audio devices open PAUSED; in the mixer arrangement the `playing`
  header cell is PRODUCER-written (`SDL_ResumeAudioStreamDevice` unmutes).
  The standalone receiver writes that same cell — layout shared, roles
  differ per arrangement.
- `tests/browser/www/host.js` is a stale tracked COPY of host.js used by
  the standalone spike pages — it is NOT auto-synced and was already ~650
  lines behind before this thread; left alone deliberately.
- Audio formats: the mixer decodes S16/S32/F32/U8/S8 CORRECTLY;
  `createAudioReceiver`'s legacy 0x8008 quirk is deliberately untouched
  (it owns only the output ring now, which is always F32).
- The e2e SIGKILL assert must keep draining the page side
  (`Atomics.store(outQueued, 0)`) in its poll loop or the 80ms target
  fills and dying streams never go dry.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v12 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP) ↔ os/wm_proto.h ↔
  test_wm_policy.js; audio ring layout in kernel.js (AU_*) ↔ host.js
  createSharedAudioBuffer/audioRingPush; SDL audio format words ↔
  <SDL3/SDL_audio.h> in compiler.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox after touching os/, kernel.js, host.js SDL/webgpu/fd/audio
  paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0014/0015/0016's decisions, 0017's decisions above.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: 0018 (quake windowed), a lingering item, or something else."
