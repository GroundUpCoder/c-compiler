# #559 — browser tier pre-flight: refuse the knowable install fault at second zero

Lane: lane-559 (solo, Fable). Ticket: #559 (`019fd95c-3405-7867-9f0e-0fa3d3566877`).

## What landed

One shared implementation, `tests/browser/lib/playwright-pin.cjs` (CJS on
purpose — `tests/browser` is `"type":"module"`, and the consumer that needs it
synchronously is the CJS dispatcher), consumed four ways:

1. `tests/run.js` — `browserPreflight(ordered)` runs before suite 1 whenever
   `sweep` is in the selected set. Refusal = message + **exit 2**, no summary
   written (an absent `build/test-run/summary.json` already means "did not
   finish"). Deliberately not 3 (heavy lock) or 4 (tree guard) — trained codes.
2. `tests/browser/os-sweep.mjs` — same check before `acquireHeavyLock()` and
   the bake (the tree-guard precedent: a run about to be refused must not take
   the machine-wide lock or spend a bake first). Covers the hand-run sweep,
   converting 56 identical per-member failures into one named refusal.
3. `os-harness.mjs` `launchBrowser()` — the pre-existing launch-time
   `checkPlaywrightPin()` throw, unchanged in behavior, now a re-export from
   the `.cjs`. Defense in depth for a hand-run single `os-*.mjs`.
4. `tests/host/test_browser_preflight.js` — 17 legs over throwaway fixture
   trees ($TMPDIR; nothing touches a real checkout), including the exact
   lane-554 shape asserting the exact `ln -s` line, dangling-symlink-counts-
   as-missing, and a never-vacuous real-tree consistency invariant.

Plus the RULES row (`playwright-pin.cjs → sweep, host`), the host-suite
registration, and the CLAUDE.md worktree-setup paragraph (acceptance item 4).

## Rulings on the kickoff's open design calls

- **Both options, or one? BOTH, with option 2's "automatic" sub-choice
  resolved to LOUD, not automatic.** Option 1 alone leaves the symlink
  undocumented folklore; option 2 alone leaves the next install fault burning
  a full gate.
- **Hard fail vs loud warning: HARD FAIL, exit 2.** A warning is scroll-past
  material — the same disease as the 33-minute red. The counter-case ("a
  clone with no Playwright should still run the non-sweep suites") is real
  but does not argue for a warning: the pre-flight only fires when the sweep
  is IN the selected set, and per #477 that clone's sweep row reds TODAY
  anyway (the `optional:true` skip is unreachable — `classify()` only skips
  on `spawnError`, and `node` always spawns). So the hard fail changes no
  verdict on any real path; it moves the identical verdict from minute 33 to
  second zero and names the fix. Non-sweep selections are untouched, which is
  also why the host test's real-tree leg asserts *agreement between the two
  checks*, not "this tree must be healthy" — the ticket's own test leg must
  not couple the Node-only host suite to a browser dep my ruling says only
  sweep-selecting runs may enforce.
- **I did NOT re-invent the dead `optional:true` skip, and I did not
  adjudicate #477.** The pre-flight is a refuse-everything-loudly gate ahead
  of the run, not a per-suite degradation; `classify()` and the three
  documentation sites #477 names are untouched. #477's decision (make skip
  real vs delete `optional`) remains open and is easier either way now.
- **Automate the symlink, or document it? NEITHER auto-creation — refusal
  names the exact command instead.** A test runner mutating the developer's
  filesystem is action-at-a-distance; worse, auto-linking to the main tree
  would silently propagate a main-tree drift into every worktree (a zombie
  fallback with extra steps). The refusal derives the main clone from the
  worktree's `.git` gitdir-pointer (`mainTreeOf`) and prints the literal
  `ln -s <main>/tests/browser/node_modules <wt>/tests/browser/node_modules`,
  only when that target actually exists — copy-paste-fixable in seconds,
  which is ~all of automation's value with none of the mutation. Documented
  in CLAUDE.md's "Running tests" section (both symlinks + the os-clang
  sibling note).
- **Outcome-based, not mechanism-based.** The check demands "the playwright
  Node will resolve IS the pinned one", not "tests/browser/node_modules must
  exist": the pinned version's Chromium is in the per-user cache however it
  resolves, so a tree whose ambient resolution matches the pin works today
  and keeps passing. The missing dir is diagnosed *in the refusal* (it is why
  resolution drifted, and its symlink is the fix). Pinned by the
  `OUTCOME-based` test leg.
- **`CC_NO_PLAYWRIGHT_PIN=1` skips the version comparison, never existence.**
  "No playwright at all" can never be a deliberate sweep run; deselecting the
  sweep is the escape for that. Pinned by two test legs.
- **Gate selection (the kickoff asked for a ruling): the authority answered
  it.** `node tests/run.js --diff origin/main --dry-run` on this change set
  selects **todos, host, sweep** — `playwright-pin.cjs` carries a new RULES
  row mapping it to `sweep, host` precisely so an edit to the shared
  implementation owes both its consumers. So the "host-only would be a fake
  green" worry is moot: the full sweep is in my *targeted* gate by rule, not
  by judgment, and rule 6's "no full gate to be safe" is respected (todos +
  host + sweep is what the diff mandates; the 22 other suites stay out).

## Negative controls (run BEFORE fixing this worktree — evidence in build/)

This lane's own fresh worktree reproduced the bug, and was used as the
control before its symlinks were created:

- `build/neg-control-559.log` — no symlinks at all: `node tests/run.js all`
  refused in **0 s, exit 2**, naming the exact `ln -s` fix ("no playwright is
  resolvable" shape).
- `build/neg-control-559-drift.log` — root symlink only (the literal lane-554
  shape): refusal names `1.61.1 resolved … pins 1.61.0`, the resolution path,
  the MISSING dir, and the same fix.
- Hand-run `node tests/browser/os-sweep.mjs`: same refusal, exit 2, before
  the heavy lock (by construction — the check precedes `acquireHeavyLock()`).

Both refusal shapes are also committed as fixture legs, so the controls
outlive this worktree.

## Pinned before→after figures (written before the gate)

- **host**: 38 → **39** registered rows (`test_browser_preflight.js`), all
  pass. The suite-membership guard derives partitions from the rows, so the
  new file + row land together or the suite refuses.
- **sweep**: 56 on-disk members, expect `executed=56, carried=0, filter=null`,
  zero non-pass. My change adds a pre-flight that PASSES on this (now fixed)
  tree; no member behavior change expected.
- **todos**: pass (CLAUDE.md + tests/run.js edits; liability anchors are
  literal lines, none deleted).
- Skip profile: no new skips vs the respective suites' norms.

## Gotchas for the next reader

- `tests/browser/package.json` is `"type":"module"` — a shared `.js` file
  under it would be ESM and unrequirable from the CJS dispatcher; hence
  `.cjs`. Named imports from the `.cjs` work in `.mjs` via Node's CJS lexer.
- `fs.existsSync` follows symlinks, so a dangling `node_modules` symlink
  correctly counts as missing (test leg pins it).
- The fixture legs depend on no ancestor of `$TMPDIR` carrying
  `node_modules/playwright`; a loud precondition leg names that instead of
  flaking if some host ever violates it.
