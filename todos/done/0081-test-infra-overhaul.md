# 0081 — Testing infrastructure overhaul: holistic architecture — solid, fast, lightweight

- **Status**: done (2026-07-10). Surveyed + measured (findings below),
  then landed the runner layer: `tests/lib/suite-runner.js` (one engine)
  + kernel runner v2 (parallel: 20min → 6.5min at `-j4`, 40/40 green) +
  `tests/browser/os-sweep.mjs` (the sweep as ONE command: 15/15 green in
  ~70s with a fresh prebake) + blockfs runner conversion — all with
  per-file logs, checkpointed `summary.json`, `--resume`/`--filter`/
  `--fail-fast`, per-file timeout with process-group kill. Residue
  spawned as sub-items: **0082** (prebaked-image fixture for boot.js
  e2e — the remaining 97%-of-serial-cost bake), **0083** (retire the
  ~205 sleep-N sync sites — the flake class; the runners themselves
  carry none), **0084** (unified entry point + diff-aware selection).
  Dev log: `logs/2026-07-10/test-infra-overhaul.md`.
- **Design**: this file (user-requested at the 0061 close). This is an
  ARCHITECTURE item: survey first, then spawn concrete sub-items
  (`queue.js add`) for each workstream rather than one mega-landing.

## Goal

The test estate has grown by accretion and it shows. Symptoms observed at
the 0061 close (2026-07-10):

- **The kernel suite is a ~20-minute serial monolith** (41 files, one
  `spawnSync` each, `stdio: 'inherit'`). Most files boot the whole OS
  (bake + mount + hush) from scratch — the boot cost dominates, paid up
  to 41 times. Two attempts to run it in a background shell died with the
  session and left NO partial verdict the second time (output piped
  through `tail` = fully buffered until exit; the rerun wrote per-file
  but still lost the tail) — the suite has no checkpointing, no per-file
  timing, no resume, no summary artifact.
- **Three-plus runners with different conventions**: `tests/run-unit.js`
  (parallel workers, per-test timeout — the good one), `tests/run.py`
  (categories, serial, subprocess-per-test), `tests/kernel/run.js` (dumb
  serial list), plus per-domain runners (`tests/blockfs/run.js`) and the
  MANUAL `tests/browser/os-*.mjs` sweep (15 files, each spawning its own
  serve.js + Chromium + full OS boot; serial by convention because of the
  0045 boot lock; ~1-2 min each).
- **Sleep-based synchronization** in the e2e/browser tests (`sleep 4` for
  "wasm boot + first paint", 200ms pixel polls with 30-60s ceilings) —
  slow when things are fast, flaky when the machine is loaded (the 0074
  os-doom "deterministic failure" class; concurrent kernel-suite +
  browser-sweep runs contend enough that this session serialized them
  defensively).
- **Redundant full boots**: wm_service/os_apps/cairo/gdi32/user32/
  kernel32/winmine/calc/notepad/fileman/ctlpanel/term e2e each bake or
  copy an image and boot hush to run a few shell lines. A shared
  booted-image fixture (or a persistent kernel driven over multiple
  scripts) would collapse most of that wall-clock.
- No single `make test`-equivalent that runs "what my diff needs" —
  knowing that an image.json edit requires wm_service + os-shell menu
  lists + a rebake is HANDOFF lore, not tooling.

## Plan (survey → spawn sub-items)

1. **Measure**: per-file timing for kernel suite + browser sweep; count
   boots/bakes; find the top wall-clock sinks. Write the findings into
   this file.
2. Spawn sub-items (likely shape):
   - kernel-suite runner v2: parallel where safe (worker_threads tests
     are independent; distinct tmp images), per-file timeout + timing,
     `--filter`, fail-fast flag, JSON summary artifact, resume.
   - shared boot fixture for the e2e family (one baked image copied per
     test; one booted kernel reused across script-driven tests where
     isolation allows).
   - event-based waits to replace `sleep N` (wmctl-observable conditions,
     __osOut markers, surface-created events) — kill the sleep class.
   - browser sweep orchestrator: one serve.js + one Chromium instance,
     sequential pages (respecting the 0045 lock), shared trace-on-fail.
   - unify categories under one entry point (run.py absorbing kernel/
     blockfs lists, or a thin `tests/run.js` dispatcher) with a
     "what does this diff need" mode keyed on touched paths.
