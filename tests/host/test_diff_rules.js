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

// ---- baked docs-shaped image inputs (ticket #622) ----
//
// os/gcode/GCODE.md and os/doc/sdl-gucos.md are `bin` entries in
// os/image.json — blob bytes — yet the docs IGNORE used to drop them, so a
// content-only edit re-baked the image and then gated ZERO suites (#505,
// the next dogfood round, edits exactly that file). The set is DERIVED from
// the manifest + the package definitions (never hardcoded), so these pins
// check the derivation stayed live in both directions: baked docs price
// both heavy suites; plain docs outside the bake closure stay free.
var BAKED_DOCS = runjs.BAKED_DOCS;
check('BAKED_DOCS derivation parsed os/image.json', BAKED_DOCS.ok === true,
      BAKED_DOCS.ok ? BAKED_DOCS.files.length + ' file(s)' : BAKED_DOCS.error);
var bakedFiles = BAKED_DOCS.files || [];
// The two manifest members by name (the #622 motivating pair)...
['os/gcode/GCODE.md', 'os/doc/sdl-gucos.md'].forEach(function (f) {
  check('derivation finds ' + f + ' (an image.json bin entry)', bakedFiles.indexOf(f) !== -1);
});
// ...and one package-borne member: LICENCE.md rides packages/libgit2.json's
// `src` tree payload (the top-level README.md is exclude-listed; this one is
// not), pinning the packages/tree half of the derivation non-vacuous. If
// libgit2's definition later excludes it, pick another payload doc here —
// this pin failing IS the signal the derivation lost its only live tree case.
check('derivation finds vendor/libgit2/deps/pcre2/LICENCE.md (a tree-payload doc)',
      bakedFiles.indexOf('vendor/libgit2/deps/pcre2/LICENCE.md') !== -1);
// The filter is live: every derived path is one IGNORE would drop — the
// alternation is the RESCUED set, never the whole bake closure.
var notDocs = bakedFiles.filter(function (f) {
  return !runjs.IGNORE.some(function (re) { return re.test(f); });
});
check('every derived path is docs-shaped (IGNORE would drop it)', notDocs.length === 0,
      notDocs.length ? 'not ignored: ' + notDocs.slice(0, 5).join(', ') : bakedFiles.length + ' paths');
// Direction 1+2: a baked-doc-only diff prices BOTH heavy suites (blob bytes
// are observable from both hosts — the ^os/ shared rule's reasoning).
bakedFiles.forEach(function (f) {
  var s = planFromDiff([f]).suites;
  check(f + ' prices kernel + sweep', s.has('kernel') && s.has('sweep'), [...s].join(', '));
});
// Direction 3: plain docs OUTSIDE the bake closure stay IGNORE — a change
// that puts a heavy suite behind every dev-log commit is a regression, not a
// fix. Fabricated names guarantee not-baked and not-LIABILITIES-cited.
var plain = planFromDiff(['logs/2026-01-01/no-such-note.md', 'NO-SUCH-DESIGN-SCRATCH.md',
                          'os/NO-SUCH-NOTES.md', 'vendor/libgit2/README.md']);
check('plain docs price NOTHING', plain.suites.size === 0, [...plain.suites].join(', '));
check('plain docs are ignored, not unmapped', plain.ignored.length === 4 && plain.unmapped.length === 0,
      plain.ignored.length + ' ignored, ' + plain.unmapped.length + ' unmapped');

// ---- ext/ + libc-ext.js: the extension surface (#534) ----
//
// This path class merged green with ZERO suites selected until #534 — the
// UNMAPPED report is a yellow warning, not a failure, so nothing forced the
// decision. The pinned set is argued from measured coverage, each suite
// covering what the others cannot: `ext` pins the optional-library contract
// and runs build-libc-ext.js --check (drift between ext/ and the committed
// artifact is otherwise invisible to every suite); `unit` EXECUTES
// regex/fnmatch/glob via the ext_* goldens; `libc` is the only suite that
// executes the search.h family (libc-test search_tsearch/hsearch/lsearch/
// insque + fnmatch). Quantified over the REAL tree, the os/ walk's shape, so
// a NEW file under ext/ is covered without anyone remembering this guard.
var EXT_SET = ['ext', 'unit', 'libc'];
var extFiles = [];
(function walkExt(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name.charAt(0) === '.') return;
    var abs = path.join(dir, e.name);
    var rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (e.isDirectory()) walkExt(abs);
    else if (!dropped(rel)) extFiles.push(rel);
  });
})(path.join(ROOT, 'ext'));
check('the ext/ walk found the real tree (an empty walk makes the next check vacuous)',
      extFiles.length >= 15, extFiles.length + ' files');
