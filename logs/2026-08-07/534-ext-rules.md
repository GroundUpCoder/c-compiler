# #534 — tests/run.js RULES: map `^ext/` and `^libc-ext.js` (+ the drift hole)

Lane: lane-534, base `c1ee8291` (origin/main). Ticket #534
(`019fd1a2-4c43-725a-8e1b-baef469d9ea6`).

## The defect, reproduced at base

`planFromDiff(["ext/src/regcomp.c","ext/src/tsearch.c","libc-ext.js"])` →
all three UNMAPPED, zero suites (BEFORE evidence: `build/before-534.log`).
Positive control (`tools/build-libc-ext.js` → ext,unit) and negative control
(bogus path → unmapped) both held. UNMAPPED is a yellow warning only
(`printDiffPlan`), so an ext-only diff merged green with zero coverage.

## Ruling on CALL 1 — the mapping is `['ext','unit','libc']`

Both the ticket's lean (`ext`+`libc`) and the existing generator row
(`ext`+`unit`) were each missing one leg. Measured coverage, per suite:

- **`unit`** — `tests/unit/ext_regex|ext_fnmatch|ext_glob` are golden tests
  that compile AND EXECUTE regex/fnmatch/glob out of the committed
  `libc-ext.js`. Proof A: set `REG_NOMATCH` to 42 in `ext/include/regex.h`,
  regenerate → `node tests/run-unit.js --filter=ext_` fails `ext_regex`
  (`nomatch=42` vs golden). The only executor of regex — libc-test has no
  regex member (grep for `regcomp|regexec` over `vendor/libc-test/src`
  hits only a false positive in memstream.c).
- **`libc`** — the libc-test functional corpus runs `fnmatch.c` and all four
  `search_*.c` members (none are in `LIBC_TEST_SKIP`, tests/run.py:1503).
  The ONLY executor of the search.h family; unit has no ext_search golden.
  Proof B: make `tfind` always return 0 in `ext/src/tfind.c`, regenerate →
  `python3 tests/run.py --types=libc --filter=search` fails `search_tsearch`
  ("tfind a failed").
- **`ext`** — `tests/ext/run.js` pins the optional-library CONTRACT
  (degradation when absent, pickup when present). It is compile-only for the
  ext code: with BOTH semantic breaks above in place and regenerated, the ext
  suite passed everything. So mapping `ext` alone would have been exactly the
  cargo-cult fix the kickoff warned about — a green plan running a suite that
  cannot observe the change. `unit`+`libc` are load-bearing.

The generator row (`^tools/build-libc-ext\.js$`) was widened to the same set:
sources, generator, and artifact are one surface, and a diff can legally
contain any subset of them.

## Ruling on CALL 2 — yes, `^libc-ext\.js$` maps to the same set

It is generated AND committed: 159,190 bytes at the repo root, git history
`4b77c175` (introduction) and `a5b49e5a` (#111/#112/#114/#115 regeneration).
`node tools/build-libc-ext.js --check` is green at base — the committed
artifact matches `ext/` today. The rule is live, not dead weight.

## Beyond the ticket — the DRIFT hole (found, closed)

The compiler reads the ARTIFACT, not the sources. So an edit under `ext/`
that skips regeneration was invisible to EVERY suite — all three mapped
suites test the stale committed `libc-ext.js` and pass. No `--check` existed
(unlike mkmpgenhdr). Without closing this, #534's mapping would fix one fake
green while leaving its twin.

Closed on the mkmpgenhdr precedent: `tools/build-libc-ext.js --check`
compares what `ext/` generates against the committed artifact, exit 1 naming
the regeneration fix. `tests/ext/run.js` runs it (so the `ext` suite now
genuinely covers every `ext/` path directly), plus a RED CONTROL: generate to
a temp path via `--out=`, tamper, assert `--check --out=` exits 1. Proof C:
with an unregenerated `ext/src` edit, the sync leg goes FAIL.

⚠ Flag per kickoff: `--out=PATH` is a new CLI flag on a gate-relevant tool.
It is NOT a bypass knob — the gating leg invokes plain `--check` (repo-root
target); `--out` only retargets generation/checking for the red control, and
is not an env var. No env-var guard bypasses were added or touched
(`git grep -n "CC_NO\|process.env" tools/build-libc-ext.js` at base: zero
hits; the file read no env before and reads none now).

The tree-guard header comment in build-libc-ext.js said "No harness spawns —
hand-run only"; updated, since tests/ext/run.js now spawns it in --check mode.
This invalidates no committed assertion — the #142 survey point was that the
tool is a self-tree WRITER, and in --check mode it writes nothing.

## Ruling on CALL 3 — closure guard extended, walk-driven; global leg DECLINED

`tests/host/test_diff_rules.js` grew an ext block, the os/-walk shape:
walk the REAL `ext/` tree (same `dropped()` filter), require ≥15 files
(21 found — 5 include + 16 src; README.md correctly IGNORED), assert every
file selects each of ext/unit/libc; plus `libc-ext.js` and
`tools/build-libc-ext.js` pinned to the same set. A NEW file under `ext/` is
covered with nobody remembering the guard — resolved by rule, not by list,
the lane-559 shape.

The kickoff's generalised leg ("every top-level source directory the build
consumes must have a RULES row") is DECLINED, in writing: tests/run.js's own
design (the `^tools/` block comment, "a NEW tools/ path still reports
UNMAPPED, which is the prompt to decide") makes UNMAPPED-as-prompt the
intended behaviour for new path classes, and there is no machine-readable
"consumed by the build" set to quantify over — any hand list would go stale
exactly the way the original hole did (test_diff_rules.js:37's vacuousness
worry). The walk-driven leg gives the recurrence protection within this
class without a global claim that contradicts the table's design.

**Surfaced for @master, not fixed here:** a full sweep of `git ls-tree
HEAD` through planFromDiff shows the remaining UNMAPPED root-level FILES are
`gc-sample.c`, `package.json`, `pnpm-lock.yaml`, `.gitattributes`.
`package.json`/`pnpm-lock.yaml` are arguably the interesting ones (a
playwright pin change selects nothing today; #559 made the sweep pre-flight
loud at runtime, but the diff plan still says "no suites"). Candidate
follow-up ticket; not #534's scope.

## Ruling on CALL 4 — scope held

`ext`/`libc` remain py-category suites over bare python3 (#483's defect,
untouched). The only python3 use here was hand-running run.py as a coverage
probe, mirroring what the suite itself does.

## Evidence inventory

- `build/before-534.log` / `build/after-534.log` — planFromDiff before/after.
- AFTER: all of `ext/src/*`, `ext/include/*`, `libc-ext.js`,
  `tools/build-libc-ext.js` → `ext,unit,libc`; bogus path still UNMAPPED.
- Proofs A/B/C run on the working tree and fully REVERTED: `git status
  --porcelain ext/ libc-ext.js` empty after restore + regeneration
  (regeneration is byte-identical — deterministic generator, sorted keys).
- `node tests/ext/run.js` → 9/9 pass; `node tests/host/test_diff_rules.js`
  → all checks pass (including the new 6 ext legs).

Cross-links: #483 (py runner python), #559 (pre-flight precedent), #111–#115
(the batch that last regenerated libc-ext.js), todos/0362 (the guard file).
