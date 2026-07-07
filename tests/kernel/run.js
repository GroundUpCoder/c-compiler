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
  ['test_tty.js', []],          // Phase 3: line discipline semantics (kernel-side, no wasm)
  ['test_tty_e2e.js', []],      // Phase 3: real C driven by a scripted UI bridge
  ['test_fs_e2e.js', []],       // 0009: brokered fs — shared offsets, fd_actions, SIGKILL+fsck, winsize
  ['test_pipes.js', []],        // Phase 4: pipe OFD semantics over the SAB protocol (no wasm)
  ['test_pipes_e2e.js', []],    // Phase 4: real C pipelines — blocking wake, EOF, SIGPIPE death
  ['test_sockets.js', []],      // 0008: AF_UNIX OFD semantics over the SAB protocol (no wasm)
  ['test_sockets_e2e.js', []],  // 0008: real C client/server — accept/connect/send/recv, poll
  ['test_jobctl_e2e.js', []],   // Phase 4: real C stop/cont — WUNTRACED/WCONTINUED, output halts
  ['test_jobctl_tty_e2e.js', []], // interactive Ctrl-Z/fg/bg/kill %1 through hush + the kernel tty
  ['test_os_boot.js', []],      // 0004: headless OS boot — seed, protoshell, cc, persistence
  ['test_vi_e2e.js', []],       // 0011: busybox vi through the real tty — raw mode, edit sessions
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
