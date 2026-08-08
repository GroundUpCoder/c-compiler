# #582 — the gate baselines its pass/fail/SKIP tally (skip regressions now fail)

A SKIP is the one outcome that looks identical to success: a test that stops
running does not fail, it just leaves the tally. The v244 ship gate said
`902 passed, 0 failed, 113 skipped` and nothing could say whether 113 was
normal — no tally had ever been preserved. This lands the record, the
baseline, and the enforcement.

## What landed

- **`tests/run.py` records structured tallies.** `Results` keeps per-category
  buckets (section() is the boundary); every `skip()` carries a NAME and a
  reason. A new artifact, `build/test-py/summary.json` (atomic rename), holds
  `totals` + per-category `{passed, failed, skipped, skips[{name, reason}]}`.
  The `projects` compileCheck exclusions now COUNT as skips (they were
  print-only, understating the tally); the cpython-clang entry's reason is the
  bin.json `compileCheckSkip` verbatim (todos/0327 + todos/0336).
- **`tests/run.js` enforces a committed baseline.** After the py batch it
  reads the artifact (freshness-gated on mtime), attaches the tallies to the
  run-level `build/test-run/summary.json` row, and on an UNFILTERED run holds
  the skip set against `tests/py-skip-baseline.json` — by NAME, both
  directions. Any diff = the row goes to literal `status: "fail"` (reason
  `skip-baseline`), so rule 5's literal-'pass' judging sees it. kernel/
  blockfs/sweep rows also get `tallies` derived from their own artifacts;
  unit/host/todos keep the honest absence (no artifact, no invented number).
- **`tests/py-skip-baseline.json`** — 111 skips, measured on this lane
  (2026-08-08): lua 7 (LUA_SKIP), micropython-upstream 65 (skip list /
  printed-SKIP / CPython-rejected), libc 38 (LIBC_TEST_SKIP), projects 1
  (cpython-clang). `exemptPrefixes: ["fuzz/live-"]` — csmith live seeds have
  random names and skip on native-leg behavior (csmith IS installed at
  `~/git/csmith`; 0–5 exempt skips per run).
- **Guard: `tests/host/test_skip_baseline.js`** (registered in the host
  suite) — RED controls in both directions, the netting trap (one fixed + one
  new ≠ zero), the exemption, unnamed-skip refusal, and the committed file
  pinned set-equal to `PY_CATEGORIES` with a non-empty attribution per entry.

## Decisions

- **Fail, not warn.** Gates are judged from `summary.json`'s literal
  `status: "pass"` rows (rule 5); a banner warning is invisible to that
  reading, so the softer option is exactly the silence this ticket exists to
  end. A stale baseline entry fails too (the xpass philosophy: the fixer
  claims the win in the same commit) — and a deleted test's vanishing skip is
  itself the silent-shrink class.
- **Names, not counts.** A count baseline nets "one fixed + one new" to zero
  and hides both events.
- **Missing baseline / missing artifact = red**, never a skip-the-check
  fallback (the no-zombie-fallbacks rule).
- **Enforcement only on unfiltered runs** — a `--filter` run's skip set is a
  function of the filter, not the tree.

## Found along the way

- `tests/disw/__pycache__` (dropped by build.py importing the sibling
  `wasm_builder.py`) was being counted as a skipped *test* — the tally
  depended on whether the suite had run before. Discovery now ignores
  `__*`/dotted dirs in the disw/tcc/sourcemap/sqlite loops
  (`not_artifact_dir`).
- The real total is **111**, not the remembered 113. The delta is
  unattributable precisely because no v244 record exists — likely fuzz/live
  variance (csmith is present on this box) — which is this ticket's thesis in
  one sentence.

Gate: `node tests/run.js --diff` → unit + host + blockfs + all 19 py
categories, 4/4 pass, py `904P/0F/111S`, baseline checked, 0 violations.
RED control exercised live: doctored baseline → `new-skip` +
`stale-baseline` violations, gate exit 1; restored → green.
