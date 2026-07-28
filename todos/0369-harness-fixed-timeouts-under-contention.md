# 0369 — the kernel/py harnesses use FIXED per-test timeouts, so the heaviest tests fail on machine load rather than on code

- **Status**: open
- **Design**: —

## Goal

`0361` is about a **fixed wall-clock assertion inside a `unit` test**. This is the
sibling defect one layer out: a **fixed per-test timeout in the harness**. Same
failure shape, different mechanism, and now observed **twice, in two different
suites** — which is what turns it from an anecdote into a population.

| # | when | suite | test | observed |
|---|---|---|---|---|
| 1 | 0356 lane, 2026-07-28 | `micropython-upstream` | `basics/set_binop.py` | "Timed out (15s)"; category took 71.4 s under load vs 53.7 s idle. Passed in isolation and on a clean re-run. The lane logged it rather than filing — **one occurrence.** |
| 2 | master cont-121, 2026-07-28 | `kernel` | `test_os_boot.js` | **timeout at 900,023 ms** (the harness's 900 s cap), while three lanes ran concurrently. |

## Why occurrence 2 is near-certainly load, and why "near-certainly" is not good enough

The same `test_os_boot.js` **passed** in my complete `124/124` run 54 minutes
earlier (`build/test-kernel/summary.json`, `startedAt 2026-07-28T00:56:04Z`,
`done: true`, non-pass **0**, whole suite 993 s for 124 files — so this test was
nowhere near 900 s). The only commits in between are:

- `c620e889` — `0360`: `todos/idspace.js`, `todos/queue.js`, `todos/liabilities.js`,
  `tests/todos/run.js`, `todos/README.md`, `CLAUDE.md`. **Nothing in the kernel path.**
- `cd2302ff` — **six added comment lines** in `compiler.js` (verified: `git diff
  c620e889 cd2302ff -- compiler.js` is comment-only), plus `todos/` and `logs/`.

**Codegen is byte-identical, so no code change can explain it.** `test_os_boot.js`
is the heaviest test in the estate — `freshImage` re-seeds and compiles busybox
hush + the coreutils multicall **with the kernel's own compiler, in-OS, no build
step** — so it is precisely the test with the least headroom against a fixed cap.

🔴 **But this is exactly the reasoning that must NOT be allowed to close the
question.** *"A red suite might just be load"* is the habit `0361` was filed to
prevent, and I will not both invoke it and call the gate green. **The gate on
`cd2302ff` is RED-pending until `test_os_boot.js` is re-run on a QUIET box.**
That re-run is step 1 below.

## Plan

1. **Settle occurrence 2 first.** Re-run `node tests/kernel/test_os_boot.js` solo
   with nothing else on the machine (`cc-meta list --filter running` empty of
   lanes; `ps -Ao rss,pid,comm -m | head`). Record the **elapsed time**, not just
   pass/fail — the number is the evidence, and it is what sizes the headroom.
2. **Survey as a POPULATION claim.** Every fixed timeout in the harnesses — the
   `kernel` runner's per-file cap, `tests/run.py`'s per-test cap, and any
   `setTimeout`/`AbortSignal.timeout` in `tests/lib/`. Give the **command and the
   count**, not an impression, and carry a **positive control**: plant a decoy
   timeout the scan is obliged to find, and show it finds it.
3. **Then decide the fix, and do not reach for the obvious one.** Raising the
   constant is the `0361` anti-pattern: it buys headroom by destroying the
   signal. Candidates worth weighing instead — a timeout scaled to a measured
   machine-speed calibration; charging CPU time rather than wall time; or
   quarantining "heaviest" tests to a serialized lane. **The lock only serializes
   whole suites (`0342`), so nothing today stops a `kernel` run from racing three
   lanes.**

## Acceptance

- Step 1's re-run recorded with its **elapsed time** and the box's state, settling
  whether occurrence 2 was load. If it turns out NOT to be load, this ticket is
  the wrong home and a real regression ticket is owed — say so loudly.
- The survey's command + count + positive control.
- Whatever fix lands carries a control showing it distinguishes *slow box* from
  *slow code* — a change that merely stops the red without preserving that
  distinction has made the estate worse, not better.
- ⚠️ Coordinate with `0361` — same family, and its survey may subsume part of
  step 2. **Do not file a third ticket for the same class;** fold instead.
