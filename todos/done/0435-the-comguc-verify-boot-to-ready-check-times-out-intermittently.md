# 0435 — the comguc verify boot-to-ready check times out intermittently

- **Status**: done
- **Design**: —

## Goal

Make the deploy gate reliable. `pnpm verify` in `~/git/comguc` must give the same
result for the same `dist/`.

`scripts/verify.mjs:106` waits for the browser to reach the ready state:

    await page.waitForFunction(() => window.__osState === 'ready', null,
                               { timeout: 120000, polling: 250 });

This wait timed out one time on a `dist/` that passed on the next attempt. The
check is the last gate before production, so an unreliable result here is
expensive.

## Evidence

Observed during the v196 deploy, 2026-07-30.

- Attempt 1 **FAILED**. The run printed 7 `ok` lines. It then threw
  `page.waitForFunction: Timeout 120000ms exceeded` at `verify.mjs:106`.
- Attempt 2 **PASSED** on the **identical** `dist/` directory. The run printed 18
  `ok` lines, 0 `skip` lines and 0 `FAIL` lines. The boot check passed.
- The port 3187 was free. The page reported no console error.
- The box had just completed the kernel suite and the browser sweep for todos/0422.
  The load was therefore high.

## This item is NOT todos/0409

todos/0409 is a different defect. That item is a needle race in
`tests/browser/os-boots.mjs`: `waitOut('VI-CAT-OK')` returns on the terminal echo
of the typed command, not on the output of the command. The harness is different,
and the mechanism is different. Do not merge the two items.

## 🔴 Do not raise the timeout as the first action

The code at `verify.mjs:103-105` carries a note from an earlier defect:

    // NB: waitForFunction(pageFunction, arg, options) — options MUST be the 3rd
    // positional arg. Passing it 2nd makes Playwright treat it as `arg` and fall
    // back to the 30s default timeout (a slow first boot then flakes/fails).

Somebody already walked the timeout path once. The argument order is correct now,
and the limit is already 120 seconds. A boot that needs more than 120 seconds is
the thing to explain, not the thing to accommodate. A larger number hides the
defect and makes the gate slower.

## Plan

1. Measure first. Instrument the boot and record the time to
   `window.__osState === 'ready'`. Collect a distribution over at least 20 runs.
   Run half of the runs on a quiet box and half under load.
2. Report the median time and the maximum time. Compare the maximum against the
   120 second limit. The margin tells you whether this is a slow boot or a hang.
3. Find the stage that consumes the time. The boot fetches a sealed system image
   of about 23 MB and starts the WebGPU compositor. Time each stage separately.
4. Decide the fix from the measurement:
   - A hang needs the root cause. Find the stage that never completes.
   - A slow boot under load needs a smaller cost, or a wait on a real signal
     instead of a poll.
   - Only a proven-safe margin justifies a larger limit.
5. Make `verify.mjs` print the elapsed boot time on every run, and print it on a
   failure too. The current failure gives the reader no number.

## Acceptance

- `verify.mjs` prints the time to ready on every run, and on a timeout.
- The measurement from step 1 is recorded in the ticket or in a dev log. It gives
  the median, the maximum, and the conditions.
- The chosen fix follows from the measurement, and the ticket states why.
- 20 consecutive `pnpm verify` runs on one unchanged `dist/` give 18 of 18, with
  0 skip lines. Run at least 5 of them under load.

## Resolution (2026-07-30)

Measured, per the plan. The comguc branch `0435-verify-boot-timing`
(a52b8d2e486c5dbb0b9cdfe893a8be8e5e2709cb) carries the work; the full record is
comguc `logs/2026-07-30/0435-boot-timing.md`.

**Measurement.** `scripts/measure-boot.mjs` (new) boots the shipped v198
`dist/` exactly like `verify.mjs` and timestamps every kernel-worker boot
message through a `Worker` wrapper in an init script. 80 instrumented boots
across four conditions gave 0 failures:

| condition                           | runs | min   | median | max   |
|-------------------------------------|------|-------|--------|-------|
| quiet                               | 60   | 0.96s | 0.98s  | 1.07s |
| 12 CPU busy-loop processes          | 10   | 0.87s | 0.89s  | 1.00s |
| 8 CPU + 4×1024 MB RAM touch loops   | 5    | 0.91s | 0.94s  | 0.98s |
| 8 CPU + 3 live WebGPU compositors   | 5    | 1.19s | 1.23s  | 1.27s |

Stage decomposition of a representative run: WebGPU probe + boot lock at
0.07s, the 23 MB image fetch in 0.01s (local server), volume mounts at 0.35s,
user-volume seeding to ~0.8s, pid 1 + wm spawn to `ready` at 0.96s. No stage
is above 0.6s.

**Classification.** The 120s limit holds a ~92× margin over the worst measured
boot. The v196 timeout was therefore a hang — a stage that did not complete —
not a slow boot. No load this box can generate safely (CPU saturation, 4 GB of
hot RAM pressure, GPU contention) reproduces it, so the hang rate is below
1/80 under these conditions and its stage is unknown.

**Fix, and why it follows.** A hang needs its stage named, and the old failure
recorded nothing. `verify.mjs` now prints `boot: ready in X.Xs` on every run;
on a timeout it prints the elapsed time, `__osState`, and the boot-log tail
(an empty tail names the pre-log stages: worker start, WebGPU probe, boot
lock). The limit stays 120s — the plan's third option (a larger limit) does
not apply, because the margin is already ~92× and a larger number only delays
the report of a hang.

**Acceptance gate.** 20 consecutive `pnpm verify` runs on the one unchanged
v198 `dist/`: all 20 gave exit 0, 18 `ok`, 0 `skip`, 0 `FAIL`, and `boot:
ready in 1.1s`. Runs 1–15 quiet (wall 4.6–4.7s); runs 16–20 under 8 CPU
busy-loops + 2×1024 MB touch loops (wall 5.3–5.6s). One earlier smoke run of
the patched `verify.mjs` also passed 18/18: 21 declared runs, 21 passes.

## Notes

The gate itself behaved correctly here. The v196 deploy lane declared both
attempts and gave the numbers for the failing one, so the retry is on the record.
A lane that silently retried until green would be indistinguishable from a lane
that never failed. Keep that reporting rule in the deploy kickoff.

The defect is in `~/git/comguc`, not in this repo. The item lives on this board
because this board carries the deploy pipeline items (see todos/done/0249 and
todos/done/0262).
