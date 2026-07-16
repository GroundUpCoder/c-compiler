// Host-level regression test (todos/0233, code-debt scan CD5): the
// native-fs flavor's pipe read must not return a spurious EOF while the
// write end is still open. Before the fix, an empty pipe buffer returned
// 0 ("non-blocking for now") — indistinguishable from EOF, so a reader
// racing its writer silently truncated the stream (the 0171 bug class).
// Now the read parks on a per-pipe waiter list (the readImpl stdin
// pattern) resolved by write / write-end close, and returns 0 only when
// pipe.closed.write.
//
// Drives createFileSystem (the host.js test export) directly. The pipe
// read is wrapped in WebAssembly.Suspending (JSPI) — this dedicated test
// process replaces that wrapper with identity BEFORE the env is built so
// the underlying async function is callable from plain JS.
//
// Run: node tests/host/test_pipe_read_block.js
'use strict';
const path = require('path');
const fs = require('fs');

WebAssembly.Suspending = function (f) { return f; };

const ROOT = path.resolve(__dirname, '../..');
const { createFileSystem } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const memory = new WebAssembly.Memory({ initial: 1 });
const view = new DataView(memory.buffer);
const bytes = new Uint8Array(memory.buffer);
const ctx = {
  readString: () => '/unused',
  createVaReader: () => () => 0,
  setErrno: () => { },
  setErrnoName: () => { },
  getMemory: () => memory,
  getIndirectFunctionTable: () => null,
  writeOut: () => { },
  writeErr: () => { },
};

const tick = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const env = createFileSystem({ fs: fs, ctx: ctx }).c;

  const PIPEFD = 64, BUF = 256, SRC = 512;
  check('pipe() succeeds', env.pipe(PIPEFD) === 0);
  const rd = view.getInt32(PIPEFD, true);
  const wr = view.getInt32(PIPEFD + 4, true);

  // --- Empty pipe, writer open: read must PARK, not return 0 ------------
  let result = null;
  const pending = env.read(rd, BUF, 16).then(n => { result = n; return n; });
  await tick(30);
  check('read on empty pipe with live writer does not return', result === null,
    'returned ' + result + ' (spurious EOF)');

  // --- A write wakes the parked reader ----------------------------------
  bytes.set([104, 105, 33], SRC); // "hi!"
  check('write delivers', env.write(wr, SRC, 3) === 3);
  const n = await pending;
  check('parked read wakes with the data', n === 3, 'n=' + n);
  check('bytes match', bytes[BUF] === 104 && bytes[BUF + 1] === 105 && bytes[BUF + 2] === 33);

  // --- Write-end close wakes a parked reader with real EOF --------------
  let result2 = null;
  const pending2 = env.read(rd, BUF, 16).then(n2 => { result2 = n2; return n2; });
  await tick(30);
  check('second read parks again', result2 === null, 'returned ' + result2);
  check('close(write end)', env.close(wr) === 0);
  check('EOF after writer closes', (await pending2) === 0, 'n=' + result2);

  // --- Buffered data still drains before EOF ----------------------------
  const P2 = 128;
  env.pipe(P2);
  const rd2 = view.getInt32(P2, true), wr2 = view.getInt32(P2 + 4, true);
  env.write(wr2, SRC, 3);
  env.close(wr2);
  check('drain: buffered bytes first', (await env.read(rd2, BUF, 16)) === 3);
  check('drain: then EOF', (await env.read(rd2, BUF, 16)) === 0);

  console.log(failures ? failures + ' check(s) FAILED' : 'test_pipe_read_block: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().then(() => { }, (e) => { console.error(e); process.exit(1); });
