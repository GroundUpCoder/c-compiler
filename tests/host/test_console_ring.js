// Host-level regression test for the console SharedArrayBuffer ring
// (CONFORMANCE-REMAINING "Console SAB ring has no overflow handling"):
//
// The console_write import copied bytes into the ring unconditionally and
// Atomics.add'd `available` — never checking free space against the
// receiver's progress. A producer bursting more than the ring capacity
// (64 KiB) inside one 16 ms flush window overwrites unread bytes,
// `available` exceeds capacity, and the receiver's local readPos
// permanently desyncs from writePos: garbage output forever after.
//
// Fix: pty-style blocking backpressure. The producer writes at most the
// free space, then Atomics.wait()s on `available` until the receiver
// drains (the receiver Atomics.notify()s after each flush). A single
// console_write larger than the whole ring must also work (chunked loop).
//
// The test runs the REAL producer (a compiled C program calling
// console_write, via runModule in a worker_thread — the producer must be
// off the receiver's thread since it now legitimately blocks) against the
// REAL receiver (createConsoleReceiver on the main thread), and asserts
// the received stream is byte-exact. It also samples `available` and
// asserts it never exceeds capacity.
//
// Run: node tests/host/test_console_ring.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST = path.join(ROOT, 'host.js');
const host = require(HOST);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// 1 MiB total: many small writes, then ONE write far larger than the
// 64 KiB ring (exercises the chunked blocking loop inside one call).
// Pattern period is 251 (prime, coprime to the 64 KiB ring size): if the
// producer laps the reader, successive laps deposit DIFFERENT bytes at
// each ring slot, so an overrun can't masquerade as correct output (a
// 256-periodic pattern would repeat identically every lap and hide it).
const TOTAL = 1048576;
const BIG = 200000;
const SRC = `
extern void console_write(void *opaque, const unsigned char *buf, int len);
static unsigned char chunk[${BIG}];
int main(void) {
    unsigned int gi = 0;
    while (gi < ${TOTAL} - ${BIG}) {
        unsigned int n = 4093;
        if (n > ${TOTAL} - ${BIG} - gi) n = ${TOTAL} - ${BIG} - gi;
        for (unsigned int i = 0; i < n; i++)
            chunk[i] = (unsigned char)((gi + i) % 251u);
        console_write(0, chunk, (int)n);
        gi += n;
    }
    for (unsigned int i = 0; i < ${BIG}; i++)
        chunk[i] = (unsigned char)((gi + i) % 251u);
    console_write(0, chunk, ${BIG});
    return 0;
}
`;

function expectedBytes() {
  const buf = Buffer.alloc(TOTAL);
  for (let g = 0; g < TOTAL; g++) buf[g] = g % 251;
  return buf;
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

const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
const runModule = require(workerData.hostPath);
const fs = require('fs');
const bytes = fs.readFileSync(workerData.wasmPath);
runModule({
  bytes,
  args: ['ringtest'],
  fs: fs,
  sharedConsoleBuffer: { sharedBuffer: workerData.sab, bufferSize: workerData.bufSize },
}).then((code) => parentPort.postMessage({ exit: code }))
  .catch((e) => parentPort.postMessage({ error: String((e && e.stack) || e) }));
`;

async function main() {
  // Watchdog: a deadlocked producer/receiver pair must fail, not hang.
  const watchdog = setTimeout(() => {
    console.log('  FAIL watchdog: test did not finish within 30s (deadlock?)');
    process.exit(1);
  }, 30000);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-ring-'));
  const cFile = path.join(tmp, 'ringtest.c');
  const wasmFile = path.join(tmp, 'ringtest.wasm');
  fs.writeFileSync(cFile, SRC);
  // --allow-undefined: console_write resolves as a host import (like tinyemu)
  cp.execFileSync('node', [COMPILER, cFile, '--allow-undefined', '-o', wasmFile],
    { stdio: 'pipe' });

  const con = host.createSharedConsoleBuffer(); // default 64 KiB
  const control = new Int32Array(con.sharedBuffer, 0, 4);
  const chunks = [];
  const receiver = host.createConsoleReceiver({
    sharedBuffer: con.sharedBuffer,
    bufferSize: con.bufferSize,
    onData: (b) => chunks.push(Buffer.from(b)),
  });

  // Sample the available counter at high frequency: with blocking
  // backpressure it can never exceed the ring capacity. Pre-fix the whole
  // 1 MiB burst lands before the first 16 ms flush, so this reliably
  // observes available >> capacity.
  let maxAvail = 0;
  const sampler = setInterval(() => {
    const a = Atomics.load(control, 1);
    if (a > maxAvail) maxAvail = a;
  }, 1);

  const worker = new Worker(WORKER_CODE, {
    eval: true,
    workerData: { hostPath: HOST, wasmPath: wasmFile, sab: con.sharedBuffer, bufSize: con.bufferSize },
  });
  const result = await new Promise((resolve) => {
    worker.on('message', resolve);
    worker.on('error', (e) => resolve({ error: String((e && e.stack) || e) }));
    worker.on('exit', (code) => resolve({ error: 'worker exited early (' + code + ')' }));
  });
  await worker.terminate();
  clearInterval(sampler);
  receiver.close(); // final flush drains the ≤64 KiB residue

  check('program ran to completion', result.error === undefined && result.exit === 0,
    result.error !== undefined ? result.error : 'exit=' + result.exit);

  const got = Buffer.concat(chunks);
  const want = expectedBytes();
  check('no bytes lost or duplicated', got.length === want.length,
    'got=' + got.length + ' want=' + want.length);
  check('bytes exact through the ring', got.equals(want), firstDiff(got, want));
  check('available never exceeded ring capacity', maxAvail <= con.bufferSize,
    'maxAvail=' + maxAvail + ' cap=' + con.bufferSize);

  fs.rmSync(tmp, { recursive: true, force: true });
  clearTimeout(watchdog);
  console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
