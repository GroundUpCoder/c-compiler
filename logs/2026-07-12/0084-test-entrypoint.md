# 0084 — Unified test entry point with diff-aware selection

**Landed** `tests/run.js`: one dispatcher over the whole test estate, plus a
committed path→suite rule table so "what does this diff need" is tooling, not
HANDOFF/CLAUDE.md lore.

## What it is

A thin `spawnSync` orchestrator — the underlying runners
(`tests/run-unit.js`, `tests/run.py` categories, `tests/host/run.js`,
`tests/blockfs/run.js`, `tests/kernel/run.js`, `tests/browser/os-sweep.mjs`)
stay independently invocable; `run.js` just knows how to invoke them
uniformly and how to pick the right ones for a diff.

- `node tests/run.js all` — the whole estate, one combined exit code + a
  merged `build/test-run/summary.json`.
- `node tests/run.js unit kernel` — named suites (`--list` enumerates).
- `node tests/run.js --diff [ref]` — map touched paths → suites, run exactly
  those. Default is the working set vs HEAD (staged+unstaged+untracked); pass
  a ref to diff against it. `--dry-run` prints the plan and runs nothing.
- Passthrough: `--filter=STR` to every suite; `-j N`/`--resume`/`--fail-fast`
  only to the suites whose runner accepts them (a per-suite `supports` set, so
  we never hand run.py a `-j` it doesn't parse).

## Design decisions

- **UNION rule semantics, not first-match.** Every rule whose regex matches a
  changed path contributes its suites; the plan is the union. A file matching
  both a specific rule (`vendor/sameboy/`) and a generic one (`vendor/`) gets
  both suite sets. This keeps the table additive — you never have to worry
  about rule ordering shadowing.
- **IGNORE is a separate first tier.** Docs/todos/logs/README/LICENSE drop out
  BEFORE the union pass, so a `.md` under `vendor/` can't drag in `projects`.
- **UNMAPPED is loud, never silent.** A changed CODE path that matches no rule
  is printed as a warning with a "add a rule" hint. Silent skipping would make
  the tool read as "covered everything" when it didn't — the same no-silent-caps
  discipline the suite-runner already follows.
- **run.py categories are BATCHED.** All selected py categories collapse into
  one `python3 tests/run.py --types=a,b,c` process (one python start, one
  section) instead of N spawns. `unit`/`blockfs` are deliberately NOT py
  categories — the dedicated Node runners are faster and own those names.
- **The browser `sweep` is `optional`.** A launch failure degrades to a skip,
  not a hard fail (Playwright isn't installed in every clone). A real
  non-zero exit from a launched sweep still counts as a fail — we only soften
  the can't-even-start case.
- **`host` is a first-class suite.** `tests/host/run.js` (host.js Node output
  path + serve.js first-run/overlay) isn't a run.py category, so it needed its
  own registry entry + rules (`host.js`, `serve.js`, `tests/host|serve/`).

## The rule table is the single source

CLAUDE.md's new "Running tests" section and README's Tests section now point at
`RULES` in `tests/run.js` instead of re-encoding "after touching X run the Y
sweep" as prose. `node tests/run.js --list` prints the table + the IGNORE set.
When a new subsystem or coverage relationship appears, add a rule there.

## Verification

Each dispatch path exercised against the real runners (not mocked):

- Acceptance 1: a `compiler.js` working-tree edit → `--diff --dry-run` picks
  **unit, kernel, blockfs**. ✓
- Acceptance 2: an `os/wm.c` edit → **kernel, sweep**. ✓ (this touched the
  seeded source's mtime and restaled `os/os-system.img`; rebaked the fixture
  afterward — 96s — so warm boots stay fast.)
- `--diff HEAD~1` correctly resolved the last commit's touched paths (6
  docs ignored, the one kernel test → kernel).
- Real runs through the dispatcher: `unit` (filtered), `host` (green after the
  fixture rebake — the transient FAIL was the serve first-run test's 5s
  timeout losing to a 90s cold bake, not the dispatcher), `blockfs` (artifact
  link surfaced), `kernel` (filtered to test_kernel.js), and a batched
  `ast,disw` py run — all aggregate exit codes + write the merged summary.
- `all --dry-run` lists the full ordered estate; unknown-suite/flag guards
  exit 2.

Did NOT run the full `all` (multi-hour: kernel bake + libc + fuzz + every
vendor project) — the dispatcher is a thin orchestrator and every dispatch
path was proven individually against known-green underlying suites.

`build/test-run/summary.json` is gitignore-covered (under `build/`).
