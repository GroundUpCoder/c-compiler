#!/usr/bin/env node
'use strict';
// #582 regression guard — the py skip baseline catches a skip-set drift.
//
// WHY: a SKIP is the one outcome that looks identical to success. The v244
// ship gate reported "902 passed, 0 failed, 113 skipped" and nobody could say
// whether 113 was normal, because no tally had ever been preserved — a test
// that silently stops running does not fail, it just leaves the count. The
// baseline (tests/py-skip-baseline.json) pins every expected py-leg skip BY
// NAME; tests/run.js's checkSkipBaseline() fails an unfiltered gate whose
// skip set differs in EITHER direction. This file is the red control the
// mechanism owes (the test_diff_rules.js dead-token-guard style): a guard
// only ever observed green is not evidence it works.
var fs = require('fs');
var path = require('path');

var runjs = require(path.join(__dirname, '..', 'run.js'));
var checkSkipBaseline = runjs.checkSkipBaseline;
var PY_CATEGORIES = runjs.PY_CATEGORIES;
var ROOT = path.join(__dirname, '..', '..');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

check('checkSkipBaseline is exported', typeof checkSkipBaseline === 'function');

// Synthetic fixtures. A record is what build/test-py/summary.json carries;
// a baseline is what tests/py-skip-baseline.json carries.
function record(cats) { return { categories: cats }; }
function cat(skips, extra) {
  var names = skips.map(function (s) { return typeof s === 'string' ? { name: s } : s; });
  return Object.assign({ passed: 1, failed: 0, skipped: names.length, skips: names }, extra);
}

var BASE = {
  exemptPrefixes: ['fuzz/live-'],
  categories: { lua: { 'lua/files.lua': 'LUA_SKIP' }, disw: {} },
};

// ---- green control: an exact match raises nothing ----
var green = checkSkipBaseline(record({ lua: cat(['lua/files.lua']), disw: cat([]) }), BASE);
check('green control: matching skip set → 0 violations', green.length === 0,
      JSON.stringify(green));

// ---- RED control: a deliberately-introduced EXTRA skip is caught ----
// This is the acceptance's scenario verbatim: a test stops running (here
// lua/api.lua starts skipping) and the tally would otherwise stay green.
var red = checkSkipBaseline(
  record({ lua: cat(['lua/files.lua', 'lua/api.lua']), disw: cat([]) }), BASE);
check('RED control: extra skip → violation', red.length === 1, JSON.stringify(red));
check('RED control: violation is new-skip and names the test',
      red.length === 1 && red[0].kind === 'new-skip' && red[0].name === 'lua/api.lua' &&
      red[0].category === 'lua', JSON.stringify(red[0]));

// ---- RED control: a stale baseline entry is caught (the xpass direction) ----
// The fixer who retires a gate must claim the win in the same commit — and a
// DELETED test's skip vanishing is exactly the silent-shrink this ticket
// exists to catch.
var stale = checkSkipBaseline(record({ lua: cat([]), disw: cat([]) }), BASE);
check('RED control: baseline entry that did not skip → stale-baseline violation',
      stale.length === 1 && stale[0].kind === 'stale-baseline' &&
      stale[0].name === 'lua/files.lua', JSON.stringify(stale));

// ---- the netting trap: one fixed + one new must be TWO violations ----
// A count-based baseline would net this to zero and hide both events; the
// name-based one must not.
var net = checkSkipBaseline(record({ lua: cat(['lua/api.lua']), disw: cat([]) }), BASE);
check('one retired + one new skip never nets out (2 violations)',
      net.length === 2 &&
      net.some(function (v) { return v.kind === 'new-skip'; }) &&
      net.some(function (v) { return v.kind === 'stale-baseline'; }),
      JSON.stringify(net));

// ---- exemption: fuzz/live-<seed> is nondeterministic by construction ----
var ex = checkSkipBaseline(
  record({ lua: cat(['lua/files.lua', 'fuzz/live-123456']), disw: cat([]) }), BASE);
check('exemptPrefixes: a fuzz/live-<seed> skip raises nothing', ex.length === 0,
      JSON.stringify(ex));

// ---- an unnamed skip cannot be baselined → violation, not a silent pass ----
var anon = checkSkipBaseline(
  record({ lua: cat(['lua/files.lua', { name: '' }]), disw: cat([]) }), BASE);
check('unnamed skip → unnamed-skip violation',
      anon.length === 1 && anon[0].kind === 'unnamed-skip', JSON.stringify(anon));

// ---- a category the baseline never heard of → loud, never a default-pass ----
var unb = checkSkipBaseline(record({ zlib: cat([]) }), BASE);
check('unbaselined category → violation even with zero skips',
      unb.length === 1 && unb[0].kind === 'unbaselined-category', JSON.stringify(unb));

// ---- the COMMITTED baseline: shape pinned against the suite registry ----
// Set equality with PY_CATEGORIES, the diff_rules discipline: a category
// added to the registry without a baseline entry (or a baseline entry for a
// retired category) must fail HERE, in the cheap host suite, not 6 minutes
// into a py leg.
var committed = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests', 'py-skip-baseline.json'), 'utf-8'));
var baseCats = Object.keys(committed.categories || {});
var missing = PY_CATEGORIES.filter(function (c) { return baseCats.indexOf(c) < 0; });
var extraCats = baseCats.filter(function (c) { return PY_CATEGORIES.indexOf(c) < 0; });
check('committed baseline covers every PY category', missing.length === 0,
      missing.length ? 'missing: ' + missing.join(', ') : baseCats.length + ' categories');
check('committed baseline names no retired category', extraCats.length === 0,
      extraCats.length ? 'extra: ' + extraCats.join(', ') : 'none');
check('committed baseline exempts fuzz/live- (csmith seeds are random)',
      Array.isArray(committed.exemptPrefixes) &&
      committed.exemptPrefixes.indexOf('fuzz/live-') >= 0);
// Every entry carries a non-empty attribution — a bare name cannot tell an
// intentional gate from an accident, which is the whole point of the file.
var bare = [];
for (var c in committed.categories) {
  for (var n in committed.categories[c]) {
    if (!committed.categories[c][n] || !String(committed.categories[c][n]).trim()) bare.push(n);
  }
}
check('every committed baseline entry carries an attribution', bare.length === 0,
      bare.slice(0, 3).join(', '));
// The committed baseline validated against itself: rebuild a record from it
// and require zero violations — a self-inconsistent baseline (e.g. an entry
// under the wrong category key) must fail here.
var selfCats = {};
for (var c2 in committed.categories) {
  selfCats[c2] = cat(Object.keys(committed.categories[c2]));
}
var selfCheck = checkSkipBaseline(record(selfCats), committed);
check('committed baseline is self-consistent (0 violations against itself)',
      selfCheck.length === 0, JSON.stringify(selfCheck.slice(0, 2)));

process.exit(failures ? 1 : 0);
