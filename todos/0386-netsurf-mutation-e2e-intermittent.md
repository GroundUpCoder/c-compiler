# 0386 — test_netsurf_mutation_e2e.js is intermittently RED (pixel comparison) and hangs uncapped when run bare

- **Status**: open
- **Design**: —

## Goal

`tests/kernel/test_netsurf_mutation_e2e.js` has now failed **twice, in two different lanes'
kernel gates, on two different byte-sets**, and passes solo on re-run. Two sightings is the
filing threshold, so this is being tracked as a **real intermittent**, not a one-off.

Make the test either **deterministic** or **honestly load-tolerant** — and establish which of
the two it actually is before changing anything.

## Evidence (all first-hand, do not re-derive from summaries)

**Sighting 1** — cont-126's `0374` gate: failed on **ink pixels 285 vs 234**; green solo on
re-run.

**Sighting 2** — the `0376` lane's kernel gate, 2026-07-28, the **first ever full 125-file
run** (`runs` has 1 entry, filter null, `selected` 125 == `executed` 125, `carried` 0,
`done` true, `elapsedMs` 985271, `jobs` 2). Result **122 pass / 3 fail**:

| file | time | verdict |
|---|---|---|
| `test_mounts.js` | 47 ms | REAL — `0376`'s own EROFS→EBADF errno change, **not this ticket** |
| `test_rofs.js` | 39 ms | REAL — same defect as above, **not this ticket** |
| `test_netsurf_mutation_e2e.js` | 11104 ms | **this ticket** |

⭐ The 47 ms / 39 ms failures are what isolate this one: **a test that dies in 47 ms has no
timeout story** — it failed at an assertion instantly. Fast failures are not load flakes. The
netsurf failure is the only one of the three with a contention-shaped profile.

⚠️ **Both sightings were on a LOADED box** (`jobs 2`, other lanes live). That is a correlation,
not a cause — nobody has yet reproduced it under controlled load.

**Third observation, 2026-07-28 ~05:20Z (master cont-128, off `ps`)** — the `0376` lane ran
this file **bare** (`node tests/kernel/test_netsurf_mutation_e2e.js`, no runner) to check
whether the failure reproduced. The process sat at **elapsed 3m21s, %CPU 0.0, STAT S** — ~18×
its 11 s in-gate time, asleep rather than spinning.
🔴 **A bare invocation carries NO cap at any layer** — the kernel runner's timeout table is
what bounds this test, and invoking the file directly bypasses it entirely. So a hang here is
*silent and unbounded*, and it stalled a live lane's turn.
⚠️ **Followed up — IT WAS NOT A HANG.** The process **exited on its own** a few minutes later
(observed gone; the lane then pushed its next commit and re-took the heavy lock). So the
correct reading is **very slow, not stuck**: roughly 20–30× its 11 s in-gate time when run
bare on a box that had just been under load. 🔴 **Do not open this ticket by hunting a
deadlock** — chase the slowness and the pixel nondeterminism. The uncapped-bare-invocation
point in item 4 stands on its own merits regardless.

## Plan

1. **Reproduce deliberately** — run it under synthetic load (the box has a heavy-lock story;
   `jobs 2` is the observed condition) until it fails. **A green solo run proves nothing** and
   must not be accepted as a fix.
2. **Classify the failure.** Is the ink-pixel delta (285 vs 234) a *partial render* the
   assertion sampled too early — i.e. a missing wait/settle — or genuinely nondeterministic
   rasterisation? These need opposite fixes. Answer this before touching the assertion.
3. 🔴 **Do NOT "fix" it by widening the pixel tolerance until step 2 says the variance is
   legitimate.** Loosening a threshold to silence an early-sample bug destroys the signal the
   test exists for.
4. **Separately, close the bare-invocation gap**: a kernel test run directly should still be
   bounded, or the runner should be the only sanctioned entry point and say so loudly.

## Acceptance

- The failure has been **reproduced under stated conditions**, with the conditions written
  down — not merely observed twice in the wild.
- Step 2's classification is recorded with evidence (which of partial-render vs true
  nondeterminism), and the fix matches that classification.
- A **flake gate**: N consecutive runs under the reproducing load, N stated and justified.
  Bare re-runs on a quiet box do not satisfy this.
- The bare-invocation cap gap is either closed or explicitly deferred to a named ticket.

## Relationship to 0369 — cross-reference, DO NOT FOLD

`0369` (harness fixed timeouts under contention) is about **fixed timeout caps**. This test
fails on **pixel comparison**, not on a cap — folding it into `0369` would mis-file it.

But `0369`'s step-2 static survey (branch `0369-timeout-survey` @ `e9164c06`) is directly
relevant to the *third* observation above: it found that several runners are **bare
`spawnSync` with no cap at any layer** (`tests/run.js`, `tests/host/run.js`,
`tests/todos/run.js`), and that `run.py` **crashes with a traceback and emits no summary** on
timeout in its handler-less categories. Read that survey before designing item 4.
