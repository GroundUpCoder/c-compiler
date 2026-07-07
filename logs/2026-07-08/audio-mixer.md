# 0017 — audio mixing: the kernel sound server

**What landed**: windowed OS apps are audible. Per-process audio source
rings (SAB) register with the kernel via new `AUDIO_OPEN`/`AUDIO_CLOSE`
RPCs (0x2xxx); `Kernel.audioPump()` mixes every active stream —
linear-interp resample to 48k, mono fan-out, float sum, clamp — into ONE
page-owned f32 output ring (`Kernel.audioInit()`), which os.html plays
with host.js's existing `createAudioReceiver`, verbatim. Design section:
`todos/WM.md` "Audio mixing — the kernel sound server".

## Why it's shaped this way

- **Reuse the standalone ring layout on every ring.** Source rings and the
  output ring are all `createSharedAudioBuffer`'s 16-byte-header format.
  The process-side producer is the SAME code as the standalone path
  (`audioRingPush`, factored out of `createBrowserSDL.__sdl_queue_audio`),
  and the page-side consumer is the UNMODIFIED `createAudioReceiver` fed
  one synthetic `audio-open`. Only the mixer in the middle is new.
- **The `wm-sabs` handshake, verbatim.** The kernel can't hand a SAB to a
  parked worker, so the process allocates and posts `{type:'audio-sab'}`
  immediately before the RPC that names it — same-FIFO pairing, no races.
- **Mixing is pure math in kernel.js** — no timers, no Web Audio. The
  embedder schedules it (kernel-worker: 20ms setInterval; tests: explicit
  frame budgets). That's what makes the acceptance test deterministic:
  `test_audio.js` asserts EXACT float values for passthrough, resample
  interpolation, mono fan-out, two-stream sum, clamp, and cursor carry.
- **Pump pacing: top up to ~80ms, bounded by the MOST-available stream.**
  A starved app pads with silence next to a healthy one (doom can't stall
  gameboy), but a lone app never has silence manufactured ahead of data
  that's about to arrive. Apps self-pace against
  `SDL_GetAudioStreamQueued` (ring + C backlog), so a stalled consumer —
  page pre-gesture, headless with no pump — costs bounded memory, exactly
  like the standalone page before its resume click.

## Gotchas hit

- **readPos derivation needs frame-aligned production.** The mixer derives
  its read position as `writePos - queuedBytes` (the standalone
  receiver's trick). A producer accepting a PARTIAL frame when the ring
  is nearly full would shift that derivation off frame boundaries — so
  the surface-flavor producer rounds accepts DOWN to whole frames
  (`audioRingPush`'s `alignBytes`); the C `SDL_AudioStream` backlogs the
  remainder, FIFO preserved. First cut derived readPos from
  `writePos - wholeFrames(queued)`, which is wrong the moment a partial
  tail exists — caught in review before it ever ran.
- **`SDL_ClearAudioStream` vs the consuming mixer** is a benign race: clear
  stores `queuedBytes = 0` while the pump may concurrently `Atomics.sub`.
  The pump clamps a negative back to 0 (worst case a clear drops a few
  already-mixed bytes — which is what clear means). Tested explicitly.
- **SDL3 devices open PAUSED.** The `playing` header cell is written by the
  producer in the mixer arrangement (the receiver writes it standalone) —
  doom/gameboy's `SDL_ResumeAudioStreamDevice` is what unmutes them. A
  dying paused ring can never drain, so close/exit drops those instantly.
- **Autoplay policy**: the AudioContext resumes on the first
  mousedown/keydown/touchstart on the page. Until then the mixer fills
  80ms of output and stalls; source rings fill; apps stop pushing. All
  bounded, all resumes cleanly on the gesture (verified in os-doom.mjs:
  output writePos advances only after the click).

## Lifecycle (the never-wedge rule)

`AUDIO_CLOSE`, exit, and SIGKILL all mark the stream *dying*; the pump
keeps mixing it until DRY (queued sfx tails finish — "drain"), then
reclaims. Paused or output-less dying streams drop immediately. Reclaim
runs inside the pump, same discipline as fd/surface reclaim in
`_exitProcess`. `test_audio_e2e.js` SIGKILLs a real C app mid-play and
watches the mixer drain + keep serving.

## Verification

- `tests/kernel/test_audio.js` — 45 exact-value checks over fake workers.
- `tests/kernel/test_audio_e2e.js` — real C SDL streams via compiler.js +
  worker_threads: AUDIO_OPEN handshake, two-stream mix (exact),
  self-pacing, SIGKILL drain.
- Suites: unit 697✓, kernel 24 files✓, blockfs✓, host✓ (incl.
  `test_audio_ring_wrap` over the refactored producer).
- Browser: os-boots✓, os-wm✓, os-gpubox✓, os-doom✓ — the last with new
  audio assertions (ring reaches the page, gesture resume, output ring
  advancing while doom's title music plays).

No image.json bump: no seeded C sources changed (the whole feature is
host/kernel-side; doom/gameboy binaries already NULL-checked and now just
succeed at `SDL_OpenAudioDeviceStream`).
