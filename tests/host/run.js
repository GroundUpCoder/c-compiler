#!/usr/bin/env node
'use strict';
// Runs the host-level suite: host.js's Node output path and the aux
// entry points around it (serve.js first-run). Fast, Node-only.
//   node tests/host/run.js
var { spawnSync } = require('child_process');
var path = require('path');

var tests = [
  ['test_epipe_listeners.js', []],       // runModule must not stack stream 'error' listeners
  ['test_stdout_flush.js', []],          // exit drains piped stdout; queued chunks survive memory.grow
  ['test_console_ring.js', []],          // console SAB ring blocks (pty backpressure), never overruns
  ['test_audio_ring_wrap.js', []],       // audio ring writePos stays masked; no RangeError at 2^31
  ['../serve/test_first_run.js', []],    // `node serve.js .` prints a URL that 200s (COOP/COEP)
];

var failures = 0;
for (var [file, args] of tests) {
  console.log('\n===== ' + file + (args.length ? ' ' + args.join(' ') : '') + ' =====');
  var r = spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { stdio: 'inherit' });
  if (r.status !== 0) failures++;
}
console.log('\n========================================');
console.log(failures ? failures + ' host test file(s) FAILED' : 'All host tests passed');
process.exit(failures ? 1 : 0);
