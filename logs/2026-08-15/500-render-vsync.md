# #500 — SDL_SetRenderVSync / SDL_GetRenderVSync: honest vsync on the compositor tick

Lane `lane-500-vsync`, base `385981f1`. Classification: **feature-gap fill**
(the symbols were absent — honest, per PRINCIPLES.md — and this ticket is the
frame-pacing package LEAD under `epic:gamedev`).

## The motivation moved before the work started — re-measured, not quoted

Phase 1 re-ran the ticket's §5 dilemma table in a real Chromium `os.html`
session at `385981f1`, with the original #487 instrument adapted for the
post-#551 world (every blocking-loop row must opt into the `"software"`
renderer now — the GPU default refuses blocking presents at exit 69, verified
live in the same session):

| row | 2026-08-04 | 2026-08-15 |
|---|---|---|
| POLLFLOOD (sw, unpaced) | 20,290 presents/s | 8,424 presents/s |
| DELAY16 | mean 21.47 ms | mean 16.15 ms |
| LOOP16 (textbook `SDL_Delay(16)`) | 46.17 fps | 61.12 fps |
| PACER16 (hand-rolled deadline) | 62.4 fps | 62.50 fps |
| `SDL_SetRenderVSync` | absent | absent (now filled) |

#492 fixed the sleep, so the ticket's *"no vsync control **and an inaccurate
sleep**"* framing is stale. The surviving harms are sharper, not gone: a
delay loop free-runs at ~62.5 fps against a ~60 Hz compositor — a beat of
2–3 dropped/duplicated frames per second no sleep accuracy can remove — and
an unpaced loop still burns a core. Display **alignment** is what only vsync
can give; that is what landed. (Evidence + method:
`s3://groundupcoder/gucos/500-vsync/2026-08-15/`. The POLLFLOOD 2.4×
slowdown is a side-finding, NOT attributed: the two measurements straddle
#551's default-renderer change; @master files it separately.)

## Shape (checked against the ticket's §3 rejected list)

One clock: the kernel's `vsyncTick` fan-out — nothing new ticks. The C veneer
stores the mode on the renderer (`SDL_GetRenderVSync` round-trips what was
SET, never the platform cadence — set 0, get 0, even where the platform is
tick-paced anyway); `__sdl_set_render_vsync` returns accepted/unsupported and
the C side owns `SDL_GetError` + the mode-unchanged rule.

- **Software tier — PUBLISH-THEN-PARK.** The present writes the frame into
  the shm buffer first, then parks (`KernelClient.vsyncWaitUntil`) until
  `lastTick + N`. Ordering is the design: the freshest frame is already on
  screen before any wait, so ≤1 frame per tick interval is structural,
  latency is minimal, and a hidden tab (no ticks) pauses with *nothing
  queued* — no resume burst by construction. A slow app finds seq already
  advanced and never parks; re-baselining on the *observed* seq means missed
  ticks collapse and interrupted parks accumulate no debt. The park sits in
  the SDL renderer's own present — the generic shm present that non-SDL
  producers use is untouched (rejected shape 5).
- **GPU tier — the driver paces, present never blocks.** A blocked worker
  starves the event loop its own GPU device needs (PRINCIPLES.md Amendment B
  ground 1), so `vsync=N` makes the callback frame driver await N ticks per
  `SDL_AppIterate`; the iterate for tick T publishes the frame made for it.
  The #551 refusal and the #484 transport clamp are untouched — and per
  Amendment C the clamp is never why the API reports vsync. Since the
  callback cadence already IS the tick, `vsync=1` ≈ status quo there; that
  is documented (sdl-gucos.md) rather than papered over with a
  faster-than-tick driver loop the clamp would just coalesce.
- **No display clock = loud refusal.** `createNullSDL`, standalone pages,
  and a plain headless boot refuse `vsync>=1` (false + named error, mode
  unchanged). `boot.js --vsync[=hz]` (#424) is the headless embedder clock —
  it is what makes the whole mechanism testable in ticks, deterministically,
  at any rate.

## The counter-party finding: a SIGSTOPped vsync app must not pin the compositor

@master's Phase-2 review caught the inverse of this ticket's own goal: the
0169 on-demand compositor stays awake while any pcb has `KP_VSYNC_ARMED > 0`,
and STOPPED pcbs deliberately count (`compKeepAlive` — SIGCONT has no
compositor hook). Armed waiters used to be rare; this ticket makes every
paced game one, so a SIGSTOPped game would have pinned the rAF awake —
burning exactly the battery vsync exists to save.

Resolved in the park itself: each chunk checks `KF_STOP` and re-parks
**UNARMED** in `_stopWait` (the same move `sigpoll` makes on entry), so ARMED
drops to 0 within one chunk (≤1 s) and the compositor may park; CONT resumes
the vsync park, which re-arms and rings the want-frame doorbell. Pinned by a
deterministic worker-thread leg in `test_render_vsync_e2e.js` (stop → ARMED
0 while still parked; cont → re-armed; ticks → exact-target release).

Signals take the FS_WAIT precedent: a deliverable pending signal returns the
park early so dispatch runs at the import-return safe point; the caller's
re-baseline makes that pacing-neutral.

## Gotchas recorded

- `tools/mksdlindex.js` throws on an unclustered constant — that loud
  refusal is the enrolment gate working; `SDL_RENDERER_VSYNC_*` got its own
  cluster and the index regenerated (`--check` green). No ABSENT pin
  existed for vsync — a one-sided edit, unlike #494/#468.
- Headless Chromium's rAF is **not** 60 Hz — measured ~80 Hz on this
  harness. The sweep twin therefore asserts the paced/unpaced *contrast*
  (>10×) and the vsync=2 divisor *relative* to the measured vsync=1 rate;
  tick exactness lives in the deterministic kernel e2e where the test owns
  the clock.
- `image.json` 267 → 268: the baked docs changed, and `version` is the OPFS
  freshness key (`kernel-worker.js` gates the re-fetch on it).
