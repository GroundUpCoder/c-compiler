#!/usr/bin/env node
'use strict';
// Regenerate a suite's committed scheduling-hints table (#576 A1) from its
// artifact summary. The hints feed suite-runner's longest-first sort in a
// FRESH artifact dir (a lane worktree has no summary.json yet); they are a
// scheduling hint only — staleness costs a little makespan, never
// correctness — so regenerating after a full run now and then is plenty.
//
//   node tests/lib/update-timings.js                # kernel suite defaults
//   node tests/lib/update-timings.js SUMMARY OUT    # any suite-runner suite
//
// One ms per file, own (fresh) result preferred over a carried one, rounded
// to whole ms. Refuses an empty result set — an absent summary must not
// silently truncate the committed table to {}.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const summaryPath = process.argv[2] || path.join(ROOT, 'build', 'test-kernel', 'summary.json');
const outPath = process.argv[3] || path.join(ROOT, 'tests', 'kernel', 'timings.json');

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
const files = {};
for (const r of summary.results || []) {
  if (r.ms == null) continue;
  // First record per file wins within each class; fresh beats carried.
  if (files[r.file] == null || (files[r.file].carried && !r.carried)) {
    files[r.file] = { ms: Math.round(r.ms), carried: !!r.carried };
  }
}
const names = Object.keys(files).sort();
if (!names.length) {
  process.stderr.write(`update-timings: ${summaryPath} has no timed results — refusing to write an empty table\n`);
  process.exit(1);
}
const out = {
  _: 'scheduling hints only (suite-runner longest-first, #576 A1) — regenerate with node tests/lib/update-timings.js after a full run',
  from: summary.startedAt || null,
  files: Object.fromEntries(names.map(n => [n, files[n].ms])),
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
process.stdout.write(`update-timings: ${names.length} file(s) -> ${path.relative(process.cwd(), outPath)}\n`);
