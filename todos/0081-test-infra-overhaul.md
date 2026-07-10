# 0081 — Testing infrastructure overhaul: holistic architecture — solid, fast, lightweight

- **Status**: open
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

## Acceptance

- Kernel suite wall-clock cut substantially (target: 2-4x) with a
  timing/summary artifact per run; survives an interrupted session with
  a usable partial verdict.
- Browser sweep runnable as ONE command with per-test pass/fail summary.
- No `sleep`-magic-number synchronization left in the suites it touches.
- Sub-items created and queued for anything not landed directly here.