EXT_SET.forEach(function (want) {
  var miss = extFiles.filter(function (f) { return !planFromDiff([f]).suites.has(want); });
  check('every ext/ file selects ' + want, miss.length === 0,
        miss.length ? 'missing: ' + miss.slice(0, 8).join(', ') : extFiles.length + ' files');
});
// The generated-and-committed artifact and its generator draw the same set:
// all three are one surface — sources, generator, artifact — and a diff can
// legally contain any subset of them.
['libc-ext.js', 'tools/build-libc-ext.js'].forEach(function (f) {
  var s = planFromDiff([f]).suites;
  var miss = EXT_SET.filter(function (want) { return !s.has(want); });
  check(f + ' selects ext+unit+libc', miss.length === 0,
        miss.length ? 'missing: ' + miss.join(', ') : [...s].join(', '));
});

// ---- tiers (#576 F1) ----
//
// A tiering system's whole risk is a gate that LIES: a green that only means
// "we didn't run the thing that would have failed". Every pin below closes a
// concrete silent-drop path:
//   - registry set-equality (the #314 shape at dispatcher level): a suite
//     added to SUITES but forgotten from ALL_SUITES would silently vanish
//     from `all`/`full` — the ship gate itself.
//   - filter-token liveness: smoke selects kernel files by substring token;
//     a renamed/deleted test would otherwise shrink the tier to a green
//     no-op with nobody deciding that. Checked with the SAME matcher the
//     suite runner uses (matchesFilter), against the real on-disk tree.
//   - pinned members: smoke must keep really booting the OS (test_strace_e2e
//     is the fixture-boot leg) and really driving the SAB core (test_kernel).
var TIERS = runjs.TIERS;
var SUITES = runjs.SUITES;
var ALL_SUITES = runjs.ALL_SUITES;
var matchesFilter = require(path.join(__dirname, '..', 'lib', 'suite-runner.js')).matchesFilter;

check('TIERS is exactly {smoke, diff, full}',
      TIERS && Object.keys(TIERS).sort().join(',') === 'diff,full,smoke',
      Object.keys(TIERS || {}).join(', '));
check('no tier name collides with a suite name (the CLI token would be ambiguous)',
      Object.keys(TIERS).every(function (t) { return !SUITES[t]; }));

// Registry set-equality: ALL_SUITES <-> Object.keys(SUITES), both directions.
var suiteKeys = Object.keys(SUITES);
var notInAll = suiteKeys.filter(function (s) { return ALL_SUITES.indexOf(s) === -1; });
var notInReg = ALL_SUITES.filter(function (s) { return !SUITES[s]; });
check('every registered suite is in ALL_SUITES (a suite missing here silently drops from all/full)',
      notInAll.length === 0, notInAll.length ? 'missing: ' + notInAll.join(', ') : suiteKeys.length + ' suites');
check('every ALL_SUITES entry is a registered suite', notInReg.length === 0,
      notInReg.length ? 'unregistered: ' + notInReg.join(', ') : '');

// full == the whole registry, by value (a refactor must not quietly narrow it).
var fullMiss = ALL_SUITES.filter(function (s) { return TIERS.full.suites.indexOf(s) === -1; });
var fullExtra = (TIERS.full.suites || []).filter(function (s) { return ALL_SUITES.indexOf(s) === -1; });
check('full tier == ALL_SUITES (set equality — full is the ship gate and cannot narrow)',
      fullMiss.length === 0 && fullExtra.length === 0,
      fullMiss.length ? 'missing: ' + fullMiss.join(', ') : fullExtra.length ? 'extra: ' + fullExtra.join(', ') : ALL_SUITES.length + ' suites');

