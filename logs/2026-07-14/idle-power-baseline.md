# IDLE-POWER baseline measurements (pre-Stage-3)

Per the revised IDLE-POWER.md staging plan: capture the idle-cost numbers
NOW, before Stage 3 (0168) and Stage 4 (0169) land, so each stage gets an
attributable delta — Stages 1 (0167 vsync wiring) and 2 (0161 WaitEvent)
already moved the "before", which is why measuring only at Stage 4 would
have lost per-stage attribution.

## Method

`node tools/idlemeter.mjs` (new, committed): boots os.html in the sweep's
WebGPU-flagged headless Chromium, settles on VT2, and measures the whole
Chromium process tree's CPU as cumulative `ps cputime` delta / wall clock
over 20 s — an interval measure, not ps's decaying `%cpu`. Two scenarios:
idle desktop (wm + taskbar only) and 4 settled windows (`winbox`, `winbox
fixed`, `term`, `fileman`). Buckets by Chromium `--type=`.

## Numbers (2026-07-14, main @ e824fab, image v88, 20 s interval, M-series mac)

| scenario | total | browser | gpu | renderer | utility |
|---|---|---|---|---|---|
| A. idle desktop | 350.0% | 5.7% | **340.6%** | 3.3% | 0.3% |
| B. 4 settled windows | 456.9% | 5.8% | **444.8%** | 5.9% | 0.3% |

(100% = one core.)

## Reading

- **The compositor's unconditional 60 Hz full-pass submit is ~97% of the
  bill.** The gpu bucket is headless SwiftShader — a CPU rasterizer — so
  the absolute number is amplified vs. real hardware, but the *driver* is
  the same either way: one full-screen WebGPU pass per rAF forever
  (compositor.js `draw()`), dirty or not. Stage 4 (0169's dirty-gated
  submit + park) is what zeroes this row; Stage 3 alone won't move it much
  (wm still presents ≤1 Hz, but the compositor submits regardless).
- **The renderer bucket (kernel worker + all app workers) is where Stages
  2–3 show up**: 3.3% idle → 5.9% with 4 windows. Small in absolute terms
  because 0167+0161 already landed — app workers are vsync-paced or parked
  — but wm.c's frame_cb still runs per tick (Stage 3's target), and the
  audioPump 50 Hz interval floor sits in this bucket too.
- Re-measure with the same command after the audioPump gate + Stage 3, and
  again after Stage 4. The Stage-4 acceptance ("no submits on a settled
  screen") should collapse the gpu bucket to near-idle.

Refs: todos/IDLE-POWER.md (staging plan), todos/0168, todos/0169.
