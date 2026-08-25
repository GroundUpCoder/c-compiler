# #725 stage A — gate evidence retention + orphan-safe reclamation

Lane: `lane/725-gate-health`, base `8e65926a` (= deployed v280). Stage A is
the EVIDENCE half of #725 — nothing in this range can refuse or stop a
healthy gate. Stage B (host-health preflight refusal + mid-run truncation)
follows as a separate commit range on the same branch, per jku's staging
condition.

## The calibration trap (the load-bearing finding — recorded on #725 first)

Measured before designing any threshold: a HEALTHY idle Mac shows
74 MB free / 846 MB swap / 2.3 GB compressor — indistinguishable from the
ticket's 2026-08-20 "starved" evidence (102 MB / 854 MB / ~2.5 GB) on two of
three axes, with 5.3 GB reclaimable hiding in inactive pages and the OS
pressure verdict reading 1 (normal). Thresholds derived from the incident's
raw numbers would false-refuse healthy gates — converting a ticket about
false reds into a generator of false refusals. The discriminating
instruments are the platform's own: `kern.memorystatus_vm_pressure_level`
(1/2/4), `kern.memorystatus_level` (%), and reclaimable-inclusive available
memory as a backstop. `tests/lib/host-health.js` reads exactly those;
raw free/swap/compressor ride along as evidence fields only.

## What landed (commit order)

- **A1** — consume child stderr in the serve/bridge-spawning harnesses
  (test_first_run, test_clang_overlay, kernel lib/gucman [shared], os-git-net,
  test_gucman_e2e fault-repo; host_ceiling → stdio ignore). The 2026-08-25
  ship-gate red ("serve.js exited early (code 1)") was unattributable because
  the one stream that said why was piped and discarded — mechanism confirmed
  on #725 before this lane started.
- **A2** — 42 browser harnesses spawned `server.mjs` with both pipes
  discarded (+4 forwarding stderr only); all now forward both, the
  quake-renders.mjs pattern. Evidence-only: the server's lifetime output is
  ~90 bytes.
- **A3** — `tests/lib/host-health.js`: sample() + pure parsers +
  suspectFromSamples(). The label carries ONLY a `why` list — no verdict or
  directive fields, pinned structurally by `test_host_health.js`.
- **A4** — dispatcher evidence retention: runId, per-suite transcript tee,
  `history/<runId>/` archive (dispatcher summary + child suite summaries +
  every non-pass row's per-file log), prune to 20, per-row before/after host
  samples, `hostSuspect` on failing rows, `.gate-lock` (live holder → exit 2
  `[gate-lock]`, dead → steal). Canonical artifact semantics unchanged;
  `--out` isolation preserved (test_heavylock_gate still green untouched).
  The concrete incident this closes: the failing kernel summary of the
  2026-08-25 pre-deploy sweep was merged over by diagnostic reruns within
  minutes.
- **A5** — orphan reclamation. `harness-leaks` ORPHAN_PATTERNS gains a
  ppid-1 `tools/mkimage.js` bake and a ppid-1 `tests/run.py` batch. The
  mkimage entry INVERTS the old test assertion "a detached mkimage is a
  bake, not a leak" (two-sided edit per PRINCIPLES): the 2026-08-20
  starvation WAS an adopted mkimage, and a deliberate bake always has a live
  parent. image-fixture/serve.js spawn mkimage under `-r parent-watch`; the
  dispatcher preloads it into node suite runners.
- **A6** — `git()` failure in the diff planner now refuses at exit 2 with
  git's stderr. Before: any git error (bad ref included) coalesced to "no
  changed files" → empty plan → exit 0, a silent green.
- **A7a** — corrected the A1 comments' "~64KB blocking" claim to the
  measured boundary (below).

Filed **#736** for the audited remainder (rejection messages that drop
captured output + missing startup timeouts) — Category 2 of the estate
audit, evidence-omission only, no blocking hazard.

## Live specimen, mid-lane

Killing a serve.js-spawning test in the cold worktree left serve.js orphaned
at ppid 1 with its mkimage child still baking — the exact #722 adoption
chain, reproduced by accident before A5 existed. serve.js's parent watchdog
cannot fire while it is blocked in the bake's spawnSync; only the child's own
ppid poll (the preload) or the next run's reaper can reach it.

## Measured: the pipe-wedge boundary

The audit (and the A1 comments as first written) claimed an unread pipe
blocks a child at ~64KB. Measured on this host: a `/bin/sh` child writing
123 KB to an unread pipe exits freely; at 10 MB it WEDGES until killed,
while a consuming harness drains the same 10 MB in ~300 ms. Node/libuv
pre-buffer well past the kernel's 64KB. A pure-Node child (serve.js,
mkimage) never wedges at all — async pipe writes queue in userspace, so the
failure mode there is unbounded memory + lost evidence rather than a hang.
Comments corrected in A7a; the fix (consume the stream) is identical either
way.

## Mutation ledger (each broken in the working tree, control RED, reverted)

| # | mutation | control that went RED |
|---|---|---|
| M1 | SUSPECT_PRESSURE 2→99 | test_host_health: 4 suspect legs |
| M2 | parseVmStat compressor label broken | test_host_health: compressor leg |
| M3 | attachHostSamples never labels | test_gate_history leg 7 (suspect) |
| M4 | label upgrades status to 'pass' (the FORBIDDEN path) | leg 7 never-a-pass pin |
| M5 | gate-lock treats live holder as dead | leg 3: ran instead of refusing (4 legs) |
| M6 | archiveRun disabled | leg 1 archive (run crashes in leg 2) |
| M7 | tee disabled | leg 1 transcript |
| M8 | git() refusal reverted | leg 6: bad ref exited 0 again (3 legs) |
| M9 | mkimage+run.py orphan patterns removed | test_harness_leaks: 3 legs |
| M10 | preload stripped from the chain control | chain leg: child survives |

Plus the stderr demonstration: against a stub failing verbosely, the fixed
harness reports the failure WITH stderr in ~100 ms; the pre-fix shape reports
"stderr discarded"; and at 10 MB the pre-fix shape converts the failure into
a timeout wedge (see boundary above).

## Found by its own control (recorded limitation)

The A5 chain control's FIRST run went RED for a real reason: a parent that
dies inside the child's ~100 ms node bootstrap leaves parent-watch
uninstalled — `process.ppid` already reads 1 at startup, which parent-watch
(by design) treats as intentional detach. The preload therefore has a narrow
uncovered window; the reaper patterns are the net under it. Recorded at the
control's settle comment.

## Verification (this range)

- `node tests/run.js --diff origin/main --dry-run` → mandates unit, host,
  blockfs, kernel, sweep.
- Ran green via the new dispatcher: unit 16.2 s; blockfs 86.4 s 15/15;
  host 146 s, all files (registry guard accepted the two new tests).
- kernel + sweep pending under the gate embargo — jku decides when.
