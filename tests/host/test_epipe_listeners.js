// Host-level regression test: runModule must not leak stream 'error'
// listeners. Each call with default writers installs an exit-on-EPIPE
// handler on process.stdout/stderr; before the fix this was per-call
// (function defined inside runModule), so N runs stacked N listeners —
// a MaxListenersExceededWarning after 11 and an unbounded leak in
// long-lived hosts (CONFORMANCE-REMAINING.md "runModule leaks an 'error'
// listener"). Now the handler is module-scoped and installed at most once
// per stream.
//
// Run: node tests/host/test_epipe_listeners.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');
const runModule = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const SRC = 'int main(void) { return 0; }\n';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epipe-listeners-'));
  const cFile = path.join(tmp, 'noop.c');
  const wasmFile = path.join(tmp, 'noop.wasm');
  fs.writeFileSync(cFile, SRC);
  cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });
  const bytes = fs.readFileSync(wasmFile);

  const baseOut = process.stdout.listenerCount('error');
  const baseErr = process.stderr.listenerCount('error');

  for (let i = 0; i < 5; i++) {
    const code = await runModule({ bytes, args: ['noop'], env: {} });
    if (code !== 0) { check('run ' + i + ' exits 0', false, 'code=' + code); }
  }

  check('stdout error listeners grew by at most 1',
    process.stdout.listenerCount('error') <= baseOut + 1,
    'base=' + baseOut + ' now=' + process.stdout.listenerCount('error'));
  check('stderr error listeners grew by at most 1',
    process.stderr.listenerCount('error') <= baseErr + 1,
    'base=' + baseErr + ' now=' + process.stderr.listenerCount('error'));

  // Custom writers must not install the handler at all: fresh streams via
  // a child would be heavyweight; instead assert the count is unchanged by
  // a run that passes writeOut/writeErr (the install is writer-defaulting
  // gated, not unconditional).
  const midOut = process.stdout.listenerCount('error');
  const midErr = process.stderr.listenerCount('error');
  await runModule({ bytes, args: ['noop'], env: {},
    writeOut: function () {}, writeErr: function () {} });
  check('custom writers add no stdout listener',
    process.stdout.listenerCount('error') === midOut);
  check('custom writers add no stderr listener',
    process.stderr.listenerCount('error') === midErr);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
