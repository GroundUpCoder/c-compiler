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
//
// The os/ block below (ticket #428) guards the opposite direction: that the
// per-host narrowing did not eat any SHARED os/ path. Under-gating is the
// failure mode a gate-policy edit produces, and it is silent by construction
// — a plan that got shorter looks exactly like a plan that got shorter
// correctly.
var fs = require('fs');
var path = require('path');

var runjs = require(path.join(__dirname, '..', 'run.js'));
var PY_CATEGORIES = runjs.PY_CATEGORIES;
var planFromDiff = runjs.planFromDiff;
var ROOT = path.join(__dirname, '..', '..');

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

// ---- os/: the per-host narrowing (ticket #428) ----
//
// gucOS runs over two hosts (the browser page, the headless Node twin) and
// six files under os/ belong to exactly one of them. Those six select only
// their own host's suite; EVERYTHING else under os/ keeps kernel + sweep,
// because it becomes blob bytes that either host can observe. The evidence
// that the wide half must stay wide: 2026-08-03, a Desktop-launcher change
// under os/image.json ran kernel-green 151/151 and sweep-RED (os-paint.mjs).
var OS_BROWSER_ONLY = runjs.OS_BROWSER_ONLY;
var OS_HEADLESS_ONLY = runjs.OS_HEADLESS_ONLY;
var OS_RUNTIME_ONLY = runjs.OS_RUNTIME_ONLY;

check('os/ runtime-only list is the two per-host sets, nothing else',
      Array.isArray(OS_BROWSER_ONLY) && Array.isArray(OS_HEADLESS_ONLY) &&
      OS_BROWSER_ONLY.length + OS_HEADLESS_ONLY.length === OS_RUNTIME_ONLY.length &&
      OS_RUNTIME_ONLY.length === 6,
      OS_RUNTIME_ONLY.join(', '));

// A name that no longer exists is not harmless: it stays in the shared-os/
// rule's negative lookahead, so a FUTURE file taking that name would be
// narrowed to one host without anyone deciding that.
OS_RUNTIME_ONLY.forEach(function (f) {
  check('os/' + f + ' exists (a stale exception silently pre-narrows a future file)',
        fs.existsSync(path.join(ROOT, 'os', f)));
});

OS_BROWSER_ONLY.forEach(function (f) {
  var s = planFromDiff(['os/' + f]).suites;
  check('os/' + f + ' selects sweep', s.has('sweep'), [...s].join(', '));
  check('os/' + f + ' does NOT select kernel (headless host cannot observe it)',
        !s.has('kernel'), [...s].join(', '));
});
// os.html additionally rides the host suite: tests/serve/test_first_run.js
// asserts serve.js advertises and serves /os/os.html.
check('os/os.html selects host (tests/serve/test_first_run.js pins the served path)',
      planFromDiff(['os/os.html']).suites.has('host'));

OS_HEADLESS_ONLY.forEach(function (f) {
  var s = planFromDiff(['os/' + f]).suites;
  check('os/' + f + ' selects kernel', s.has('kernel'), [...s].join(', '));
  check('os/' + f + ' does NOT select sweep (no browser test loads it)',
        !s.has('sweep'), [...s].join(', '));
});

// The over-narrowing guard, quantified over the REAL tree rather than a
// hand-listed sample: every other file under os/ must still draw BOTH heavy
// suites. This is what catches a lookahead that swallowed more than its list.
// Docs-shaped paths under os/ (READMEs, *.md) are dropped by IGNORE before
// any rule is consulted — that is the dispatcher working, not a narrowing, so
// they are not part of this quantification.
function dropped(f) {
  return !runjs.FORCE.some(function (re) { return re.test(f); }) &&
         runjs.IGNORE.some(function (re) { return re.test(f); });
}
var osShared = [];
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name.charAt(0) === '.') return;
    var abs = path.join(dir, e.name);
    var rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) walk(abs);
    else if (OS_RUNTIME_ONLY.indexOf(rel.slice('os/'.length)) === -1 && !dropped(rel)) osShared.push(rel);
  });
})(path.join(ROOT, 'os'));

check('the os/ walk found a real tree (an empty walk makes the next two vacuous)',
      osShared.length >= 40, osShared.length + ' shared paths');
var missKernel = osShared.filter(function (f) { return !planFromDiff([f]).suites.has('kernel'); });
var missSweep = osShared.filter(function (f) { return !planFromDiff([f]).suites.has('sweep'); });
check('every OTHER os/ path still selects kernel', missKernel.length === 0,
      missKernel.length ? 'narrowed out: ' + missKernel.slice(0, 8).join(', ') : osShared.length + ' paths');
check('every OTHER os/ path still selects sweep', missSweep.length === 0,
      missSweep.length ? 'narrowed out: ' + missSweep.slice(0, 8).join(', ') : osShared.length + ' paths');

// The wide half named explicitly too — a walk-driven assertion goes vacuous
// if the walk breaks, and these are the paths the narrowing was tempting for.
['os/wm.c', 'os/image.json', 'os/term/term.c', 'os/win32/user32.c',
 'os/ksvc/ksvc.c', 'os/gcode/gcode.c', 'os/os-common.js', 'os/keys.h'].forEach(function (f) {
  var s = planFromDiff([f]).suites;
  check(f + ' keeps BOTH heavy suites', s.has('kernel') && s.has('sweep'), [...s].join(', '));
});

// ---- the dispatcher gates itself ----
// An edit to the RULES table must select the suite this guard runs in — with
// the old `[]` mapping, breaking the closure selected nothing.
var self = planFromDiff(['tests/run.js']).suites;
check('tests/run.js selects host (the suite holding this guard)', self.has('host'));

console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failures ? 1 : 0);
