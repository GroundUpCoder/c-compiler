# IDLE-POWER Stage 3 — wm.c goes event-driven (todos/0168)

Landed as the three commits the revised staging plan called for, plus two
pieces the work surfaced:

1. **`afc1b76` — kernel socket→ring wake.** `_kernelPeer.send` now
   `Atomics.notify`s the client pcb's input ring (pure notify, no record —
   the 0161 spurious-wake contract). Without it a pump-wait-parked WMP
   subscriber slept its whole park chunk past every event.
   `test_sockwake_e2e` proves the wake: <1500ms into a 4000ms park on
   EV_SCREEN vs a 4010ms dead sleep without the kick.
2. **`b136b72` — pumpWait no-park fix (latent 0161 seam bug).** pumpWait
   drained the ring into the wasm event queue and then parked anyway —
   events landing between the caller's last poll and the park entry slept
   out the full timeout. Found the hard way: test_wm_service_e2e's marquee
   leg went red because the drag's tail events (arriving mid-frame_cb) sat
   in the queue through a 1s park while the shot was taken at 0.5s. user32
   never noticed because GetMessage chunks at 25ms. drainInput now returns
   its record count; a non-empty entry drain returns instead of parking.
3. **`1ad13b0` — the wm.c conversion (piece W).** frame_cb is no longer a
   per-rAF callback; main loops `{ frame_cb(); park }`. Two deliberate
   design points:
   - **The park is `__sdl_pump_wait` called directly, NOT
     SDL_WaitEventTimeout.** wm has two event sources (input ring + WMP
     socket). The socket kick is a pure ring notify — no SDL event
     appears — so the veneer's `PollEvent || re-park` loop would sleep
     over it. The raw seam returns on any wake and frame_cb re-drains
     both queues. (The 0168 item said "the WaitEventTimeout idiom"; the
     idiom survives, the call site is one level lower for the two-queue
     reason. mgp and single-queue SDL apps keep using WaitEvent.)
   - **A pre-park zero-timeout select() on the socket** closes the
     kick-before-park lost-wakeup gap (the kick doesn't change IR_WPOS,
     so a wait entered after the notify would miss it).
   Tick counters (desk_load, saver poll, PEEK_IDLE/PEEK_REFRESH, datepop)
   became wall-clock stamps; menu/ctx/run popups redraw on activity
   (socket frames or SDL events) only; the screensaver paces at 16ms
   parks while live (its marquee/starfield shot-based e2e legs stayed
   green). Idle wm: one wake per second and zero presents until the
   clock's minute tick (piece D below gates even that redraw's present
   to the actual pixel change).
4. **`1a128fa` — bar_present() (piece D),** recovered from the reverted
   0160 attempt: draw_bar still runs per wake, but the present is gated on
   a memcmp against the last-presented bytes, so the 1/s tick doesn't
   churn SH_SEQ and defeat 0169's damage skip.

Also this morning, ahead of Stage 3 (per the revised staging plan):
- **`4a89286` baseline measurements** — `tools/idlemeter.mjs`; idle desktop
  350% total CPU, 340.6% of it the (SwiftShader) gpu process driven by the
  unconditional 60Hz recomposite. See `idle-power-baseline.md`.
- **`ae5e7db` audioPump gate** — the kernel-worker's 20ms pump interval
  parks on an empty stream table, re-armed by the new `onAudioStream`
  kernel hook (pause/resume is SAB-only, so any table entry keeps it
  armed; dying streams count until reclaimed).

## The gate run earned its keep — a second timing bug

The first full browser sweep came back 23/24: os-aero's Aero Peek leg
red, and `--repeat 5` measured it 60% flaky — a live regression. The
mechanism (isolated with `tools/peek-repro.mjs`, wm stderr → `__osOut` +
a polled popup pixel): the counter→wall-clock conversion compared the
peek/date hover stamps against a `now_ms` captured at frame_cb ENTRY,
but `peek_show`/`bar_motion` write those stamps DURING event handling —
whenever the ms clock ticked in between, the unsigned delta wrapped huge
and the popup was **dismissed the same frame it was shown** (then
nothing retries: the pointer sits still, so no event ever re-raises it —
a 30s-stuck teal pixel, not a transient). Fix (`49069dd`): re-read the
clock at the housekeeping point — a fresh read is ≥ any stamp taken this
iteration. os-aero went 5/5.

Repro-writing gotcha for the record: a healthy popup idle-dismisses at
2.5s with a motionless pointer, so a sleep-then-sample repro calls
healthy runs broken — poll like the real test does.

Gates, all green on the final tree: unit/host/blockfs/kernel via
`tests/run.js` (65 kernel files), full browser sweep 24/24,
`tests/flake.js` (kernel + browser tripwires, 3× under load — one
earlier FAIL was contamination from my own concurrent rebakes, clean
re-run green), wm-surface kernel e2es re-run post-fix 6/6, and a headed-
style visual check (screenshots: idle desktop + peek popup on real mouse
hover).

## Stage-3 idlemeter delta (same method as the baseline)

| scenario | total | gpu | renderer |
|---|---|---|---|
| idle desktop (pre) | 350.0% | 340.6% | 3.3% |
| idle desktop (post-Stage-3) | 349.1% | 342.4% | **2.3%** |
| 4 windows (pre) | 456.9% | 444.8% | 5.9% |
| 4 windows (post-Stage-3) | 455.5% | 446.8% | **4.5%** |

The renderer bucket (kernel worker + all app workers — where wm lives)
dropped ~30% idle / ~24% with windows; the gpu bucket is untouched, as
predicted — the 60 Hz compositor submit is Stage 4's (0169's) target and
~97% of the bill.

Next: todos/0169 (Stage 4 — compositor parking) is unblocked and top of
queue, with todos/0178 (kernel unified wait — filed from the 2026-07-14
design review) hard-blocked behind it as the consolidation.
