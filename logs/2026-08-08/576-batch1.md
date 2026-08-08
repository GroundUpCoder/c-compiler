# #576 Batch 1 — mechanical gate speedups: what landed, what it actually bought

Batch 1 of the three-batch test-refactor plan
(`meta/notes/gucos-test-refactor-proposal-2026-08-08.md`). Three commits on
`lane-576b1`, off `main` = `dc06bb57`:

| commit | content |
|---|---|
| `dc22fddc` | A3 clonefile fixture install + D3 `polling:'raf'` |
| `770bcd69` | A1 hint-seeded longest-first + A2 RAM-weighted pool |
| `abcadc89` | A4 instrument — per-test-tree peak-RSS sampler |

52 files, +765/−265 (`git diff --name-only dc06bb57..abcadc89`, all paths):
43 `tests/browser` · 4 `tests/lib` · 2 `tests/kernel` · 1 `tests/host` ·
1 `tests/browser/lib` · 1 `os`.

**Headline: the batch is green and buys a small mechanical win. Its real value
is the diagnosis it produced — the gate's time is not where the plan assumed.**

## The gate: GREEN, 53.01 min, full and unfiltered

One full unfiltered run, 10:56:34 → 11:49 (`elapsedMs` 3,180,760 = **53.01
min**, `filter: null`).

| suite | status | time | files |
|---|---|---|---|
| todos · netsurf-patch · unit · host | pass | 65.3 s total | — |
| blockfs | fail, `exit 130` | 7.2 s | 14 of 15 executed |
| py[19 suites] (dispatcher row) | pass | 6.75 min | — |
| kernel | **pass** | 20.94 min | **169/169** |
| sweep | **pass** | 24.11 min | **58/58** |

Artifacts preserved in `build/EVIDENCE-cont537-11h33/`. This matters: a later
narrow re-run overwrote the live `build/test-run/summary.json` and
`build/test-blockfs/summary.json` within two minutes of the gate finishing.
The EVIDENCE copies are now the only record of the 53-minute run.

### The one red was an artifact of how the gate was launched

