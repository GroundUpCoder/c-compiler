#!/usr/bin/env node
'use strict';
// Runs the kernel (process control plane) test suite. See todos/KERNEL.md.
//   node tests/kernel/run.js
var { spawnSync } = require('child_process');
var path = require('path');

var tests = [
  ['test_kernel.js', []],       // process-table semantics over the real SAB protocol
  ['test_e2e.js', []],          // real C programs in worker_threads via nodeCreateWorker
  ['test_signals_e2e.js', []],  // Phase 2: async delivery, EINTR/SA_RESTART, pause, exit handshake
];

var failures = 0;
for (var [file, args] of tests) {
  console.log('\n===== ' + file + (args.length ? ' ' + args.join(' ') : '') + ' =====');
  var r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log('\n========================================');
console.log(failures ? failures + ' kernel test file(s) FAILED' : 'All kernel tests passed');
process.exit(failures ? 1 : 0);
