# 0153 — Run os-sweep.mjs under Playwright to confirm the 0146 harness conversion (goldens unchanged)

- **Status**: done (2026-07-15) — overtaken by events: the "Playwright never
  ran here" premise no longer holds. The full converted sweep has since run
  repeatedly on this machine: the 2026-07-12/13 triage of
  `todos/done/0170-browser-sweep-five-files-red.md` ran it end-to-end (all
  5 red legs were STALE TEST asserts — desk-entry/geometry hardcodes — not
  0146 conversion bugs; a harness bug would have failed many files at once,
  and 20/25 files ran green through the shared harness), and the idle-power
  Stage-4 close-out gate recorded a full **25/25** browser sweep
  (`logs/2026-07-14/idle-power-stage4.md`). That is strictly more evidence
  than this item's one-sweep acceptance asked for. Closed by the 2026-07-15
  queue reconciliation; no new work done under this id.
- **Design**: this file. Surfaced closing todos/0146 (shared test harnesses).

## Goal

0146 converted all 23 `tests/browser/os-*.mjs` acceptance files to import the
new shared `tests/browser/lib/os-harness.mjs` (serve spawn, `waitForServer`,
the WebGPU Chromium launch, `makeCheck`, and the `setVt`/`sample`/`near`/
`waitPixel`/`waitOut`/`waitScreen` page helpers). The conversion is
**byte-faithful and statically verified** — every file `node --check`s clean,
the harness's pure helpers are unit-tested (`tests/browser/lib/test-harness.js`,
green), and divergent one-off helpers (non-rect samplers, `near` tol 12,
width-only screen waits, 250 ms poll variants) were deliberately left inline.

But **Playwright is not installed in this clone**, so the converted files were
never RUN. A single real sweep confirms the refactor changed no observable
behaviour (goldens unchanged) and closes the one gap 0146 could not close here.

## Plan

- Install Playwright in the clone (the browsers are already cached), then run
  `node tests/browser/os-sweep.mjs` (serial by design — 0045 boot lock).
- Any failure is a conversion bug in ONE file (the harness is shared, so a
  harness bug fails many at once — an easy tell); fix in place, re-run.

## Acceptance

- The full `os-sweep.mjs` passes with the 0146 conversion, identical results to
  the pre-refactor sweep (pure refactor — no golden changes).
- Naturally overlaps the 0064 operator sweep (which runs the same files); this
  item just makes the 0146-specific "did the refactor break anything" check
  explicit and owned, rather than buried in 0064's WM scope.
