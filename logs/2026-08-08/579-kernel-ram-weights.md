# #579 — the kernel pool's RAM weight is per-class, not a uniform `HEAVY_GB = 4`

Lane `lane-579weights`. Box held idle by @master for the duration: every number
below is from a full unfiltered kernel suite on an otherwise idle 16 GB / 10-core
box, sampled by `tests/lib/rss-sample.js` at 500 ms.

## What was wrong

`tests/kernel/run.js` had one line doing the classification:

```js
for (const e of entries) e.gb = e.light ? LIGHT_GB : HEAVY_GB;
```

Binary, over a pool that already models per-row weights. 148 of 169 rows were
charged 4 GB. Concurrency is `floor(budget / weight)` and the budget is
`totalmem × 0.6 = 9.6 GB`, so the suite ran at **mean 2.01 concurrent files**
against a declared `jobs: 6`. The CPU cap never bound.

## The measurement flipped half the premise

The ticket was filed on "HEAVY_GB is ~4x too conservative". It is — for 118
rows. It is also **too small for two**, which nobody had noticed:

| row | peak RSS | was charged |
|---|---|---|
| `test_punes_e2e.js` | **5.46 GB** | 4 |
| `test_gucman_e2e.js` (won the bake race) | **4.80 GB** | 4 |
| `test_defaults_sync_e2e.js` | 4.09 GB | 4 |
| `test_os_boot.js` (cold bake, best-sampled row at 1496 samples) | 3.76 GB | 4 |
| 118 fixture-boot rows | ≤ 1.46 GB | 4 |
| 21 LIGHT rows | ≤ 0.17 GB | 1 |

So this is not a global reduction. One class moved down hard, two moved up.

**Two runs, not one — and that is the load-bearing methodology note.**
`test_micropython_stdlib_e2e.js` and `test_micropython_script_e2e.js` read
**1.01 GB in the first run and 1.46 GB in the second**, 45% apart. My first cut
sized the BOOT class off run 1 at 1.5 GB, which run 2 revealed as **1.03x
headroom** on 118 rows. Every published weight is now the worst of both runs
with margin on top. A weight picked off a single sampled run is not safe:
the sampler under-states by construction, and the spread between runs is
larger than the margin a careless reading would leave.

## The classes

| class | rows | worst of both runs | weight | headroom |
|---|---|---|---|---|
| `LIGHT` | 21 | 0.17 GB | 0.5 | 2.9x |
| `BOOT` | 118 | 1.46 GB | 2 | 1.37x |
| (untagged default) | 10 | 3.76 GB | 4.5 | 1.20x |
| `PKG` | 19 | 4.09 GB | 5 | 1.22x |
| `test_punes_e2e.js` | 1 | 5.46 GB | 7 | 1.28x |

Two design rules the numbers forced:

- **The default stays conservative.** An untagged row still gets the heavy
  weight, so a new e2e is over-charged rather than under-charged. `BOOT` is an
  assertion about a *measurement*, so it is applied only to rows that have been
  sampled. 10 LIGHT rows and 4 default rows finish inside one 500 ms tick and
  produced no sample row in either run — **"no row" is not "no memory"**, and
  those 4 are exactly why the default cannot be lowered to fit them.
- **`PKG` is derived from the source, not declared.** The class is "does this
  file call `ensureMinimalImage()`", which is a property of the member's text.
  A hand-maintained mirror of a source property goes stale silently (#314's
  whole lesson) — and a stale entry here does not merely hide a test, it
  under-charges a 3.5 GB `mkimage`.

`PKG_GB = 5` is also load-bearing as a **serializer**: two at once is 10 GB >
the 9.6 GB budget, so the pool never runs two `mkpkg` builds concurrently. And
`4.5 + 5 = 9.5` deliberately still fits, so one `PKG` row can run *alongside*
`test_os_boot.js` — that last 0.1 GB of slack is why the default is 4.5, not 5.

## The hoist (why the PKG weight is honest rather than merely large)

Every `PKG` row called `ensureMinimalImage()` lazily against one cached path
**with no lock**, so the minimal blob was baked *inside the pool* by whichever
row won the race — 4.80 GB peak for that row against 1.05 GB warm. Charging all
19 rows for a spike that happens at most once per tree is the same
"one weight for everything" defect one level down.

