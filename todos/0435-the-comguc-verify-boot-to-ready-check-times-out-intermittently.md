# 0435 — the comguc verify boot-to-ready check times out intermittently

- **Status**: open
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

## Notes

The gate itself behaved correctly here. The v196 deploy lane declared both
attempts and gave the numbers for the failing one, so the retry is on the record.
A lane that silently retried until green would be indistinguishable from a lane
that never failed. Keep that reporting rule in the deploy kickoff.

The defect is in `~/git/comguc`, not in this repo. The item lives on this board
because this board carries the deploy pipeline items (see todos/done/0249 and
todos/done/0262).
