// Host-level regression test (code-debt scan CD28): the native-fs flavor's
// stdin and pipe buffers used plain JS arrays — push-per-byte on fill,
// splice(0,n) on drain — so bulk input was O(n²). They now share the ONE
// ByteQueue chunk deque (whole-Uint8Array push, subarray/set drain). This
// test proves byte-exact passthrough at MB scale on both paths:
//
//  - pipe leg (in-process): 6MB through env.pipe()/write/read with
//    mutually-prime chunk sizes, so reads straddle the queue's chunk
//    boundaries and head offset; then write-end close → EOF.
//  - stdin leg (child process): re-spawns this file with --stdin-child and
//    4MB piped in; the child drains fd 0 via env.read(0, ...) (the
//    process.stdin 'data' fill path) and verifies the pattern.
//
// Drives createFileSystem (the host.js test export) directly; the JSPI
// Suspending wrapper is replaced with identity BEFORE the env is built
// (the test_pipe_read_block.js pattern).
//
// Run: node tests/host/test_stream_bulk.js
'use strict';
const path = require('path');
const fs = require('fs');

WebAssembly.Suspending = function (f) { return f; };

const ROOT = path.resolve(__dirname, '../..');
const { createFileSystem } = require(path.join(ROOT, 'host.js'));

// Pattern depends only on the GLOBAL stream offset — misordering, loss or
// duplication shows up as a mismatch at a precise offset.
function patByte(i) {
  return (i * 31 + ((i >> 8) * 17) + ((i >> 16) * 7) + 5) & 0xff;
}
function fillPat(buf, base) {
  for (let i = 0; i < buf.length; i++) buf[i] = patByte(base + i);
}
function checkPat(buf, n, base) {
  for (let i = 0; i < n; i++) {
    if (buf[i] !== patByte(base + i)) {
      throw new Error('byte mismatch at stream offset ' + (base + i) +
        ': got ' + buf[i] + ' want ' + patByte(base + i));
    }
  }
}

function makeEnv() {
  const memory = new WebAssembly.Memory({ initial: 3 }); // 192K scratch
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
  return { env: createFileSystem({ fs: fs, ctx: ctx }).c, memory: memory };
}

const TOTAL_PIPE = 6 * 1024 * 1024;
const TOTAL_STDIN = 4 * 1024 * 1024;
const WCHUNK = 65536, RCHUNK = 50021; // mutually prime → boundary-straddling reads

// ---- child mode: drain process.stdin through env.read(0) ----------------
async function stdinChild() {
  const { env, memory } = makeEnv();
  const RBUF = 65536; // scratch offset in wasm memory
  const bytes = new Uint8Array(memory.buffer);
  let got = 0;
  while (true) {
    const n = await env.read(0, RBUF, RCHUNK);
    if (n === 0) break; // EOF: producer closed and buffer drained
    checkPat(bytes.subarray(RBUF, RBUF + n), n, got);
    got += n;
  }
  if (got !== TOTAL_STDIN) throw new Error('stdin total ' + got + ' != ' + TOTAL_STDIN);
  console.log('stdin child: ' + got + ' bytes byte-exact');
}

// ---- parent mode: pipe leg in-process + spawn the stdin child -----------
async function main() {
  let failures = 0;
  const check = (name, cond, extra) => {
    if (cond) console.log('  ok   ' + name);
    else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
  };

  // Pipe leg
  const { env, memory } = makeEnv();
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const PIPEFD = 64, SRC = 4096, DST = SRC + WCHUNK;
  check('pipe() succeeds', env.pipe(PIPEFD) === 0);
  const rd = view.getInt32(PIPEFD, true);
  const wr = view.getInt32(PIPEFD + 4, true);

  let wrote = 0, got = 0, mismatch = -1;
  while (wrote < TOTAL_PIPE || got < wrote) {
    for (let k = 0; k < 2 && wrote < TOTAL_PIPE; k++) {
      const wn = Math.min(WCHUNK, TOTAL_PIPE - wrote);
      fillPat(bytes.subarray(SRC, SRC + wn), wrote);
      if (env.write(wr, SRC, wn) !== wn) throw new Error('pipe write failed at ' + wrote);
      wrote += wn;
    }
    const n = await env.read(rd, DST, RCHUNK);
    try { checkPat(bytes.subarray(DST, DST + n), n, got); }
    catch (e) { if (mismatch < 0) { mismatch = got; console.log('  ' + e.message); } }
    got += n;
  }
  check('6MB pipe passthrough byte-exact', mismatch < 0 && got === TOTAL_PIPE,
    'got=' + got + ' firstMismatchAt=' + mismatch);
  check('close(write end)', env.close(wr) === 0);
  check('EOF after writer close + drain', (await env.read(rd, DST, RCHUNK)) === 0);

  // Stdin leg (child)
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [__filename, '--stdin-child'],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const wbuf = Buffer.alloc(WCHUNK);
  let fed = 0;
  const feed = () => {
    while (fed < TOTAL_STDIN) {
      const wn = Math.min(WCHUNK, TOTAL_STDIN - fed);
      fillPat(wbuf.subarray(0, wn), fed);
      fed += wn;
      if (!child.stdin.write(Buffer.from(wbuf.subarray(0, wn)))) {
        child.stdin.once('drain', feed);
        return;
      }
    }
    child.stdin.end();
  };
  feed();
  const code = await new Promise(resolve => child.on('close', resolve));
  check('stdin child drains 4MB byte-exact (exit 0)', code === 0, 'exit=' + code);

  console.log(failures ? failures + ' check(s) FAILED' : 'test_stream_bulk: all checks passed');
  process.exit(failures ? 1 : 0);
}

const entry = process.argv.includes('--stdin-child') ? stdinChild() : main();
entry.then(() => { }, (e) => { console.error(e); process.exit(1); });