It is now a pre-step beside `ensurePrebakedImage()`, the idiom the fat fixture
already uses, gated on the filtered selection containing a `PKG` row. Controlled
both ways: `--filter=test_kernel.js` (non-PKG) leaves the deleted blob **absent**;
`--filter=test_gucman_sources_e2e.js` (PKG) prints
`[gucman] baking the minimal (no-packages) system blob…` *before* the suite
banner. It also closes the unlocked double-bake — two PKG rows admitted together
could previously run two full `mkimage` processes at once.

## Results (clean A/B, both warm-pool, same tree, idle box)

| | wall | concurrency mean | max | peak summed RSS |
|---|---|---|---|---|
| old weights | 1153.8 s (19.23 min) | 2.00 | 3 | 5.44 GB |
| **new weights** | **879.1 s (14.65 min)** | **2.67** | **5** | 5.78 GB |

**−274.7 s, −23.8%.** Both runs 169/169 pass, `done: true`, `filter: null`,
`executed == selected == total == 169`, 0 carried.

Peak summed RSS across all live trees rose only 5.44 → 5.78 GB — i.e. the pool
is using ~60% of its 9.6 GB budget, so the higher concurrency bought throughput
without spending the safety margin.

Flake tripwire (`node tests/flake.js --kernel-only`, `--repeat 3 --under-load ×10`):
**green, 12/12, all four files 0% flake.** This is the check that matters here
because memory pressure does not present as ENOSPC, it presents as timeouts.

### The confound I had to remove

My first baseline measured 1289.5 s, but it ran with a **cold mkpkg pool**:
`test_git_net_e2e.js` took 258.9 s there and 4.0 s warm — 255 s of one-time
work that the after-run did not pay. Comparing against it would have inflated
the win to 41%. The 1153.8 s figure above is a re-measured warm baseline on the
*unmodified* `run.js`, so the pair differs only in the weights.

(`git_net`'s 4.0 s was checked against the real risk: its log shows all 27
assertions — multi-MB pack transfer, server-side `git fsck --strict`, auth,
301 redirect — and `ALL OK`. It was warm, not skipped.)

## Where the remaining time goes — and why it is not a weight problem

`test_os_boot.js` alone is 718 s of the 879 s wall. During it the pool has
`9.6 − 4.5 = 5.1 GB`, which is two `BOOT` rows plus a `LIGHT`, so width sits at
3 for 700 s of the run. The `BOOT` work does not quite fit inside that window
and ~160 s spills past `os_boot`'s exit.

Getting below ~879 s therefore needs **more RAM or a shorter
`test_os_boot.js`**, not a smaller weight: at `BOOT_GB = 1.5` a third slot
opens (`4.5 + 4.5 = 9.0`) and the wall drops to 765 s — measured — but that is
1.03x headroom on the class's measured peak, which is how you buy 114 s with
timeouts later. The 765 s number is real and deliberately **not** what shipped.

## Follow-ups worth a ticket (not done here)

- The `mkpkg` pool build is still in-pool (4.09 GB, `test_defaults_sync_e2e.js`)
  and is what sets `PKG_GB`. Hoisting it the way the blob bake now is would let
  the 19 `PKG` rows drop toward their ~1 GB resident cost. It is a bigger change
  than the blob hoist: each caller passes its own `need` list, and the
  `--clang`/`--rust` superset repos complicate a single up-front build.
- `test_punes_e2e.js` at 5.46 GB is the heaviest tree in the suite — heavier
  than the cold bake — for 15 s of work. Three sequential boots in one file.
- Free disk sat at 9.2–9.4 GB throughout and the runner warns about it. Higher
  concurrency means more live ~150 MB per-file fixtures at once; this did not
  bite, but it is the other resource whose exhaustion also presents as timeouts.

---

# CORRECTION after the Codex review (tip `d50c6aa6`)

The review returned RED on one blocking finding, and it was right. Everything
above the line stands as a record of what I measured; three claims in it are
**wrong** and are corrected here rather than quietly edited, because the way
they were wrong is the reusable lesson.

## 1. `PKG_GB = 5` was below observed RSS — in the shipped config's own artifact

