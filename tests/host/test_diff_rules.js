#!/usr/bin/env node
'use strict';
// todos/0362 regression guard — the diff→suite RULES closure for the two
// whole-estate files must keep selecting the real-world-C corpus.
//
// WHY: the `^compiler\.js$` rule used to select ['unit','kernel','blockfs',
// 'host'] under a rationale claiming "every wasm binary" — no run.py category
// but `unit`, so `--diff` on todos/0356's miscompile (caught ONLY by
// micropython-upstream, `unit` green) would have gone green and affirmatively
// reported the change as covered. A rule whose prose overstates its list reads
// as a considered scope decision, which is why this is a test and not a
// comment. The exclusions pinned below are decisions too: a category that
// starts executing wasm under host.js should FAIL here and force the rule to
// say so.
var path = require('path');

var runjs = require(path.join(__dirname, '..', 'run.js'));
var PY_CATEGORIES = runjs.PY_CATEGORIES;
var planFromDiff = runjs.planFromDiff;

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

// The constant itself must stay a real corpus list — every assertion below
// quantifies over it, so an emptied/renamed PY_CATEGORIES must fail loud here
// rather than make the closure checks vacuous.
check('PY_CATEGORIES is the run.py corpus (18+ categories, upstream corpus present)',
      Array.isArray(PY_CATEGORIES) && PY_CATEGORIES.length >= 18 &&
      PY_CATEGORIES.includes('micropython-upstream'),
      (PY_CATEGORIES || []).length + ' categories');

// ---- compiler.js: the whole estate ----
var cc = planFromDiff(['compiler.js']).suites;
check('compiler.js is not ignored/unmapped', cc.size > 0, [...cc].join(', '));
check('compiler.js selects micropython-upstream (the suite that caught 0356)',
      cc.has('micropython-upstream'));
var ccMissingPy = PY_CATEGORIES.filter(c => !cc.has(c));
check('compiler.js selects EVERY run.py category', ccMissingPy.length === 0,
      ccMissingPy.length ? 'missing: ' + ccMissingPy.join(', ') : 'all ' + PY_CATEGORIES.length);
for (var s of ['unit', 'kernel', 'blockfs', 'host', 'sweep']) {
  check('compiler.js selects ' + s, cc.has(s));
}

// ---- host.js: everything that executes wasm, stated exclusions held ----
var hj = planFromDiff(['host.js']).suites;
check('host.js selects micropython-upstream', hj.has('micropython-upstream'));
var hjExpected = PY_CATEGORIES.filter(c => c !== 'disw' && c !== 'sourcemap');
var hjMissingPy = hjExpected.filter(c => !hj.has(c));
check('host.js selects every run.py category that executes wasm',
      hjMissingPy.length === 0,
      hjMissingPy.length ? 'missing: ' + hjMissingPy.join(', ') : hjExpected.length + ' categories');
for (var s2 of ['unit', 'blockfs', 'kernel', 'sweep', 'host']) {
  check('host.js selects ' + s2, hj.has(s2));
}
// The two recorded exclusions: neither category runs wasm under host.js
// (disw disassembles with a native binary; sourcemap verifies with its own
// verify.js). If either starts executing, flip the rule AND this pin.
check('host.js excludes disw (recorded: never executes wasm)', !hj.has('disw'));
check('host.js excludes sourcemap (recorded: never executes wasm)', !hj.has('sourcemap'));

// ---- the dispatcher gates itself ----
// An edit to the RULES table must select the suite this guard runs in — with
// the old `[]` mapping, breaking the closure selected nothing.
var self = planFromDiff(['tests/run.js']).suites;
check('tests/run.js selects host (the suite holding this guard)', self.has('host'));

console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failures ? 1 : 0);
