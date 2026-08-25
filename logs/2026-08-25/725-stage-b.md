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