// diff is the planner, not a static list — a refactor that freezes it into a
// snapshot of "what diffs usually need" would go stale silently.
check('diff tier is dynamic (planFromDiff-driven, never a static list)',
      TIERS.diff.dynamic === true && !TIERS.diff.suites);

// smoke: every named suite exists, and it is a PROPER subset — a smoke that
// runs everything is a mislabeled full, and one that runs nothing is a no-op.
var smoke = TIERS.smoke;
var smokeBad = (smoke.suites || []).filter(function (s) { return !SUITES[s]; });
check('every smoke suite is a registered suite', smokeBad.length === 0,
      smokeBad.length ? 'unknown: ' + smokeBad.join(', ') : smoke.suites.join(', '));
check('smoke is a proper nonempty subset of the registry',
      smoke.suites.length > 0 && smoke.suites.length < ALL_SUITES.length,
      smoke.suites.length + ' of ' + ALL_SUITES.length);
// Recorded decisions, not oversights (flip these WITH the tier if policy
// changes): the sweep's floor (Chromium + serve + bake) is minutes, so smoke
// covers the OS headless — kernel must stay in, sweep must stay out.
check('smoke includes kernel (the OS-coverage leg)', smoke.suites.indexOf('kernel') !== -1);
check('smoke omits the sweep (recorded: browser coverage belongs to diff/full)',
      smoke.suites.indexOf('sweep') === -1);

// Per-suite filter liveness — THE silent-drop guard. Every filter must
// belong to a selected suite, and every comma token must match >=1 on-disk
// test file in that suite's directory under the runner's own matcher.
Object.keys(smoke.filters || {}).forEach(function (s) {
  check('smoke filter target ' + s + ' is in smoke.suites (a filter for an unselected suite is dead)',
        smoke.suites.indexOf(s) !== -1);
  var cmd = SUITES[s] && SUITES[s].cmd;
  check('smoke filter target ' + s + ' is a suite-runner suite with a filterable dir',
        !!(cmd && cmd[1]), cmd ? cmd.join(' ') : '(no cmd)');
  if (!cmd || !cmd[1]) return;
  var dir = path.join(ROOT, path.dirname(cmd[1]));
  var members = fs.readdirSync(dir).filter(function (f) { return /^test_.*\.js$/.test(f); });
  smoke.filters[s].split(',').map(function (t) { return t.trim(); }).filter(Boolean)
    .forEach(function (tok) {
      var n = members.filter(function (f) { return matchesFilter(f, tok); }).length;
      check('smoke ' + s + ' filter token "' + tok + '" matches >=1 on-disk file (a dead token silently shrinks the tier)',
            n >= 1, n + ' file(s)');
    });
});
// The two load-bearing members by name: smoke must keep really booting the
// OS from the fixture and really driving the SAB protocol core.
check('smoke kernel filter selects test_strace_e2e.js (the real fixture-boot leg)',
      matchesFilter('test_strace_e2e.js', smoke.filters.kernel));
check('smoke kernel filter selects test_kernel.js (the SAB protocol core)',
      matchesFilter('test_kernel.js', smoke.filters.kernel));
// ...and must NOT select the bake-path monster — pulling test_os_boot.js
// (~710s, --no-fixture) in by an over-broad token would silently turn the
// 5-minute tier into a 15-minute one.
check('smoke kernel filter does NOT select test_os_boot.js (the ~710s bake-path test)',
      !matchesFilter('test_os_boot.js', smoke.filters.kernel));

// ---- the dispatcher gates itself ----
// An edit to the RULES table must select the suite this guard runs in — with
// the old `[]` mapping, breaking the closure selected nothing.
var self = planFromDiff(['tests/run.js']).suites;
check('tests/run.js selects host (the suite holding this guard)', self.has('host'));

console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nAll checks passed');
process.exit(failures ? 1 : 0);