`exit 130` = 128+2 = **SIGINT**, not an assertion failure. blockfs started
10:57:40 and died ~10:57:47 — about 66 s into the gate, which is exactly when
the lane that launched it ended its turn. The turn-end signal reached the
in-flight child and killed `test_fuzz.js` (the suite's longest file); the gate
itself survived only because it had already reparented to init. Its artifact
reads `done: false`, 14 results, **all 14 passing**.

The branch cannot be the cause: `git diff --name-only dc06bb57..abcadc89 |
grep -i blockfs` is **empty** (0 hits, against 44 hits for `browser` as a
positive control). A skip is never a pass, so the suite was re-run rather than
reasoned away: **15/15 pass, `test_fuzz.js` 85.3 s, `GATE_EXIT_RC=0`**.

**Lesson worth keeping: a lane that launches a gate and then ends its turn
does not merely orphan the job — its turn-end SIGINT scars the run, and the
scar reads as a red suite an hour later.** Run gates in the foreground under a
held turn.

## Finding 1 — the browser sweep is FULLY SERIAL, and it is now 45% of the gate

The sweep summary reads **`jobs: 1`**, and sum-of-per-file (24.11 min)
**equals** wall (24.11 min) ⇒ **speedup 1.00x**. It runs one browser file at a
time.

At **24.11 of 53.01 min the sweep is 45% of the whole gate** — and **Batch 1
could never have touched it.** A1/A2 are kernel-pool changes; the sweep does
not use that pool. Slowest members: `os-git-cli.mjs` 235.8 s ·
`os-clang.mjs` 213.7 s · `os-osk.mjs` 124.5 s · `os-shell.mjs` 111.4 s.

⇒ **This re-ranks the remaining plan.** The two real levers are Batch 3 **C1**
(shared-boot tours, 57 → ~10 boots, which attacks the sweep's actual cost) and
making the sweep concurrent at all. Both are worth more than the proposal's
ordering implies.

## Finding 2 — the kernel is RAM-bound at exactly 2 boots; `jobs: 6` is inert

Per-file sum 41.99 min against 20.94 min wall = **2.01x parallel speedup** on
a declared `jobs: 6`.

That 2.01x is not a coincidence, and the arithmetic closes exactly:

```
ramBudgetGb() = totalmem × 0.6 = 16 GB × 0.6 = 9.6 GB
concurrency   = floor(budget / HEAVY_GB) = floor(9.6 / 4) = 2 boots
```

The CPU cap of 6 never binds. **`HEAVY_GB` does.** Theoretical floor is
max(longest file, total/jobs) = max(**11.84 min** for `test_os_boot.js`, 7.00)
= 11.84 min, so ~9 min of slack sits behind the RAM cap and **no amount of
reordering can reach it**. Raising `jobs` is worthless; only removing boots or
lowering per-boot memory helps.

## Finding 3 — the −11.4% headline is not defensible. **Measured answer: −3.1%.**

> **AMENDED 12:35 after a single-variable A–B.** This section first claimed −2.4% on the reasoning
> that `test_cmdalt_e2e.js`'s drop was purely a bogus hint "because the branch does not touch that
> file". **That reasoning was defective** — A3 changes `os/boot.js`, which is shared infrastructure
> every fixture-installing test depends on, so a file can legitimately speed up without appearing in
> the diff. The A–B below settles it, and the truth is in between.

Compared per-file `ms` against the committed A1 hints
(`tests/kernel/timings.json`, 166 of 169 overlap): hint 42.73 min → now 37.86
min = −4.87 min = **−11.4%**.

**But `test_cmdalt_e2e.js` alone accounts for −233.0 s (237.2 s → 4.2 s, a 56x
drop) = 80% of the entire gain — and this branch does not touch that file**
(`git diff dc06bb57..abcadc89 -- tests/kernel/test_cmdalt_e2e.js` is empty).
An unmodified test cannot legitimately get 56x faster: **the hint value is
pathological, not the runtime.**

### The A–B (single variable, one tree, one fixture, `--filter=cmdalt_e2e`)

| leg | `os/boot.js` | result |
|---|---|---|
| A | merged main (A3 clonefile) | **4.1 s** |
| B | **only** `os/boot.js` reverted to `dc06bb57` | **17.5 s** |

Both legs passed; the tree was verified clean before and after the revert.

**Both earlier claims were wrong, in opposite directions:**
- **A3 is real.** It speeds this fixture-heavy test up **4.3x, −13.4 s**. Dismissing the whole drop
  as a hint artifact discarded a genuine win.
- **But pre-A3 is 17.5 s, not 237.2 s.** The hint never described this host's behaviour, before or
  after the branch. The 237 s figure *is* bogus — just not for the reason first given.

**Decomposing the 233 s "gain" on that file: ~13.4 s is real (A3), ~219.6 s is hint error.**
Correcting the suite figure for that — removing the fake 3.66 min from both sides — gives
**≈ −1.21 min against a ≈ 39.07 min corrected baseline = −3.1%.**

**−3.1% is the number to report.** −11.4% overstates it ~4x; −2.4% understated it slightly by
throwing away A3's real contribution along with the bad hint.
⚠️ Assumes the *remaining* hints are sound, which is **not** established (`#577`), and leg B is a
single run, not a repeated measurement.

Two regressions worth a line, both proportionally large: `test_gcode_native.js`
2.6 → **12.1 s** (4.6x) and `test_git_e2e.js` 2.2 → **4.0 s**.

⚠️ **Do not claim "50 → 40 min".** This gate took 53.01 min, and the
pre-refactor baseline is unsourceable on this host — the hints' own provenance
is unknown (`770bcd69` documents the fallback chain but never says which run
seeded the table). The comparison above is "vs the committed hints", **not** a
true pre/post A–B.

**Consequence for A1 itself:** a 237 s hint on a 4.2 s test makes longest-first
schedule it 5th-earliest, burning a prime slot. The hints table should be
regenerated from the clean 11:25 full run — `tests/lib/update-timings.js` ships
in this batch for exactly that. Filed as a follow-up rather than folded in.

## A4 — the instrument, and the first real numbers off it

A4 shipped the **instrument**, not the retune. `tests/kernel/run.js` keeps
`HEAVY_GB = 4` with an explicit comment marking it provisional "until the A4"
measurement. That is honest, and it is why this batch is mergeable without the
retune.

The sampler had never actually been executed before it landed, so it was run
(cont-538, 12:01–12:05, `--interval=500`, idle box, 11.5 GB free):

```
  1.03 GB  test_wm_service_e2e.js  (110 samples)
  0.66 GB  test_present_e2e.js     (400 samples)
  0.64 GB  test_term_e2e.js        (442 samples)
  1.59 GB  <all tracked trees at one instant>
```
Artifact: `build/rss-a4-cont538.json`. The instrument works end to end.

**For fixture-based boot tests, `HEAVY_GB = 4` looks ~4x too conservative.** If a
defensible weight were ~2 GB, the 9.6 GB budget would admit 4 boots instead of
2 — which is precisely the ~9 min of unreachable slack in Finding 2.

### 🔴 AMENDED 12:35 — the cold bake was then measured, and it KILLS the naive retune

`test_os_boot.js` under the same sampler (`--interval=250`, artifact
`build/rss-a4-osboot-cont538.json`):

```
  3.75 GB  test_os_boot.js               (2735 samples)
  0.56 GB  test_os_boot_kill_honesty.js  (7 samples)
```

**`HEAVY_GB = 4` is CORRECT — for the cold bake.** At a 3.75 GB peak the existing weight has almost
no headroom, and lowering it globally to ~2 GB would have over-committed RAM on the single heaviest
file in the suite. **The caution in the paragraph above was load-bearing: acting on the fixture
numbers alone would have been a real error, not a conservative one.**

**The actual defect is that the weight is UNIFORM, not that it is wrong.** One file needs ~4 GB;
the ~165 fixture-based tests need ~1-1.5 GB and are charged 4 GB anyway. So the fix is a finer
weight *class* — the A2 pool already models exactly this with `LIGHT_GB`/`HEAVY_GB`, so it is a
reclassification, not new machinery. That keeps 4 GB for the cold bake while letting the fixture
tests pack far denser, which is where the Finding 2 slack actually is.

🔴 **But do NOT retune `HEAVY_GB` on these numbers yet.** All three files
measured use the **prebaked fixture**. `test_os_boot.js` is the one file that
runs `--no-fixture` — a cold full bake — and it is the suite's longest file at
~710 s and the one most likely to be genuinely memory-heavy. **It is
unmeasured.** A retune driven by fixture tests alone would repeat exactly the
mistake Finding 3 catches: generalising from an unrepresentative sample.

Two known limits of the instrument itself, both from its own header: it
**samples**, so it understates true peaks (spikes between samples are missed —
`test_tty.js` at 0.0 s produces no row at all, and **"no row" is not "no
memory"**), and macOS compresses idle pages under pressure.

## Net assessment

Batch 1 is **green, regression-free, and worth ≈ −3.1% of kernel CPU-work**
(measured, see Finding 3). It did not deliver "50 → 40 min", and the plan's
estimate was optimistic partly because it mis-located the cost and partly
because it assumed A4 would widen the pool to `-j3` — A4 shipped only the
instrument, so that half was never collected.

What the batch actually bought is the measurement apparatus and the diagnosis:
the gate is 45% a **fully serial** browser sweep and 40% a kernel suite pinned
at exactly two concurrent boots. Neither was visible before. **That diagnosis
is worth more than the speedup**, and it redirects Batch 2/3 toward C1 and the
RAM weighting rather than toward job counts.

**Two methodological lessons this batch paid for, both the hard way:**
1. 🔴 **"The diff does not touch this file" is the WRONG test when the change is in shared
   infrastructure.** It correctly cleared the branch of the `blockfs` red (an independent suite) and
   it badly misled the `test_cmdalt_e2e.js` analysis (a file whose *dependencies* moved). Ask what a
   file depends on, not just whether it appears in the diff.
2. 🔴 **A partial measurement can point the opposite way from the full one.** Fixture tests said
   `HEAVY_GB` was 4x too big; the cold bake said it was exactly right. Refusing to act on the
   incomplete sample is what stopped a bad retune from landing.