3. Keep the invariants: tests stay deterministic, browser sweep stays
   real-Chromium, per-test isolation where the test asserts persistence
   (registry-across-boots etc.), and `run-unit.js`'s worker model is the
   template, not a casualty.

## Findings (measured 2026-07-10, 10-core mac mini)

Per-file timings from the new runner's `summary.json` (first full run,
`-j4`, all 40 files green):

- **Serial cost of the kernel suite = 1354s (~22.6 min)** — matching the
  observed ~20-min monolith. Parallel wall-clock at `-j4`: **393s
  (6.5 min), a 3.4x cut**, zero flakes across the boot-heavy family.
- **16 files >30s account for 1315s — 97% of the suite.** Every one is a
  boot.js e2e that bakes a full system image (compiling every seeded
  source + vendor binary via compiler.js) into its private tmp image.
  Top sinks: test_os_boot 168s (three bake legs by design), test_term
  124s, test_wm_service 111s, test_user32 90s, notepad/winmine ~84s.
  The other 24 files sum to ~40s — the no-wasm SAB-protocol class is
  effectively free.
- **The bake is the whole story**: the browser sweep already dodges it
  when a prebaked `os/os-system.img` exists (kernel-worker fetches it;
  mkimage output was present this session), but **headless boot.js has
  no prebake path** — each of the 16 e2e files re-bakes an identical
  v43 blob. A bake-once fixture (version- AND input-freshness-gated so
  uncommitted compiler.js/os edits still force a re-bake) is the next
  multiplier: est. 40-60s saved per heavy file.
- **Sleep-based sync sites counted**: ~145 `sleep N` lines across the
  kernel e2e boot scripts, ~60 `waitForTimeout`/sleep sites across the
  15 browser tests. Too broad to convert in this item; needs a shared
  wait-for-condition helper design (wmctl-observable states, __osOut
  markers) — spawned as a sub-item.
- **BlockFS suite**: 15 files, wall-clock == test_fuzz (121s); parallel
  conversion was nearly free (engine reuse), serial tail eliminated.

## Landed here (2026-07-10)

- `tests/lib/suite-runner.js` — ONE engine for file-granular suites:
  worker pool with longest-first scheduling from the previous run's
  timings, per-file timeout with process-GROUP kill (boot.js children
  can't be orphaned), per-file logs, an incrementally checkpointed
  `summary.json` (atomic rename after every completion — an interrupted
  session keeps a usable partial verdict), `--resume` (skip prior
  passes), `--filter`, `--fail-fast`, `--list`, `-j/--serial`.
- `tests/kernel/run.js` v2 over the engine (default `-j` 4, capped at
  cpus-2; artifacts in `build/test-kernel/`). Parallel-safety audited:
  every e2e already isolates via mkdtemp + `--image=`, no shared ports,
  no shared build/ writes.
- `tests/browser/os-sweep.mjs` — the browser sweep as ONE command:
  discovers `os-*.mjs` (new acceptance files join automatically),
  serial by design (0045 boot lock + contention), same artifacts under
  `build/test-browser/`.
- `tests/blockfs/run.js` converted to the engine (parallel, `--long`
  preserved).
- CLAUDE.md + tests/browser/README.md updated.

## Acceptance

- Kernel suite wall-clock cut substantially (target: 2-4x) with a
  timing/summary artifact per run; survives an interrupted session with
  a usable partial verdict.
- Browser sweep runnable as ONE command with per-test pass/fail summary.
- No `sleep`-magic-number synchronization left in the suites it touches.
- Sub-items created and queued for anything not landed directly here.
