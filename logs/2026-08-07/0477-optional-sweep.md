# #477 — remove the sweep's dead `optional: true`; all sites now state the hard-require

Ticket #477 (dup of the earlier #106/todos-0299): `classify()` returns `skip` only on
`r.spawnError`, i.e. `spawnSync` failing to launch the child. `sweep`'s command is
`['node', 'tests/browser/os-sweep.mjs']` and `node` always spawns, so a missing Playwright
was always a nonzero exit → `fail`. Three sites documented the opposite (the run.js registry
comment, `classify()`'s own comment, and CLAUDE.md rule 5's rationale + the run.js section).

## The hinge: `checkBrowserPreflight` covers ABSENCE, not just drift

The ticket predates #559. `tests/browser/lib/playwright-pin.cjs::checkBrowserPreflight`:
`resolvedPlaywright()` walks up from `tests/browser/lib` and returns **null when nothing
resolves** (`playwright-pin.cjs:44-51`); the pass condition is `got && (!exactPin ||
got.version === want)` (`:105`), so **null refuses**, with a dedicated message ("no playwright
is resolvable…", `:116-117`); even `CC_NO_PLAYWRIGHT_PIN` requires `got` (`:102` — "no
playwright at all can never be a deliberate sweep run", `:24`). `tests/run.js` calls it
whenever `sweep` is in the selected set and exits 2 before any suite runs; `os-sweep.mjs`
calls the same check itself before the heavy lock. So the exact scenario the three doc sites
invoked — "Playwright isn't installed in every clone" — is handled upstream, loudly, with the
exact fix named. Guard legs already pin the absence case
(`tests/host/test_browser_preflight.js`, "no resolvable playwright" + "hatch2").

## Decision: direction (B) — remove `optional`, docs state the hard-require

- The skip path was dead **twice over**: mechanism-unreachable (spawnError never fires for a
  missing Playwright) and pre-empted (#559 refuses at exit 2 first).
- Making `optional` real (direction A) would install a second, weaker handler that DISAGREES
  with the pre-flight (skip vs refuse) about the same condition.
- The dead path was also a live hazard, not just dead code: `main()`'s exit is
  `results.some(r => r.status === 'fail')` — a `skip` does not fail the dispatcher. Any
  genuine spawnError on the sweep row (e.g. transient EMFILE mid-gate) would have marked the
  suite `skip` and **exited 0 on a targeted gate with the sweep never run**. Rule 5's
  literal-`pass` belt only protects the ship gate, not per-merge targeted gates.
- #106's cont-78 verification recommended the opposite (make the code match the docs, with a
  distinguishable environment-missing exit code). That recommendation predates #559 and its
  motivation — "a Playwright-absent run reads as 'the OS is broken'" — is now satisfied by a
  strictly better mechanism: an exit-2 refusal at second zero naming the exact fix, vs a
  silent skip. Rebutted on those grounds.

## Changes (one commit)

- `tests/run.js`: registry comment rewritten (pre-flight is the sweep's Playwright handling;
  no skip tier); `optional: true` removed from `sweep`; `classify(r, optional)` →
  `classify(r)`, spawnError = hard fail on every suite, comment explains why the sweep gets
  no carve-out; `printFinal`'s skip rendering + "N skipped" counter removed (unreachable —
  an unknown status now renders FAIL, which is the loud direction); `classify` exported for
  the guard test.
- `CLAUDE.md`: rule 5 rationale rewritten — literal-`pass` requirement UNCHANGED (any
  non-`pass` status fails the gate, whatever produced it); the run.js section now states the
  hard-require + exit-2 refusal.
- `todos/LIABILITIES.md`: L18/L19 retired (this commit fixes the gap they indexed; both
  funded by #106, which duplicates #477 — coordinator to disposition #106).
- `tests/host/test_browser_preflight.js`: two new legs — no `SUITES` entry carries
  `optional`; `classify` hard-fails a spawnError (plus pass/fail exit-code legs).

## Evidence (breakage-and-revert, both captured under build/)

- **Sabotage A** (`build/sabotage-477-A.log`): re-added `optional: true` to `sweep` → ran
  `node tests/run.js host` THROUGH THE DISPATCHER → `FAIL no suite in the registry carries
  \`optional\` (#477)` → host suite FAIL, dispatcher rc=1. Reverted.
- **Sabotage B** (`build/sabotage-477-B.log`): made `classify` return `skip` on spawnError →
  `FAIL classify() hard-fails a spawn failure — never a skip (#477)`, rc=1. Reverted.
- **Green control** (`build/sabotage-477-green.log`): all ok, rc=0.
- Pre-fix state preserved statically: at `e6ac473e`, `tests/run.js:52-53/64/811/848-853`
  carried the comment, the field, the optional-threading call site, and the skip branch; the
  git history is the repro.

## Residual, surfaced not fixed (scope: registry change gates alone)

`classify` maps the heavy-lock's **exit 3 to `fail`** — lock contention is reported as a
suite failure by the dispatcher (noted in #106's verification). Distinct defect, distinct
instrument; left to the coordinator to fold into #106's disposition or a fresh ticket.

## Gate

`--dry-run` selected `todos, host` (tests/run.js → host by rule; LIABILITIES.md → todos;
CLAUDE.md docs-ignored; note removing L18 un-cites tests/run.js from `CITED_RE`, so it no
longer additionally pulls `todos` — the correct consequence of retiring the entry). Gate
result recorded on ticket #477.
