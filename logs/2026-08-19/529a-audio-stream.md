# #722 — #529-A: device-less SDL_AudioStream + SDL_MixAudio

Lane `lane/722-sdl-audio-stream`, base `9af3d6d7ec7eb985470e9293775e3a38e3b0f91a`
(verified equal to `origin/main` at start). Governing design: the reviewed
superseding proposal `~/git/meta/meta/notes/cc-529-proposal-superseding-2026-08-19.md`
(GREEN verdict `01a01727-1887-7a3a-bd66-f39e674075dc`). Classification:
`feature-gap`.

## Pre-change REDs (captured on the exact base)

`node compiler.js /tmp/red-722.c` at `9af3d6d7`, verbatim:

```
Got 8 parse errors in /tmp/red-722.c.
/tmp/red-722.c:5: error: Undeclared identifier 'SDL_CreateAudioStream'
/tmp/red-722.c:5: error: incompatible types: cannot implicitly convert 'int' to '*struct SDL_AudioStream'
/tmp/red-722.c:6: error: Undeclared identifier 'SDL_SetAudioStreamFormat'
/tmp/red-722.c:7: error: Undeclared identifier 'SDL_GetAudioStreamFormat'
/tmp/red-722.c:9: error: Undeclared identifier 'SDL_GetAudioStreamData'
/tmp/red-722.c:10: error: Undeclared identifier 'SDL_GetAudioStreamAvailable'
/tmp/red-722.c:11: error: Undeclared identifier 'SDL_FlushAudioStream'
/tmp/red-722.c:12: error: Undeclared identifier 'SDL_MixAudio'
```

All seven public symbols RED, then GREEN after the implementation commit.
Generated-absence bookkeeping (the PRINCIPLES.md two-sided edit): none of the
seven was pinned absent anywhere; the one adjacent absence entry
(`tools/mksdlindex.js` "Audio files & mixing") still pins `SDL_LoadWAV` +
`Mix_OpenAudio` absent (they stay absent — #723/#529-C) and its advice text
was rewritten because "one stream per concurrent sound" stopped being the
recommended mixing story in the same change.

## Upstream pin (the oracle)

`libsdl-org/SDL` tag `release-3.4.0`, commit
`a962f40bbba175e9716557a25d5d7965f134a3d3` (clone verified). Files consulted,
SHA-256:

```
4607085ac696114ada9f6b2f9c9abd3341e5e619177299df8abcfd330e6a7861  src/audio/SDL_mixer.c
9977ebeff2960c28c766c038b21e352176a8335d733d7eaf97b787ff04578042  src/audio/SDL_audiocvt.c
c0cd4b0f63056525aa67ee78f6502ecc55c0cfd851d32175d1513259260697c4  src/audio/SDL_audiotypecvt.c
331c46daec97d3914541709704b389cd1094e961971d7d50bd15274393b28cd1  src/audio/SDL_audio_channel_converters.h
abf54f199624c761ee747aea3bc2b9dabefadcc8c86e8dabccd1faa4e7d57cb9  build-scripts/gen_audio_channel_conversion.c
ccedbc4da28c667cf537dd6eea9cd2435fdd8643dee34cd7bbfdaf170e18d8e6  src/audio/dummy/SDL_dummyaudio.c
```

Pinned facts adopted verbatim:

- **SDL_MixAudio** (`SDL_mixer.c`): `volume = (int)SDL_roundf(fvolume * 128)`,
  0 = successful no-op, NO volume clamp (negative inverts, >1 amplifies),
  truncating integer scaling `(s*v)/128` with sample-type cast wrap, U8 via
  the `mix8` bias table (implemented as its arithmetic equivalent
  `clamp(dst + adj − 128, 0, 255)` — identical values, no 511-byte table),
  F32 scales by the RAW float volume, forward per-sample iteration (overlap
  behavior pinned by construction).
- **Validation** (`SDL_audiocvt.c`): five formats, channels 1..8, `freq > 0`
  with no maximum; both sides validated BEFORE either mutates (atomic Set);
  a device-bound stream's device side is quietly NULLed AFTER validation
  (an invalid ignored side still refuses). Upstream's exact error strings
  ("Stream has no source format", "Can't add partial sample frames",
  `SDL_InvalidParamError("src_spec->format")`, …) are reused.
- **GetFormat**: fills outputs first (zeroed spec for an unset side), then
  errors on the unset side, source first. NULL/NULL = validity query.
- **Sample codecs** (`SDL_audiotypecvt.c`): decoders are the arithmetic
  equivalents of upstream's bit tricks (exact — all scales are powers of
  two); the four float→int encoders are upstream's scalar bodies verbatim
  (round-to-nearest-even + saturation via the pinned bit manipulation).
