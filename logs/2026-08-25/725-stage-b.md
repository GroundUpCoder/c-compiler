# #725 stage B — preflight refusal, recovery, mid-run truncation + the counter-pass record

Range: on top of the counter-passed `71e89d65` (stage A `8e65926a..faae5776`,
counter-pass `faae5776..71e89d65`). Stage B is the half that can STOP a gate;
its failure mode is refusing healthy gates, so both directions carry evidence
(below).

## FINDING — a diagnostic message can be false while the assert that reads it passes (CPM4)

Sharper than "vacuous test", and worth its own entry (jku ruling: record it,
don't just praise it). During the counter-pass mutation ledger, deleting the
gate-lock grace branch left the leg-3c control GREEN because:

- the loud steal message printed **`[gate-lock] unparseable lock file (age
  0.0s > 2s grace)`** — a sentence that is *literally false* (0.0 is not
  greater than 2) yet matched the shape-only regex `/age [\d.]+s > 2s
  grace/`;
- the wall-clock backup assert (`>= 2s` around the whole gate) was satisfied
  incidentally by the ~7s todos run.

**The message and the assertion were wrong in a mutually consistent way: the
assertion matched the sentence's shape and never parsed the number the
sentence reported.** Fix (`71e89d65`): the control parses the reported age
and requires `>= 2` — re-running the mutation now goes RED with
discriminator `"0.1"`. Same defect class as #729 (noted there); found by the
mutation standard applied to this lane's own control.

Also for the record, CPM2's shape: applying the *same* 500 ms delay inside
the FIXED acquisition (between tmp-write and `linkSync`) stays green
(exactly one winner), while the same delay in the pre-fix shape makes both
dispatchers run (`{"a":0,"b":0}`). A negative control that discriminates
the *mechanism* — link-atomicity closes the window — not just the outcome.

## What stage B landed

- `verdict()` — refuse ONLY on the OS's own CRITICAL verdict
  (`kern.memorystatus_vm_pressure_level >= 4`) or the 1 GB
  reclaimable-inclusive floor; warn at OS level 2 / memorystatus <= 15%;
  a null instrument is an unmeasured AXIS; a wholly unmeasured sample can
  never refuse. 🔴 The thresholds CANNOT be validated against the
  2026-08-20 incident — it recorded neither instrument. They are chosen to
  stay quiet on measured healthy states and to fire on the platform's own
  verdict, not reverse-derived from the incident's raw numbers (which the
  calibration measurement showed are non-discriminating).
- Preflight with RECOVERY BEFORE REFUSAL: on critical, reap what is
  provably dead (dead-owner-gated), resample, and only refuse the residue —
  exit 2, `[host-health]` marker, per-runId environmental refusal record,
  NO summary.json, live consumers named (report-only), and the
  `CC_NO_HOST_HEALTH=1` override documented in the refusal message itself
  with its cost. In the incident state, recovery alone would have freed
  ~4.5 GB (the adopted mkimage) and the gate would have proceeded.
- Mid-run truncation at row boundaries: current + remaining rows go
  literally `fail`/`host-degraded`/"DID NOT RUN" (rule 5 stays red), run
  still summarized + archived. 🔴 HONEST COVERAGE: row boundaries are the
  QUIETEST instants of a run (the previous suite's children have exited —
  the kernel gate's own after-sample had *more* free memory than its
  before). Truncation protects a multi-suite run from grinding on an
  already-degraded box; it does NOT detect degradation developing
  mid-suite, and on a single-suite gate it adds nothing beyond the
  preflight. Sampling inside a running suite would make the gate an actor
  inside its own children — refused. The combined-range sweep (multi-suite,
  many boundaries) is where truncation's false-fire behavior gets its real
  validation set.

Safety property worth stating: the recovery reap cannot touch a live
sanctioned detached gate — its dispatcher matches no reaper pattern and its
children have live parents; only a DEAD gate's leftovers are ppid-1
candidates.