`build/rss-579-final.json` — the run of the configuration I shipped — records
`test_gucman_e2e.js` at **5.344 GiB** and `test_defaults_sync_e2e.js` at
**5.080 GiB**, both charged 5. My class table said "4.09 GB worst / 1.22x"
because I built it from **two** artifacts and then produced a third without
re-reading it. I had already corrected exactly this class of error once (BOOT,
1.01 → 1.46) and did not apply the same discipline to PKG.

Re-measured solo + serial at 250 ms, where there is no co-scheduling
attribution ambiguity (`build/rss-579-pkgsolo.json`, 3x each):

| row | solo peaks | under full-suite load |
|---|---|---|
| `test_gucman_e2e.js` | 4.88 / 4.69 / 4.59 GiB | 5.344 |
| `test_defaults_sync_e2e.js` | 4.28 / 4.10 / 3.74 GiB | 5.080 |

**Contention inflates a tree's peak** (phases that are sequential on a quiet box
overlap on a loaded one), so a solo measurement is a floor, not the answer.

`PKG` and `punes` are now one **XL class at 7 GiB** — one physical shape, a full
boot with a second heavy node process resident beside it. XL=7 keeps the
serializer property (2 XL = 14 GiB, unreachable under 24 GB RAM) and gives up
the `4.5 + 5 = 9.5` pairing with `test_os_boot.js`, which was never a memory
margin in the first place: PKG's real peak was *above* its own reservation.
`test_os_boot.js` gets its own weight (5); that is free, because `9.6 − 5` still
admits 2 BOOT beside it exactly as `9.6 − 4.5` did.

**The methodology lesson: the observed maximum CREEPS UP with every run added**,
because each run samples more of the same tail — `gucman_e2e` went
3.92 → 4.80 → 5.344 across three runs. "Worst of N runs" is itself biased low.
Treat any headroom under ~1.2x as not yet proven.

## 2. The hoist rationale rested on a figure I misread

I wrote that the blob bake cost a PKG row 4.80 GiB "against a 1.05 GB peak for
the same row once the blob is warm". **1.05 was `test_cc_win32_e2e.js`'s
number.** Warm `gucman_e2e` is 4.59–4.88 solo. The bake is *not* the dominant
cost of these rows.

That also **refutes my own follow-up proposal** from the section above — hoisting
the mkpkg pool build would not have helped either. The pool was already warm
(20:39) before the run that recorded 5.344 (~21:0x), so that 5.344 is the row's
intrinsic cost, not a cold-pool artifact. Do not file that follow-up.

The blob hoist is **kept**, but only for what it actually buys: the unlocked
double-bake is gone, and a cold tree pays the bake once, up front and visibly,
instead of inside one arbitrary row. Its comment now says that instead of
claiming a memory saving.

## 3. The headline win shrinks

The −23.8% figure was measured against a PKG weight that was unsafe. At correct
weights the win is roughly **1153.8 s → ~984 s, about −15%**. The 879.1 s and
765.2 s numbers are both retired for the same reason: they were bought with
headroom I did not have.

## Not yet green — the gate at XL weights is OWED

The XL run was **168 pass / 1 FAIL**: `test_os_boot.js` timed out in its
fixture-boot leg at the 300 s `CC_OS_BOOT_TIMEOUT_MS` budget. Wall 984.1 s,
os_boot 798.6 s.

The weights cannot be the cause: pool width *around* os_boot is unchanged
(`9.6 − 5` → 2 BOOT + 1 LIGHT; `9.6 − 4.5` → 2 BOOT + 2 LIGHT), and XL=7
*removes* load because an XL row can no longer co-run with os_boot at all.
os_boot's duration across runs was 723 / 748 / 716 / 697 / **797** s — the
outlier is the last one chronologically.

What did change is the machine: **free disk on the data volume fell to 7 GB of
460 (99% full)** during the session, and the runner's own preflight warns that
exhaustion there "reports as timeouts, not as ENOSPC" — precisely this failure's
shape. Reproducibility could not be tested: lane `580-additive-publish` took the
heavy lock at 23:01:20 and the re-run was refused at **exit 3 (inconclusive, not
red)**. Measuring under a sibling heavy suite is the one thing this ticket's own
method forbids, so it stopped there.
