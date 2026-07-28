# 0369 — the kernel/py harnesses use FIXED per-test timeouts, so the heaviest tests fail on machine load rather than on code

- **Status**: open
- **Design**: —

## ⚖️ RULING 2026-07-28 — STEPS 2 AND 3 SHAPES, BOTH SETTLED

**Provenance: FABLE DECIDER call, relayed by master cont-123, annotated by master
cont-124.** ⚠️ **Decider ruling, NOT jku's.** Full reasoning:
`meta/notes/decisions-cont123-fable.md` (meta main `f16db6d`).

**STEP 2 — the survey** = static timeout enumeration (**command + count + a
PLANTED DECOY**, i.e. the positive control required by lesson **(AZ)**) **PLUS
per-test quiet CPU-time for the heavy tail.**

🔴 **Quiet WALL-CLOCK ratios are REJECTED**, and the stated reason is this
ticket's own second data point: `micropython-upstream/basics/int_big_lshift.py`
runs **7.1 s quiet against a 15 s cap** (53% apparent headroom) and **still went
red under load** — so a `quiet_wall / cap` ranking **demonstrably clears tests
that fail in practice.** ⚠️ **A headroom number measured on a quiet box is not
headroom — it is the best case of a distribution whose tail is where the reds
live.**

**STEP 3 — the fix** = **CPU-time primary cap (over the process tree) + a
generous wall-clock hang-guard for deadlocks**, proven by **three controls**:
1. a busy-loop trips the **CPU cap**;
2. a deadlock trips the **hang-guard**;
3. a **loaded-box run trips NEITHER**.

❌ **EXPLICITLY REJECTED — do not let a lane propose any of these back:**
**raising the constant** · **start-time calibration** · **quarantine-alone.**

⭐ **Step 2's static survey needs NO heavy lock**, so it is parallelizable at the
master's discretion even while the P0 chain holds the lock.


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

## ✅ STEP 1 IS DONE — master cont-122, 2026-07-28. The number changes the ticket.

Re-run on a quiet box (heavy lock held by me so nothing could race it; no other
suite process on the machine; 74% memory free, 38.7 GB disk):

```
node tests/kernel/run.js --filter=test_os_boot     # 2026-07-28T02:46:41Z
ok   test_os_boot.js  719.1s
kernel suite: 1 passed, 0 failed, 123 carried  (719.1s)  [1/124 selected, 124/124 recorded]
```

**`test_os_boot.js` PASSES, in 719.1 s, against a 900 s cap.** So occurrence 2
was load — **but the interesting part is the margin, not the verdict.**

| fact | value |
|---|---|
| `test_os_boot.js`, idle box | **719.1 s** |
| harness cap for that file | **900 s** |
| headroom | **181 s — 20%** |
| next-heaviest file (`test_seed_e2e.js`) | 304.3 s — **this test is 2.4×** it |
| full suite, quiet (00:56Z) | 993 s |
| full suite, 3 lanes running (01:50Z) | **1,179 s — 19% slower** |

🔴 **A 19% suite-wide slowdown against a 20% headroom is a coin flip.** The
harness does not have a timeout that occasionally loses to load; it has a test
sitting one bad minute away from red *at all times*.