## Condition 2 evidence — both directions, proxies labeled

**Quiet direction (real measurements, three sources):**
- 41 samples at 5s intervals DURING a full real host-suite run:
  41/41 `ok`; pressure 1..1, memFreePct 66..66, availGb 6.63..7.44.
- 26 recorded samples mined from every gate summary on this branch —
  including the 25-minute 192/192 kernel gate's boundaries: 26/26 `ok`;
  pressure 1..1, memFreePct 66..67, availGb 7.13..9.97. (Also: `freeGb`
  read 3.79 there vs 0.07 in the calibration comment — same box, same
  healthy state, a fiftyfold spread; further proof `free` is noise and
  `pressure`/`availGb` are the stable signals.)
- ADVERSARIAL quiet: the bounded experiment below threw 6 GB of dirty
  residency at the box and the preflight still did not fire — the guard is
  not trigger-happy even under deliberate hostile load.

**Fire direction:**
- The refusal/truncation paths are proven by the `CC_HOST_HEALTH_FAKE`
  controls — **synthetic samples: a PROXY for a starved host, labeled as
  such**, not a measurement of one.
- Bounded real experiment (jku-approved rails: foreground, heavy lock
  checked free, stop-at-flip, child with 90s hard self-timeout + 6 GB cap +
  parent-watch preload): allocated and touched 6 GB in 256 MB steps.
  RESULT, stated honestly: **the pressure-2 flip was NOT reached.** availGb
  tracked the first ~2.5 GB genuinely (6.98 → 5.30) then plateaued ~5.27 as
  the compressor absorbed the (highly compressible, `fill(1)`) pages;
  pressure and memFreePct never moved; the child self-capped and released
  (availGb 5.28 → 7.12 within a second — the release visible in the data).
  So: real-signal evidence that the availGb axis responds to genuine load;
  NO real demonstration of the pressure flip — that would need to exceed
  the reclaimable pool (~8+ GB) or use incompressible fill, both of which
  chase the cap toward jetsam territory and were declined per the rails.
  Level-4 critical was never attempted (jku ruling: not a trade worth
  making on the shared box).

## Stage B mutation ledger (each in the working tree, control RED, reverted)

| # | mutation | RED at |
|---|---|---|
| BM1 | REFUSE_PRESSURE 4→99 | instrument-naming legs (the avail floor kept refusing — axis redundancy observed working) |
| BM1b | both refusal axes dead | leg 1: gate ran instead of refusing (4 legs) |
| BM2 | recovery skipped before refusal | leg 1 record-names-recovery |
| BM3 | CC_NO_HOST_HEALTH ignored | leg 4 (3 legs) |
| BM4 | truncation dead | leg 6 (5 legs; suite 2 ran to a pass) |
| BM5 | truncated rows softened to 'skip' | leg 6 never-a-pass + gate exit 0 caught |
| BM6 | refusal writes a summary.json | leg 1 absent-summary |
| BM7 | unmeasured refuses | leg 7 + 2 verdict unit legs |

## Verification

- `test_host_health.js` 47 legs, `test_host_preflight.js` 31 legs, full
  host suite green through the dispatcher (202.7s, all files).
- kernel leg for the A-range: 192/192, `done:true, filter:null, resumed:0,
  carried:0, executed=recorded=192`, elapsed ~25 min (verified from the
  artifact).
- Sweep: embargoed, jku's call, over the combined range — doubling as B3's
  false-fire validation set.

---

# Counter-pass 2 addendum (on top of stage B, tip after this range's docs)

## FINDING (generalized, per jku): a confident result manufactured by its own setup

