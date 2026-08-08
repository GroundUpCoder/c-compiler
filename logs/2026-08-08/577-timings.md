# #577 — regenerate tests/kernel/timings.json from one named clean full run

Seed run: full unfiltered `node tests/kernel/run.js` on tree `5284515b` (main),
`startedAt 2026-08-08T08:28:35.346Z`, idle box, default jobs (6). Verdict from
`build/test-kernel/summary.json`: `done: true`, `filter: null`,
total = selected = executed = recorded = **169**, all 169 results `pass`,
zero carried, zero null timings, `elapsedMs 1266124` (~21.1 min suite time,
plus a one-time 205.9 s fixture bake in the fresh worktree).

Regenerated with `node tests/lib/update-timings.js` (no hand edits).

## What changed

- **Coverage 166 → 169.** Three kernel test files had NO hint at all (not in
  the ticket — found while scoping): `test_boot_guard_e2e.js` (now 1006 ms),
  `test_comp_park_e2e.js` (1934 ms), and `test_git_net_e2e.js` — which
  measured **259462 ms**, a top-5 longest file. An unhinted file cannot be
  sorted longest-first, so A1 was blind to one of the files it most needed to
  front-load.
- **`test_cmdalt_e2e.js` 237180 → 4228 ms** (the ticket's 56x entry).
- **`test_gcode_native.js` 2580 → 12077 ms** (4.7x).
- **`test_git_e2e.js` 2213 → 3960 ms** (1.8x, under the 2x bar).

Only the two entries above moved >2x. Neither test file has a commit since
before the old table's `from` date (2026-08-06), and both new values match the
2026-08-08 10:56 clean gate's independent measurements in the ticket body
(4.2 s / 12.1 s) — two independent runs agree, so the old hints were wrong,
not the runtimes. The old table's provenance was unrecoverable (timestamp but
no SHA), so no further root-cause of the 237 s value is possible; the repair
is exactly this regeneration, now with SHA + timestamp recorded in the commit.

## Observation (not acted on)

The ticket describes the pool as admitting 2 concurrent boots and a full run
costing ~53 min; this run reported `6 jobs` and finished the suite in 21.1
min, with per-file numbers matching the ticket's reference measurements. Hint
quality is unaffected (per-file durations, relative order is what A1 sorts
on), but the ~53 min full-gate cost figure looks stale against current main.
