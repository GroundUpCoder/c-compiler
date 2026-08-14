# #492 — sleep timeout overshoot: isolated to OS timer-coalescing leeway, compensated

Lane #492, base `06b7c24e`, branch `lane/492`. **Classification: quality gap**
(todos/PRINCIPLES.md P1) — POSIX nanosleep/usleep and SDL_Delay all promise a
*minimum* duration, so the overshoot was inside the permitted envelope. The harm
was measured, not asserted: the textbook `SDL_Delay(16)` game loop ran 43.5 fps
on this box (ticket's original box: 44.5).

## Leg 1 — the isolation (measurement first)

Mechanism re-derived at `06b7c24e` before anything else. The ticket's §2
correction is confirmed — and was itself still incomplete:

- standalone/pre-window sleeps → `blockingSleepMs` (host.js:4395), a raw
  `Atomics.wait` timeout on a private never-notified cell;
- OS SDL_Delay → `sdlDelay` (host.js:7800 post-fix) over `pumpWait`'s
  input-ring futex;
- 🔴 **kernel-attached usleep/nanosleep/sleep do NOT go through
  `blockingSleepMs` at all** — `hooks.park` overrides them (host.js:6833-6849)
  → `KernelClient.park` (kernel.js:1467), an `Atomics.wait` on the doorbell
  cell whose *final* wait requested the full remainder. Found the hard way:
  the first fix moved SDL_Delay and left usleep untouched in the in-OS A/B.
- FS_WAIT/`waitMulti` is a separate path plain sleeps never touch (confirmed).

**The cause is the OS, not V8, not scheduling, not power mode.** Percentile
ladders (p50/p90/p99/max, 60–200 iters/row, spin-calibrated instrument at
±0.001 ms) across substrates on this box (Darwin 25.5.0, 10-core, AC power):

| substrate | overshoot shape |
|---|---|
| `Atomics.wait` (Node main, Node worker, Chromium worker) | **min(req/2, 10 ms)**, p99 ≈ p50 + 40 µs |
| native `nanosleep`, `usleep`, `pthread_cond_timedwait`, `mach_wait_until` | identical min(req/2, 10 ms) |
| `setTimeout` / `Atomics.waitAsync` (event-loop timer tier) | min(req/2, **2 ms**) — different coalescing tier |
| busy-spin (control) | 0.001 ms |

The 50%-capped leeway is deterministic and identical for every *thread-blocking*
timed wait including the absolute-deadline `mach_wait_until` — i.e. XNU
timer-coalescing leeway below the syscall interface. (The exact kernel tier
knob is not economically identifiable from userland and doesn't change the fix;
`kern.timer_coalesce_*` sysctls don't obviously encode 50%/10 ms.) The ticket's
original box plateaued at ~6–7 ms rather than 10 — consistent with a
per-configuration cap, same 50% shape at small n.

Rule-outs, each with a positive control (a null without a working instrument is
not a null):

- **V8**: native `pthread_cond_timedwait` (V8's `Atomics.wait` substrate) shows
  the identical distribution; a deliberately injected +3 ms JS-layer delay is
  detected exactly (4 ms row 2.0→5.0, 16 ms row 8.0→11.0), so a V8-layer
  contribution of that scale could not have hidden.
- **OS scheduling/contention**: idle-box distribution is tight (p99−p50 ≈
  40 µs) — noise-free, so not scheduling; under a deliberate 12-way spin load
  on 10 cores the instrument *does* see contention (p99 5.4 ms on the 4 ms
  row). Notably naive p50 *drops* slightly under load — coalescing exists to
  batch wakeups on idle cores, corroborating the leeway mechanism.
- **Power mode**: AC power, `lowpowermode 0`; `caffeinate -dims` A/B is a null.
- `Atomics.waitAsync` side-finding: its pending timeout does not ref Node's
  event loop (process exits at first await without a keepalive). Not a
  candidate substrate anyway (sync sleeps can't await).

## Leg 2 — the fix (no busy-wait, no new API, no FS_WAIT routing)

The leeway is proportional to the *requested* duration and deterministic, so a
monotonic-deadline loop that never requests the full remainder compensates it
with the thread parked throughout:

```
end = performance.now() + ms
loop: left = end - now; if left <= 0 return
      Atomics.wait(cell, 0, 0, left > 1 ? left * 2/3 : left)
```

Why 2/3: a full-leeway wake (×1.5) lands exactly on the deadline; an on-time
wake shrinks the remainder by 1/3, so wakes are log-bounded. Measured 1.2
wakes/sleep (macOS; on a tight-timer OS it degrades to ~log₃(ms) ≈ 4 wakes for
16 ms — µs-scale cost). The final sub-ms request bounds residual overshoot at
~0.5 ms. Never-early is structural (the deadline re-check), and EINTR semantics
in `park` are untouched (pending() checked on every wake; the restructure
stops treating a *shortened* wait's 'timed-out' as deadline-reached).

Applied in three places (all three verbs measured before/after in-OS):
`blockingSleepMs`, `sdlDelay` (+ `Date.now`→`performance.now`), and
`KernelClient.park`.

**#551 flush-mode parity**: shortening `sdlDelay`'s pumpWait requests would
have re-binned a 15–22 ms delay from 'force' to 'park' at pumpWait's entry
flush. Kept byte-equivalent by keying one `flushPresent('force')` on the APP's
requested duration at sdlDelay entry — exactly what the old un-shortened first
pumpWait did (no held frame can appear mid-delay; the delaying thread is the
presenter).

## Results (in-OS, `boot.js --packages=none`, 60 iters/row, 16 ms requests)

| verb | p50 overshoot before | after | p99 after |
|---|---|---|---|
| usleep(16000) | +8.02 ms | +0.03 ms | +0.29 ms |
| nanosleep(16ms) | +8.02 ms | +0.03 ms | +0.44 ms |
| SDL_Delay(16) | +8.02 ms | +0.03 ms | +0.38 ms |

Textbook loop: 43.5 → **62.3 fps** (62.5 nominal for a 16 ms period). Worst
residual anywhere on the ladder: +0.5 ms (the deliberate sub-ms tail).
Chromium-worker prototype of the same loop: p50 +0.0 ms, 1.28 wakes/sleep.

## Test

`tests/kernel/test_sleep_overshoot_e2e.js` (registered, BOOT tag from a
measured 213 MB peak RSS): all three substrates, split-instrument asserts —
never-early (contract) + p50 < 4 ms (quality; >2× margin both ways). Red
control against `06b7c24e`: 4/4 quality legs FAIL (p50u 8035–8043 µs),
contract legs green. Flake gate: 3/3 stable under ×10 load.

## Residuals (NOT fixed here, reported to @master, no tickets filed by lane)

- `SDL_WaitEventTimeout`/`GetMessage` timeout legs (pumpWait/waitMulti callers)
  still carry the raw leeway on their *timeout* expiry — event waits, not
  sleep verbs; same permitted envelope, much weaker gamedev harm.
- Kernel-side FS_WAIT/select/poll timeout timers (kernel-worker `setTimeout`,
  the 2 ms-cap tier) untouched by design (ticket §4 forbids routing sleeps
  there; their own lateness is a separate, smaller quality question).
- `env.sleep`'s return-remaining arithmetic still uses `Date.now` (coarse
  seconds; unchanged behavior).
