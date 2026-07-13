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

Gates: full wm e2e surface green (wm_service, snap, saver, ctxmenu,
recycle, fileman_ops, term, os_apps, cursor, user32, waitevent, sockwake,
audio×3); flake gate + browser sweep + the idlemeter re-measure run at the
end of the day's batch (see the push notes).

Next: todos/0169 (Stage 4 — compositor parking) is unblocked and top of
queue.
