#!/usr/bin/env node
'use strict';
// Runs the whole BlockFS test suite. Pass --long for the deeper fuzz pass.
//   node tests/blockfs/run.js [--long]
var { spawnSync } = require('child_process');
var path = require('path');

var long = process.argv.indexOf('--long') >= 0;
var tests = [
  ['test_tlsf.js', []],
  ['test_tlsf64.js', []],
  ['test_v4.js', []],
  ['test_migrate.js', []],
  ['test_openworkspace.js', []],
  ['test_fsck_v4.js', []],
  ['test_blockfs.js', []],
  ['test_stdin_sab.js', []],
  ['test_e2e.js', []],
  ['test_fsck.js', []],
  ['test_fuzz.js', long ? ['--long'] : []],
];

var failures = 0;
for (var [file, args] of tests) {
  console.log('\n===== ' + file + (args.length ? ' ' + args.join(' ') : '') + ' =====');
  var r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log('\n========================================');
console.log(failures ? failures + ' BlockFS test file(s) FAILED' : 'All BlockFS tests passed');
process.exit(failures ? 1 : 0);