- **Channel matrix**: the 56 non-identity converters were mechanically
  re-emitted from the generated header as one per-frame `switch` of direct
  assignments — same coefficients, same ascending-source accumulation order
  (bit-identical to upstream's scalar converters). The unit oracle
  re-derives expectations from the GENERATOR's FAudio table
  (`gen_audio_channel_conversion.c`) — a second, independent transcription
  path from the same pin, so a mistranscription on either path fails the
  sweep. A `switch`, not upstream's function-pointer table, deliberately:
  address-taken functions root the wasm tree-shake, and a table would weld
  all 56 converters into every SDL binary forever.
- **No-sink destination format**: SDL's dummy driver returns "we're good;
  don't change reported device format" — the requested spec IS the device
  format. The null/hook-less hosts answer the new dst query the same way.

## Shape decisions (and every deliberate divergence)

- **Resampler**: persistent-phase linear interpolation with an exact
  integer-rational phase (output frame k of an epoch samples source position
  `k*src_freq/dst_freq`; fraction = `(k*sf) % df / df`). Chunk-boundary
  invariance is by construction, not by carried float state. This is the
  proposal's documented algorithm, NOT upstream's polyphase resampler — no
  quality-mode claim is made.
- **Unflushed holdback**: an epoch emits `floor((N-1)*df/sf) + 1` frames
  un-flushed (the interpolation lookahead is held until more input or a
  flush); a final epoch emits `ceil(N*df/sf)` with hold-last-frame
  extrapolation. An epoch that can no longer grow (a newer epoch follows it)
  is treated as final so no queued byte is ever stranded.
- **No materialized-output extents**: GetData converts exactly what the
  caller's buffer holds (whole head-epoch frames), so the proposal's
  "already materialized output" set is empty by construction — the stronger
  property. The Available oracle's "pending materialized output" leg is
  therefore replaced by the fingerprint proof that short reads leave no
  hidden state (`__sdl_audiostream_fp`, extent/ledger allocation counter
  included).
- **Available on unset formats returns −1 with the SDL error** (the
  proposal's explicit rule). Upstream returns 0 there (with the same error
  set); the proposal governs. Divergence recorded here and in the header.
- **Epoched destination**: queued bytes are encoded with their CAPTURED dst
  spec; upstream converts everything not yet read to the CURRENT dst spec at
  read time. The proposal pins the epoch semantics ("callers that mutate
  destination format with pending output accept the documented sequential
  format transition"); documented in `<SDL.h>` and sdl-gucos.md.
- **Flush requires both sides set** (proposal rule; upstream's flush skips
  the check). MEMORY flush is an idempotent generation marker, never EOF.
- **DEVICE GetData/Available are refused with named errors**: the converted
  side of a device stream lives in the SAB ring/kernel — bytes cannot be
  handed back. Reading them back would be a lie; refusal is the honest
  shape. `SDL_GetAudioStreamQueued` is the device-side instrument.
- **DEVICE identity puts stay byte-oriented** (the pre-#529 pinned contract,
  `tests/unit/sdl_audio_queue`'s 1-byte put): the ledger's identity nodes
  retire byte-for-byte, so Queued is byte-identical to the old ring+backlog
  number for every existing caller. A source-format CHANGE with a dangling
  partial device frame is refused with a named error (a change would shift
  every later frame boundary in the byte stream); converted-epoch puts are
  frame-aligned like MEMORY puts.
- **MixAudio validates pointers/format/len-alignment** (proposal-mandated;
  upstream silently truncates a misaligned len). Volume/overlap behavior is
  pinned, not re-invented.
- **`SDL_MixAudio` keeps `volume` quantization in f32** exactly as upstream
  (`fvolume * 128.0f`, round half away from zero).
- **Reconcile never over-retires**: acknowledged device bytes that stop
  between conversion-node frame boundaries carry to the next reconcile
  (`ack_carry`); host consumption is frame-aligned in both shipped consumers
  (kernel pump consumes whole source frames; the page receiver drains whole
  frames), so the carry is a backstop, not a path.
- **Destroy cancels**: one final reconcile, then every unsubmitted C-side
  byte (input extents, converter carry, converted backlog, receipts) is
  discarded WITHOUT a pump; only SAB-accepted bytes reach `AUDIO_CLOSE` and
  the kernel's dying-source drain. The undersized-ring e2e pins this to the
  byte.
- **The headed copy tap was NOT built**: the proposal makes it conditional
  ("If headed evidence is required") and the deterministic `audioInit()` SAB
  capture is the primary oracle everywhere in this tranche. kernel.js's only
  change is the AUDIO_OPEN response gaining the sink spec (a read-only fact;
  production audio bytes unchanged).
- **`__sdl_audio_dst_query(dev, sel)`** uses per-scalar selectors instead of
  an out-pointer struct because the null-SDL host flavor has no memory
  handle; three tiny calls at open only.

## Zero-bytes acceptance — measured

Instrument: `/tmp/sdlmin.c` (SDL window + ticks, NO audio API), identical
source compiled on base and tip.

| build | base | tip | delta |
|---|---|---|---|
| sdlmin `--gc-sections` | 11305 B, sha `3c359cd7…` | 11305 B, sha `3c359cd7…` | **byte-identical (zero)** |
| sdlmin default flags | 26024 B | 27782 B | +1758 B |
| sdl_audio_queue (DEVICE user) default | 28011 B | 47124 B | +19113 B (A is referenced) |
| sdl_audio_queue `--gc-sections` | 14055 B | 31839 B | +17784 B (A is referenced) |
| compile time (sdlmin, warm) | 0.24 s | 0.26–0.27 s | +~10 % |

The unreferenced case is exactly zero under `--gc-sections` (the
whole-program shake). The +1758 B default-flag delta is NOT new code — the
wasm-level tree-shake drops every unreferenced function body — it is the
rodata literals (error strings) of AST-live-but-wasm-dropped functions, a
pre-existing compiler behavior class that every existing `__SDL.c` function
already exhibits (e.g. the pull-mode refusal text rides every SDL binary
today). All #722 bulk data lives in CODE (the channel matrix is immediates
in a switch), precisely so this class stays capped at strings. Closing the
literal-leak class generally (pruning data segments owned by dropped
functions, or defaulting the bake to `--gc-sections`) is a compiler-wide
follow-up, deliberately NOT smuggled into this lane; flagged for the
reviewer/coordinator to file if wanted.

The DEVICE-user growth is real referenced machinery: a device stream's put
path now reaches the epoch converter (a later `SDL_SetAudioStreamFormat`
may convert), which links the 56-case channel switch whether or not the
program ever converts. If that ~13 KB matters later, splitting the matrix
behind a runtime-reachability seam is possible without API change.

## Performance (percentiles, 300 iters, 4096-frame blocks, this box)

```
convert s16/44.1k->f32/48k 4096fr:        p50 57us  p95 59us  p99 138us (287 MB/s)
convert s16-5.1/44.1k->f32-st/48k 4096fr: p50 111us p95 121us p99 139us (442 MB/s)
passthrough f32/48k 4096fr:               p50 1us   p95 1us   p99 1us   (memcpy path)
mix f32 4096fr:                           p50 10us  p95 10us  p99 84us
mix s16 4096fr:                           p50 11us  p95 11us  p99 12us
```

4096 frames ≈ 85 ms of 48 kHz audio converted in ~0.06–0.11 ms — roughly
1000× realtime; a game mixing music+SFX per frame spends ~20 µs in this
path. Memory/epoch churn: put coalesces into the tail extent (doubling
growth), conversion compacts the consumed prefix past 64 KB, so a
long-running same-spec stream holds a bounded window (no unbounded state).

DEVICE pump regression (kernel.js untouched on the pump path; AUDIO_OPEN
response only): interleaved A/B runs of a full-ring 3840-frame pump,
p50 33.2–33.8 µs (base) vs 34.0–34.4 µs (tip) ≈ +2 %, inside noise and well
under the ≤10 % candidate budget.

## Tests

- `tests/unit/sdl_audio_stream_convert` — the 5×5 format × 8×8 channel × 3
  rate sweep (4800 conversions) against the INDEPENDENT JS oracle
  (`gen-expected.mjs`, coefficients re-derived from the pinned generator
  table; fround float mirror; pinned encoders re-implemented on bits) plus
  chunk-invariance, saturation, and the hold-last tail. Matched
  byte-for-byte on the first run.
- `tests/unit/sdl_mix_audio` — hand-derived pinned-semantics golden.
- `tests/unit/sdl_audio_stream_state` — 61-assertion state matrix incl. the
  Available oracle (fingerprints, control stream, >INT_MAX clamp with zero
  allocation) and exact Queued retirement.
- `tests/unit/sdl_audio_device_stream` — null-host device contracts.
- `tests/kernel/test_audio_e2e.js` (existing member, no registry change) —
  tones (two source formats/rates converted, SDL_MixAudio'd into ONE device
  stream, both spectral contributions by exact-bin Goertzel, clamp pinned at
  1.0), the undersized-ring destroy oracle (bit-exact prefix, no backlog
  leak, reclaim, fresh-open playback), and the three-epoch ledger model with
  partial frame-aligned drains (exact Queued at every stop). Flake gate:
  `--repeat 3 --under-load` → 3/3 stable.
- Pre-existing pins kept green untouched: `sdl_audio_queue` (byte-oriented
  puts, unbounded queue), `sdl_audio_callback_pull_rejected`.

## Files

`compiler.js` (SDL.h decls + the #529-A engine in `__SDL.c`), `host.js`
(the dst query in all four SDL flavors), `kernel.js` (AUDIO_OPEN sink spec
in the response), the four unit dirs, `tests/kernel/test_audio_e2e.js`,
`tools/mksdlindex.js` + regenerated `os/doc/sdl-api-index.md`,
`os/doc/sdl-gucos.md`, `os/image.json` (v274).
