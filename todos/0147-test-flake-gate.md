# 0147 — test flake / under-load gate (`--repeat N`, run-under-contention)

- **Status**: open
- **Design**: this file. From the 2026-07-12 test-infra audit
  (`logs/2026-07-12/queue-hardening-and-keymap.md`). Enforces the acceptance
  0083 sets ("converted files pass under load") — nothing today runs tests
  repeatedly or under contention to catch timing regressions.

## Goal

The documented flake class (0074 os-doom) and load-sensitivity all trace to
fixed sleeps. Once 0083 converts them to event-waits, we need a gate that
proves they STAY event-clean and that new tests don't reintroduce sleep-debt.

## Plan

- Add a `--repeat N` mode to `tests/lib/suite-runner.js` (run each selected
  file N times, fail if any run fails; report per-file flake rate).
- Add an under-contention mode: run one suite while a second kernel suite (or
  a CPU-load generator) is in flight — the scenario 0081 documented and 0083's
  acceptance names.
- A cheap tripwire set: `--repeat 3` over the historically-flaky files
  (os-doom, os-term, wm_service_e2e).

## Acceptance

- `--repeat 5 --filter os-doom` runs it 5× and reports a flake rate; green
  means non-flaky.
- The under-load mode reproduces (pre-0083) or clears (post-0083) the sleep
  flake class on demand.
- Documented as the gate to run after any new e2e/browser test lands.
