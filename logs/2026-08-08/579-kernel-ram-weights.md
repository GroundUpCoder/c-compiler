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