Fifth instance in one week of one shape, across unrelated work: filenames
that disclosed the verdict; a prompt that made NO the only possible answer;
a transcribe-vs-judge substitution; CPM4's false sentence matching a
shape-only regex; and now **CPM1's amplified race window** — this lane
reported the gate-lock race control RED after widening the empty-lock
window to 500 ms. The reviewer reverted `linkSync` alone at NATURAL timing
and the whole control stayed green: the mutation had measured the
amplification, not the control. **The common shape: the setup guaranteed
the outcome. In every one of the five, the catch came from someone
RE-RUNNING the experiment, not from reading the report.** A mutation is
only evidence if it reproduces the defect at its natural magnitude; CPM2's
same-delay-in-the-fixed-shape green was the right kind of control
(discriminates the mechanism), but it cannot rescue an amplified CPM1.

The replacement control tests the INVARIANT rather than the race: leg 3a's
observer polls the lock during 300 real acquire/release cycles and requires
it NEVER be readable without its holder JSON, with an anti-vacuity floor
(>= 20 present-reads — a pass may not be produced by observing nothing).
Acceptance met at natural magnitude: `linkSync` reverted alone → RED with
28 violations across 1097 present-reads, first violation the empty string.
Leg 3d's own first run repeated the setup-guarantees-outcome shape in
miniature (the garbage lock was never pre-created, so the gate simply
acquired and ran) — caught and noted in the leg.

## Stated production limitation (jku-mandated, belongs beside the threshold note)

**The primary refusal signal — pressure >= 4 — has never been observed to
fire on this box by any real means.** The bounded experiment could not move
the instrument even to level 2, and level 4 is deliberately out of bounds.
The refusal path's primary axis is validated ONLY by injection (the labeled
proxy); `availGb` is the axis demonstrated to respond to real load. The
failure direction is under-firing (safe), and deferring to the OS's own
verdict remains right — but **the first real firing of this refusal will
also be its first real test.** This sits next to the earlier admission that
the 2026-08-20 incident recorded neither instrument: two of the same shape,
deliberately together.

Reusable mechanism note: **a compressible-fill allocator does not move
macOS memory pressure — the compressor absorbs it** (6 GB of fill(1) pages:
availGb plateaued ~5.27, pressure/memFreePct never moved). Synthetic
pressure testing on this platform requires incompressible fill, which
chases jetsam and was declined per the rails.

## Counter-pass 2 changes + mutation ledger

- Acquisition budget: 15s total, then loud exit-2 naming the wait (finding
  2 — the unbounded silent grace loop was the ticket's own defect
  reintroduced). Leg 3d: perpetually-refreshed garbage lock → refused in
  ~15s, never the harness timeout.
- PID-reuse discriminator (finding 3): a live holder pid whose ps command
  is not a tests/run.js dispatcher is stolen loudly ('PID reuse'); ps
  verification failure stays conservative (refuse — never steal on
  ignorance); 6h holder-age cap as backstop. Leg 3's stand-in holder is now
  a decoy that LOOKS like a dispatcher.

| # | mutation | RED at |
|---|---|---|
| CP2M1 | linkSync reverted ALONE, natural timing (the acceptance criterion) | leg 3a: 28 violations / 1097 present-reads |
| CP2M2 | acquisition budget removed | leg 3d: gate ground on 38.9s, no loud give-up |
| CP2M3 | reuse discriminator removed | leg 3e: refused instead of stealing (3 legs) |

---

# Counter-pass 3 addendum

## How the "dead-owner-gated" claim got made without being checked (finding 1, the answer jku required)

The stage-B design asserted recovery "reaps what is provably dead
(dead-owner-gated)". The claim's source was harness-leaks.js's own header —
"Reaping is never 'looks old' — it is 'the owning process is DEAD'" — read
during stage-A work and carried into the design ON FAITH. The header itself
overstated its code: classifyTempDir has two age-based branches (live-pid
past PID_REUSE_MS; untagged past UNTAGGED_STALE_MS) that reap without a
death proof, and a test in the tree explicitly pins the live-owner age
override. So this was PRINCIPLES' "a mechanism claim is a hypothesis until
re-derived from current source" failed twice over: I re-derived nothing at
the new call site, and the summary I trusted was itself wrong. Both are now
fixed — the header names its exceptions, and the automatic gate-time caller
uses provableOnly (age heuristics become KEEPS, named in the refusal
evidence as un-reclaimable suspects; the human-invoked default is
unchanged, and the two policies are pinned apart by paired legs).

