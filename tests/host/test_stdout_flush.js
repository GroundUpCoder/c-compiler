// Host-level regression test for the Node output-path pair
// (CONFORMANCE-REMAINING "host.js — Node output path"):
//
//  1. Piped stdout truncated at exit — process.exit() fired before Node
//     drained async pipe writes, so a slow consumer lost everything past
//     ~one pipe buffer AFTER write() had returned success to the C
//     program. host.js now drains stdout/stderr before exiting.
//  2. Queued chunks were non-copied views into wasm memory — memory.grow
//     (here: a large malloc+memset after printing) detaches the view
//     while the chunk still sits in the stream queue. The default
//     writers now copy.
//
// The test plays the slow consumer: it leaves the child's stdout unread
// for 400ms so writes queue in the child, then reads everything and
// asserts byte-exact content and a preserved exit code. Pre-fix this
// fails on (1) truncation and, with (1) fixed alone, on (2) corruption.
//
// Run: node tests/host/test_stdout_flush.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST = path.join(ROOT, 'host.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const LINES = 100000; // 20 bytes each -> 2 MB, far past any pipe buffer
const SRC = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
    for (int i = 0; i < ${LINES}; i++) printf("%07d abcdefghijk\\n", i);
    fflush(stdout);
    /* Force memory.grow while chunks may still be queued: detaches the
       ArrayBuffer every queued non-copied view pointed into. */
    size_t big = 32u * 1024 * 1024;
    char *p = malloc(big);
    if (p) memset(p, 7, big);
    printf("END\\n");
    fflush(stdout);
    return 42;
}
`;

function expectedBytes() {
  const parts = [];
  for (let i = 0; i < LINES; i++) {
    parts.push(String(i).padStart(7, '0') + ' abcdefghijk\n');
  }
  parts.push('END\n');
  return Buffer.from(parts.join(''), 'latin1');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stdout-flush-'));
  const cFile = path.join(tmp, 'flood.c');
  const wasmFile = path.join(tmp, 'flood.wasm');
  fs.writeFileSync(cFile, SRC);
  cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });

  const child = cp.spawn('node', [HOST, wasmFile],
    { stdio: ['ignore', 'pipe', 'inherit'] });

  // Attach 'close' BEFORE the pause: the pre-fix child exits (and its
  // streams are torn down) during the sleep, so a listener attached
  // afterwards would never fire and the test would fall off the event
  // loop and exit 0 without asserting anything.
  const closed = new Promise((resolve) => child.on('close', resolve));

  // Slow consumer: don't read for 400ms. The pipe fills, the child's
  // writes queue; before the fix it exits during this window and the
  // queue is discarded.
  await new Promise((r) => setTimeout(r, 400));

  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  const code = await closed;

  const got = Buffer.concat(chunks);
  const want = expectedBytes();
  check('exit code preserved through the drain', code === 42, 'code=' + code);
  check('no bytes lost at exit', got.length === want.length,
    'got=' + got.length + ' want=' + want.length);
  check('bytes exact across memory.grow', got.equals(want),
    firstDiff(got, want));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return 'first diff @' + i + ': got ' + a[i] + ' want ' + b[i];
    }
  }
  return 'lengths ' + a.length + ' vs ' + b.length;
}

main().catch(function (e) { console.error(e); process.exit(1); });
