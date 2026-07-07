// Host-level regression test for the audio ring write-position wrap
// (CONFORMANCE-REMAINING "Audio ring write position wraps at 2^31"):
//
// __sdl_queue_audio advanced control[0] (writePos) with an unbounded
// Atomics.add on an Int32Array. After 2^31 cumulative bytes of audio
// (~1.5-3h of 44.1kHz stereo S16) the counter wraps negative,
// `writePos % cap` goes negative, and ringData.set(..., negativeOffset)
// throws RangeError — killing the whole run. Fix: keep writePos masked
// modulo capacity (single producer, so load/modify/store is race-free).
//
// createBrowserSDL constructs cleanly in Node with a stub canvas/ctx
// (WebGPU init is lazy), so this drives the REAL producer function
// directly; the near-2^31 counter is the honest compressed repro since
// that state is reachable one accepted chunk at a time.
//
// Run: node tests/host/test_audio_ring_wrap.js
'use strict';
const path = require('path');
const host = require(path.resolve(__dirname, '../../host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const CAP = 65536;
const ENV = 'c'; // ENV_KEY in host.js

function makeProducer(sharedAudio, mem) {
  const ctx = { readString: () => '', getMemory: () => mem, getExports: () => ({}) };
  const sdl = host.createBrowserSDL({
    canvas: {}, ctx, sharedAudioBuffer: sharedAudio,
    notifyAudio: () => {}, notifyWindow: null,
  });
  return sdl[ENV].__sdl_queue_audio;
}

// ---- 1. Crossing 2^31 must not throw and must keep accepting ----------
{
  const sharedAudio = host.createSharedAudioBuffer(CAP);
  const control = new Int32Array(sharedAudio.sharedBuffer, 0, 4);
  const mem = { buffer: new ArrayBuffer(1 << 20) };
  new Uint8Array(mem.buffer).fill(0xab);
  const queue = makeProducer(sharedAudio, mem);

  // Simulate ~3h of accepted audio: counter just below 2^31.
  Atomics.store(control, 0, 2147483000);

  let threw = null;
  let accepted = 0;
  try {
    for (let i = 0; i < 4; i++) {
      accepted += queue(1, 4096, 4096);
      Atomics.store(control, 1, 0); // consumer drains fully between calls
    }
  } catch (e) {
    threw = e;
  }
  check('no RangeError queueing across the 2^31 boundary', threw === null,
    threw && threw.message);
  check('all bytes accepted across the boundary', accepted === 4 * 4096,
    'accepted=' + accepted);
  const wp = Atomics.load(control, 0);
  check('writePos stays masked into [0, cap)', wp >= 0 && wp < CAP, 'writePos=' + wp);
}

// ---- 2. Byte integrity where the consumer expects the data ------------
// The receiver computes readPos = ((writePos - queuedBytes) % cap + cap) % cap
// and reads forward. Whatever the (possibly huge, pre-fix-era) seed value of
// the counter, bytes must land exactly there — including across the ring
// boundary.
{
  const sharedAudio = host.createSharedAudioBuffer(CAP);
  const control = new Int32Array(sharedAudio.sharedBuffer, 0, 4);
  const ring = new Uint8Array(sharedAudio.sharedBuffer, 16, CAP);
  const mem = { buffer: new ArrayBuffer(1 << 20) };
  const queue = makeProducer(sharedAudio, mem);

  // Seed so the write spans the ring boundary AND sits near 2^31:
  // 2147481480 % 65536 = 63368; 63368 + 4096 wraps past 65536.
  const SEED = 2147481480;
  Atomics.store(control, 0, SEED);

  const src = new Uint8Array(mem.buffer, 256, 4096);
  for (let i = 0; i < 4096; i++) src[i] = (i * 131 + 7) & 0xff;

  let threw = null;
  let accepted = 0;
  try { accepted = queue(1, 256, 4096); } catch (e) { threw = e; }
  check('boundary-spanning queue does not throw', threw === null,
    threw && threw.message);
  check('boundary-spanning queue accepted in full', accepted === 4096,
    'accepted=' + accepted);

  if (threw === null && accepted === 4096) {
    const writePos = Atomics.load(control, 0);
    const queued = Atomics.load(control, 1);
    check('queuedBytes matches accepted', queued === 4096, 'queued=' + queued);
    let readPos = (writePos - queued);
    readPos = ((readPos % CAP) + CAP) % CAP;
    check('consumer readPos lands on the seeded slot', readPos === SEED % CAP,
      'readPos=' + readPos + ' want=' + (SEED % CAP));
    let bad = -1;
    for (let i = 0; i < 4096; i++) {
      if (ring[(readPos + i) % CAP] !== ((i * 131 + 7) & 0xff)) { bad = i; break; }
    }
    check('ring bytes exact across the wrap', bad === -1, 'first diff @' + bad);
  }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