🔴 **CORRECTION to cont-121's reasoning in this ticket, from measurement.** The
paragraph above argued: *"the whole suite [ran] 993 s for 124 files — so this
test was nowhere near 900 s."* **That inference is FALSE.** With `-j 2`, the
719 s file runs alongside the other 123; the suite total says nothing about the
individual file. The test was always near the cap. The conclusion ("it was
load") survives; the mechanism offered for it did not. *Do not inherit an
inference when a measurement is one command away.*

**Consequence for the fix (step 3):** raising the constant is now doubly wrong.
It is the `0361` anti-pattern *and* it would be papering over the real finding,
which is that one test costs 72% of a two-job suite's wall clock. `test_os_boot`
re-seeds and compiles busybox hush + the coreutils multicall **with the kernel's
own compiler, in-OS, with no build step** — the cost is real work, so the honest
options are: calibrate the timeout to a measured machine speed, charge CPU time
rather than wall time, quarantine the heaviest tests to a serialized lane, or
make the test itself cheaper. **Weigh all four; do not default to the constant.**

**Gate status resolved:** the kernel gate is **not** RED. ⚠️ Stated precisely so
it cannot be over-read: **1 file re-run by me just now, 123 `carried` from the
01:50:24Z run on `cd2302ff`.** `recorded` ≠ `ran just now`. Nothing in the
kernel path changed between `cd2302ff` and `d1d6e286` (`todos/`, `logs/`,
`tests/unit`, `tests/host` only), so carrying is defensible here — but a future
merge that touches `os/` owes a full fresh run, not this artifact.

## Acceptance

- ✅ **Step 1's re-run recorded with its elapsed time and the box's state** —
  done above: 719.1 s, PASS, quiet box. It WAS load, and the margin is 20%.
- The survey's command + count + positive control.
- Whatever fix lands carries a control showing it distinguishes *slow box* from
  *slow code* — a change that merely stops the red without preserving that
  distinction has made the estate worse, not better.
- ⚠️ Coordinate with `0361` — same family, and its survey may subsume part of
  step 2. **Do not file a third ticket for the same class;** fold instead.

## 🔴 SECOND DATA POINT (master cont-123, 2026-07-28) — the aggregate UNDERSTATES per-test risk

While gating the `0367` merge with three lanes live, `micropython-upstream/basics/int_big_lshift.py`
**failed on a 15 s timeout**. It is not broken and `0367` did not regress it —
the same command was run three times on the same tree:

| run | result | wall |
|---|---|---|
| full corpus, 3 lanes live | 🔴 **583 passed, 1 failed, 65 skipped** — `int_big_lshift` timed out (15 s) | 69.3 s |
| that test ALONE | ✅ 1 passed | **7.1 s** |
| full corpus, re-run | ✅ **584 passed, 0 failed, 65 skipped** | 57.4 s |

⭐ **The number that matters: 7.1 s quiet, against a 15 s cap — and it still blew
past 15 s under load. That is >2.1× inflation on a single test, while the suite
aggregate moved only 21% (69.3 s vs 57.4 s).**

🔴 **This corrects the headroom model in `0369` step 1.** cont-122 measured
`test_os_boot` at 719.1 s against a 900 s cap (20% headroom) and weighed it
against a **19% suite-wide** slowdown, calling it "a coin flip." This data point
says the suite-wide figure is **not** the right comparator: per-test inflation
under contention was **ten times** the aggregate slowdown here. A test with 53%
apparent headroom still went red.

**So `test_os_boot`'s 20% margin is WORSE than a coin flip, not better** — and any
survey in step 2 that ranks tests by `quiet_time / cap` will systematically
under-rate the risk. **The survey must measure headroom UNDER CONTENTION, not
quiet, or it will clear tests that fail in practice.**

⚠️ This also sharpens lesson (CB): an aggregate cannot answer a headroom question
**in either direction** — it under-reports as readily as it over-reports.

## ✅ STEP 2, STATIC HALF DONE — 0369 lane, 2026-07-28. The timing half remains OPEN.

**Command**: `sh tests/scan-harness-timeouts.sh` (committed; the
`tests/scan-wallclock.sh` precedent). Two greps: an over-inclusive line scan
over the harness set (`run.js`/`run.py`/`run-unit.js`/`flake.js`/the five suite
runners/`os-sweep.mjs`/`tests/lib/*.js` as a glob), plus the
`tests/unit/**/config.json` `"timeoutMs"` override channel.

**Count**: **105 matched lines**, all classified by hand
(full per-line table: `logs/2026-07-28/0369-timeout-survey.md`):

| class | lines |
|---|---|
| (a) verdict-deciding caps — **60 fixed constants** (42 run.py, 10–600 s; 18 JS, 30 s–3600 s) + 6 enforcement sites | 66 |
| (b) `except TimeoutExpired` handlers | 14 |
| (c) teardown/kill-grace/poll timers (never decide a verdict) | 13 |
| (d) plumbing/usage text/false positives | 12 |

Both of this ticket's occurrences are in the table: `kernel/run.js:70`
(`test_os_boot`, 900 s) and `run.py:1093` (micropython-upstream per-test, 15 s).

**Positive control (lesson AZ)**: three decoys — a NEW file under the
`tests/lib/*.js` glob, a line smuggled into a listed file with previously ZERO
hits (`tests/todos/run.js`), and a decoy `config.json` in the override channel.
Scan: 105 → **108**, diff = exactly the three plants; decoys removed, baseline
105 restored exactly. Transcript in the dev log.

**Two findings beyond the enumeration, both fold into step 3's fix design
(same family — no new ticket):**

1. **Three runners have NO cap at any layer**: `tests/run.js` (the
   dispatcher), `tests/host/run.js`, `tests/todos/run.js` — bare
   `spawnSync`, no `timeout`, no outer wrapper. A hung test there hangs the
   run forever: the opposite failure mode from this ticket's headline, and
   the cap policy step 3 designs should cover it. (`tests/ext/run.js` is
   also bare but reached through run.py's 120 s ext wrapper.)
2. **The failure MODE of a cap firing is inconsistent in run.py** (verified,
   not assumed: the category loop in `main` is unwrapped): a `TimeoutExpired`
   in the handler-less categories — zlib, projects, freetype, cairo-run,
   libc, disw, tcc-run, sourcemap, ast, ext, blockfs-py — **crashes run.py
   with a traceback** (no summary, no per-test record); the handled ones
   (unit, lua, libpng, genhdr, micropython ×2, sqlite, fuzz, fakegit,
   `build_project`) record an honest failure.

**What this half does NOT establish** (stated so it cannot be over-read): it
is static — it measures no execution time and NO headroom, quiet or loaded.
Per the ruling above, no `quiet_wall / cap` ranking is emitted and none may be
derived from the table. The scan proves the channels it scans (three, each
under the control), not the absence of channels it doesn't — a deadline named
neither `timeout*` nor `*_MS`/`*_SECS`, applied without
`setTimeout`/`Atomics.wait`/`Date.now()+N`, would evade it. **The
under-contention per-test timing half of step 2 remains open** (needs the
heavy lock / a quiet box), and step 3 after it.