**The symmetric principle, now recorded beside condition 3: no path may
soften a red — and no path may MANUFACTURE one.** An automatic recovery
that deletes a live run's fixture manufactures that run's failure: #725's
false-red class in destructive form, from inside the fix.

## The vacuous-control CLASS fix (finding 2's seam ruling)

Third vacuous control in one ticket (CPM4's false sentence; leg 3b at
natural timing; leg 6's wrong call map passing off the sticky last array
element). Per jku: fix the class, not the instance. The array fake now
fails loudly on misuse in BOTH directions — exhaustion THROWS naming the
count, unconsumed elements are reported at process exit — and leg 8 is the
seam's own red control. Legs 6/6b carry EXACT re-derived sample maps and
assert seam silence. During CP3M2a (after-check removed) the seam's
exhaustion throw fired mid-run on the map mismatch — the class fix
compounding the specific control's detection, observed working.

The near-fourth instance, caught in the same pass: the exact-bytes fix's
refusal message rendered 0.9999 GB as "1.000 GB < 1 GB floor" via
.toFixed(3) — a false sentence in a diagnostic, CPM4's shape exactly. The
dead-zone control caught it because it parses the number, not the shape.

## CP3 mutation ledger

| # | mutation | RED at |
|---|---|---|
| CP3M1 | provableOnly ignored | 2 provableOnly legs (live-owner reaped again) |
| CP3M2a | after-row verdict removed | leg 6b (suite 2 ran; + the seam threw mid-run on the now-wrong map) |
| CP3M2b | sticky last element restored | leg 8 (no crash; gate exited 0) |
| CP3M3 | rounded floor comparison restored | dead-zone leg (0.9999 GB read ok) |

---

# Counter-pass 4 addendum

## Two generalizations for the record (jku ruling — same family as setup-guaranteed-outcome: the work was correct where you were looking)

1. **When you fix a path, enumerate its siblings and state which ones you
   checked.** CP3's after-sample fix was written and CONTROLLED against the
   native row path; the batched python path — half the dispatcher, not an
   edge case — was left with the sibling defect, and on an all-py selection
   it produced a self-consistent-looking LIE: "TRUNCATING at '<category>'"
   naming an already-completed category, truncated.at set, no failing row,
   exit 0. An artifact that contradicts itself while looking healthy is
   worse than a crash — nothing downstream can tell. Fix: truncateFrom
   computes the unrun set FIRST and declares nothing when it is empty;
   controls now cover the batched sibling (legs 6c-a/6c-b, the latter with
   DISTINCT availGb values so the row proves WHICH sample decided — a
   discriminator that also keeps the mutation run from launching a real
   kernel suite).
2. **A new authoritative check must dominate the heuristic it supersedes,
   not queue behind it.** CP2's ps identity check was added precisely to
   replace age-guessing — and was placed AFTER the 6h age cap, so a
   VERIFIED live dispatcher got robbed for running long, recreating the
   two-dispatchers-one-dir defect the lock exists to prevent. Order now:
   identity first (verified dispatcher authoritative regardless of age;
   live non-dispatcher stolen loudly); the age cap survives only where
   verification itself FAILS — the one place an unverifiable ancient lock
   would otherwise wedge forever. Control: leg 3f (7h-old record +
   verified-live decoy → refused).

## CP4 mutation ledger

| # | mutation | RED at |
|---|---|---|
| CP4M1 | truncateFrom emptiness check removed | leg 6c-a: phantom TRUNCATING + self-contradicting summary |
| CP4M1b | py-after verdict removed | leg 6c-b: decision sample 0.3 (next-before) instead of 0.4 (after); kernel STILL never launched — the distinct-value safety held under mutation |
| CP4M2 | age cap restored ahead of identity | leg 3f: aged verified dispatcher robbed, gate exit 0 |
