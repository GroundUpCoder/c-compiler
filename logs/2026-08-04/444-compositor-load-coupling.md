# #444 — the os-compositor "submits flowing" leg measured the box, not the compositor

`tests/browser/os-compositor.mjs` asserted `c1.submits - c0.submits > 30` over a
fixed 1200 ms window. That is an absolute count of a **frame-clock-driven**
quantity against a **wall clock**, so host load moves it directly: measured on
identical source on 2026-08-03, every ~23 s run of the file passed and every
~32 s run failed at 12–15 submits. It produced a false RED inside the batch #1
merge gate, and a 2x miss of the threshold reads like a hard regression rather
than a flake — which is what made it expensive.

## What the counters actually mean

`draw()` accounts for every rAF tick exactly once: `stats.frames++`, then either
`stats.skipped++` (the damage gate found the scene clean) or, further down,
`stats.submits++`. So `frames === submits + skipped` identically, and the claim
"a continuously-presenting app never has a genuinely presented frame dropped" is
precisely `skipped ≈ 0` — a RATIO between two counters sampled in the same
window. Nothing about it needs a clock.

That is the fix: `submits / frames >= 0.9`, with `frames > 0` and `submits > 0`
floors so a fully stalled compositor's 0/0 can never read as a perfect ratio.
The ratio is scale-free — it is 1.000 at 90 fps and 1.000 at 12 fps.

A new companion leg came free and is fully load-independent: while winbox
churns, its vsync wait pins `compKeepAlive`, so the screen must never park —
`parks === 0`, a counter with no threshold at all.

## The false-GREEN twin, in the same file

The neighbouring `...without free-running` bound was the same mistake pointing
the other way: `frames < 100` per 3.5 s. A genuinely free-running compositor
throttled to 25 fps produces ~88 frames and PASSES. Under load that leg went
quietly vacuous. It is now `frames < submits * 15` — each 1 Hz wake costs one
submit plus the `GRACE_FRAMES` coast, so the ratio holds at any frame rate
(GRACE_FRAMES is a frame count, not a duration; measured 4.0 at 90 fps and 5.0
at 12 fps, against a free run's ~60).

The two winmine floors (`submits >= 2`, `parks >= 2` per 3.5 s) deliberately
still count against elapsed time: their SOURCE is a real wall clock — a 1 Hz
`WM_TIMER` delivered by deadline out of GetMessage's kernel WAIT. Load slows the
compositor, not the timer. That is the distinction the whole ticket turns on,
and it is now stated at the top of the file.

## Reproducing the regime — two harnesses that do NOT reproduce it

Worth recording, because both look like they should:

- **`os-sweep.mjs --under-load ×10`** (10 busy-loop generators on a 10-core
  box, 511% CPU): the churn window read `frames 108 / submits 108` on all three
  repeats — byte-identical to an idle box. Pure CPU spin does not perturb this
  frame clock.
- **CDP `Emulation.setCPUThrottlingRate` at 2/4/8/16/32×**: `frames` stayed
  91–103. Renderer-thread throttling does not reach the kernel worker's rAF.

The load in the ticket's measurements was concurrent cc executor turns — nested
~4 GB OS boots, i.e. memory pressure, not spin. Reproducing THAT deliberately is
the thing that OOM'd the box on 2026-07-25, so it was not attempted.

Instead the failing regime was reproduced at its mechanism: pacing the worker
rAF (a throwaway wrapper in `compositor.js`, reverted) to ~12 fps, which is what
host load does to the frame clock. That is where the numbers below come from.

## Evidence

| run | frames | submits | skipped | rate | old `>30` | new |
|---|---|---|---|---|---|---|
| normal clock | 108 | 108 | 0 | 1.000 | PASS | PASS |
| `--under-load ×10`, 3/3 | 108 | 108 | 0 | 1.000 | PASS | PASS |
| paced to ~12 fps | 15–16 | 15–16 | 0 | 1.000 | **FAIL** | **PASS** |
| **RED CONTROL** (below) | 108 | **0** | 108 | **0.000** | FAIL | **FAIL** |

The paced row IS the ticket's failing regime (deltas 12–15) reproduced on
demand: the old assertion fails there, the new one passes, and the full file
passes end to end at 12 fps.

**Red control** — the leg must still catch what it is for. Dropping the
per-surface pixel-content term from `sceneSignature` (`sig.push(s.sid)` only)
recreates the 0160 dropped-frame class: a genuinely presented frame reads clean
and gets skipped. With the clock running at FULL speed the leg failed at
`frames 108 / submits 0 / skipped 108 / rate 0`. That is the discrimination the
fix claims — blind to a slow clock, sharp on a dropped frame — and the sabotage
was reverted.

## Rule

Do not count a frame-clock-driven quantity against a wall clock. Assert a ratio
between counters from the same window, or count only what a real wall clock
drives. And log the sampled window pass or fail: a green that cannot state its
own numbers is how this stayed invisible until a merge gate hit it.
