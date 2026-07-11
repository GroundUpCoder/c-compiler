# 0084 — Unified test entry point with diff-aware selection

- **Status**: DONE (2026-07-12). Landed `tests/run.js` — a thin dispatcher
  over the existing runners (run-unit, run.py categories, host, blockfs,
  kernel, os-sweep) with `all`/named-suite/`--diff [ref]`/`--dry-run`/`--list`
  modes, a committed UNION path→suite rule table (the single source of "what
  does this diff need"; unmapped code paths warned, never silently skipped),
  batched run.py invocation, per-suite passthrough flags, and a merged
  `build/test-run/summary.json` + combined exit code. CLAUDE.md's new "Running
  tests" section and README's Tests section point at the rule table instead of
  prose lore. Acceptance verified: compiler.js diff → unit+kernel+blockfs,
  os/wm.c diff → kernel+sweep, `all` == the full estate. Dev log:
  `logs/2026-07-12/0084-test-entrypoint.md`.
- **Design**: this file (spawned from `todos/done/0081`)

## Goal

After 0081 the suites share one engine (`tests/lib/suite-runner.js`)
and one artifact convention (`build/test-*/summary.json`), but there is
still no single command that runs "what my diff needs": knowing that an
`image.json` edit requires the kernel e2e family + os-shell's menu
lists, or that a host.js SDL change requires the browser sweep, is
HANDOFF/CLAUDE.md lore, not tooling.

## Plan

- A thin `tests/run.js` dispatcher over the existing runners (run-unit,
  run.py categories, kernel, blockfs, os-sweep) with uniform flags —
  the runners stay independently invocable.
- `--diff [ref]` mode: map touched paths → suites, from a small
  committed rule table (e.g. `compiler.js` → unit+kernel+blockfs;
  `host.js` fd/SDL paths → kernel+sweep; `os/` or `image.json` →
  kernel e2e + sweep; `todos/`/docs → nothing). Print the plan before
  running; `--dry-run` to just print.
- One combined exit code + a merged summary artifact.
- Documentation: replace the "run the full sweep after touching X"
  lore in CLAUDE.md/HANDOFF with the rule table (single source).

## Acceptance

- `node tests/run.js --diff` on a sample compiler.js edit picks
  unit+kernel+blockfs; on an os/wm.c edit picks kernel e2e + sweep.
- `node tests/run.js all` == today's full estate, one command, one
  summary.
- The rule table is the documented source of "what does this diff
  need" (CLAUDE.md points at it instead of prose lore).
