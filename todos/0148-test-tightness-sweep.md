# 0148 — test tightness sweep (recurring)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: this file. The test-suite analogue of the `--manual-ux` dogfood
  and `--reflection` cadence: a recurring pass that keeps the test estate tight
  — every test carries its weight, is well-written, and is not slow because of
  bad infra. Low priority so it never blocks feature work; self-reseeds like
  the manual-ux sweep so the cadence never runs dry.

## Step 0 — reseed the pipeline (do this FIRST)

Keep the cadence alive. Count the OPEN copies:

    ls todos/*-test-tightness-sweep.md 2>/dev/null | wc -l   # includes THIS file

If fewer than **2** remain, add one more at P2:

    node todos/queue.js add next --slug test-tightness-sweep --priority 2 --difficulty light

Then `node todos/queue.js check` and carry on.

## Plan

A different slice each run (note what you skipped):

- **Weight**: find tests that pass trivially, assert implementation not
  behaviour, are over-mocked, or duplicate another test. The audit found the
  *core* is healthy (no `|| true` swallowing, all os-*.mjs carry real
  assertions, no empty goldens) — so this is maintenance, not triage. Watch
  the deliberate kernel-e2e ↔ browser two-legs duplication: confirm each leg
  still tests something the other can't (headless logic vs pixels), retire a
  leg that has gone redundant.
- **Speed-from-bad-infra** (NOT speed-from-real-work): re-measure the
  `build/test-*/summary.json` timings; any file whose wall-clock is dominated
  by fixed sleeps (0083 territory) rather than compiling/booting is debt. E.g.
  `test_term_e2e.js` boots 5× — collapse the boots that don't need isolation
  (persistence tests aside). Genuine-work slowness (Csmith, the bake path) is
  fine; flag only bad-infra slowness.
- **Coverage gaps** that catch subtle-flow regressions: browser legs with no
  headless counterpart (`os-scale`, `os-screen`, `os-vt`, `os-aero`,
  `os-drop`) only validate through the slow flaky path — add headless
  counterparts where cheap.
- **Infra architecture**: is the parallelism still sound, the fixture prebake
  still shared, the entrypoints converging (0084)? Fix poorly-architected infra
  found; don't just paper over it.

## Acceptance

- Step 0 done: ≥2 open `test-tightness-sweep` items exist; `queue.js check`
  passes.
- Dev-log entry (`logs/YYYY-MM-DD/test-tightness-sweep.md`): what was audited,
  what was tightened/retired/sped-up, what was deferred.
- Any test changed still green; any infra change keeps the suites green.
