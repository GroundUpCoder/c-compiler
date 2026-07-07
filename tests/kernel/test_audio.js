#!/usr/bin/env node
// Audio mixer semantics (todos/0017; design: WM.md "Audio mixing — the
// kernel sound server") without wasm: fake workers over a brokered kernel,
// the test playing the process side of the AUDIO_OPEN handshake (the
// test_wm.js pattern) and the page side of the output ring. Kernel-side
// mixing is pure math over SABs, so every assertion here is EXACT-value
// deterministic: same-rate passthrough, linear-interp resample, mono
// fan-out, multi-stream sum + clamp, cursor continuity across pumps,
// pause semantics, target-depth pacing, drain-on-close, and lifecycle
// reclaim on exit and SIGKILL (the never-wedge rule).
//
// Run: node tests/kernel/test_audio.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const { BLOCK_FS } = require(path.resolve(__dirname, '../../host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake worker plumbing (test_wm.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, terminated: false,
    postMessage() {},
    onMessage(fn) { h.msg = fn; },
    onExit(fn) { h.exitCb = fn; },
    terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}
const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/app', new Uint8Array([2])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {},
  log: () => {},
});

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
function submit(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  return {
    async finish() {
      while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
      const resp = K.readPayload(i32, u8);
      Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
      return resp;
    },
  };
}
const rpc = (pid, op, req) => submit(pid, op, req).finish();

// ---- stream-side helpers (what host.js's createSurfaceSDL audio does) ----
const RING_CAP = 64 * 1024;   // multiple of every frame size
function makeStream(cap) {
  cap = cap || RING_CAP;
  const sab = new SharedArrayBuffer(K.AU_HDR_BYTES + cap);
  return {
    sab, cap,
    control: new Int32Array(sab, 0, 4),
    dv: new DataView(sab, K.AU_HDR_BYTES, cap),
  };
}
async function openStream(pid, st, freq, format, channels) {
  workers.get(pid).msg({ type: 'audio-sab', sab: st.sab });
  return rpc(pid, K.OP.AUDIO_OPEN, { freq, format, channels });
}
// Producer discipline of audioRingPush: fill, advance writePos masked, add queued.
function push(st, bytes) {
  const wpos = Atomics.load(st.control, K.AU_WPOS) % st.cap;
  for (let i = 0; i < bytes.length; i++) st.dv.setUint8((wpos + i) % st.cap, bytes[i]);
  Atomics.store(st.control, K.AU_WPOS, (wpos + bytes.length) % st.cap);
  Atomics.add(st.control, K.AU_QUEUED, bytes.length);
}
function pushS16(st, samples) {           // interleaved s16 sample values
  const b = new Uint8Array(samples.length * 2);
  const dv = new DataView(b.buffer);
  samples.forEach((v, i) => dv.setInt16(i * 2, v, true));
  push(st, b);
}
const play = (st) => Atomics.store(st.control, K.AU_PLAYING, 1);
const pause = (st) => Atomics.store(st.control, K.AU_PLAYING, 0);
const queued = (st) => Atomics.load(st.control, K.AU_QUEUED);

// ---- output-ring reader (what the page's createAudioReceiver does) ----
function makeReader(out) {
  const control = new Int32Array(out.sab, 0, 4);
  const dv = new DataView(out.sab, K.AU_HDR_BYTES, out.bufferSize);
  return {
    queued: () => Atomics.load(control, K.AU_QUEUED),
    // Read n f32 stereo frames -> [[L,R],...], consuming them.
    read(n) {
      const qb = Atomics.load(control, K.AU_QUEUED);
      const wpos = Atomics.load(control, K.AU_WPOS) % out.bufferSize;
      let rpos = ((wpos - qb) % out.bufferSize + out.bufferSize) % out.bufferSize;
      const frames = [];
      for (let i = 0; i < n; i++) {
        frames.push([dv.getFloat32(rpos, true), dv.getFloat32((rpos + 4) % out.bufferSize, true)]);
        rpos = (rpos + 8) % out.bufferSize;
      }
      Atomics.sub(control, K.AU_QUEUED, n * 8);
      return frames;
    },
  };
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

(async () => {
  const initPid = await kernel.boot({ path: '/bin/init' });
  check('boots', initPid === 1);
  const r1 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const appPid = r1.pid;
  check('spawned app', appPid > 1);

  // ---- open: handshake + validation ----
  const noSab = await rpc(appPid, K.OP.AUDIO_OPEN, { freq: 48000, format: K.AU_FMT_S16, channels: 2 });
  check('open without SAB -> EINVAL', noSab.errno === 'EINVAL');
  let bad = await openStream(appPid, makeStream(), 48000, K.AU_FMT_S16, 3);
  check('open with channels=3 -> EINVAL', bad.errno === 'EINVAL');
  bad = await openStream(appPid, makeStream(), 48000, 0x1234, 2);
  check('open with unknown format -> EINVAL', bad.errno === 'EINVAL');
  bad = await openStream(appPid, makeStream(), 999, K.AU_FMT_S16, 2);
  check('open with absurd rate -> EINVAL', bad.errno === 'EINVAL');
  bad = await openStream(appPid, makeStream(1001), 48000, K.AU_FMT_S16, 2);  // 1001 % 4 != 0
  check('open with frame-misaligned capacity -> EINVAL', bad.errno === 'EINVAL');

  const st1 = makeStream();
  const o1 = await openStream(appPid, st1, 48000, K.AU_FMT_S16, 2);
  check('open 48k stereo S16 -> aid', o1.aid > 0, JSON.stringify(o1));

  // ---- no output ring yet: pump is a no-op ----
  pushS16(st1, [16384, -8192]);
  play(st1);
  check('pump without audioInit -> 0 frames', kernel.audioPump() === 0);

  const outInfo = kernel.audioInit({});
  check('audioInit: f32 stereo 48k', outInfo.freq === 48000 && outInfo.channels === 2 &&
    outInfo.format === K.AU_FMT_F32 && outInfo.sab.byteLength === K.AU_HDR_BYTES + outInfo.bufferSize);
  const out = makeReader(outInfo);

  // ---- same-rate passthrough: exact values ----
  // Queue now holds 4 frames: the pre-init (16384,-8192) plus these three.
  pushS16(st1, [16384, -8192, 8192, 4096, -32768, 32767]);
  let n = kernel.audioPump(100);
  check('pump produced all 4 queued frames', n === 4, n);
  let f = out.read(4);
  check('frame 0 exact (0.5, -0.25)', near(f[0][0], 0.5) && near(f[0][1], -0.25), JSON.stringify(f[0]));
  check('frame 2 exact (0.25, 0.125)', near(f[2][0], 0.25) && near(f[2][1], 0.125), JSON.stringify(f[2]));
  check('frame 3 exact (-1, ~1)', near(f[3][0], -1) && near(f[3][1], 32767 / 32768), JSON.stringify(f[3]));
  check('source fully consumed', queued(st1) === 0);

  // ---- pause: not consumed, no output ----
  pause(st1);
  pushS16(st1, [1000, 1000]);
  check('paused stream -> pump idles', kernel.audioPump(10) === 0 && queued(st1) === 4);
  play(st1);
  check('resume -> consumed', kernel.audioPump(10) === 1 && queued(st1) === 0);
  out.read(1);

  // ---- resample 24k mono -> 48k stereo: linear interp, exact ----
  const st2 = makeStream();
  const o2 = await openStream(appPid, st2, 24000, K.AU_FMT_S16, 1);
  check('open 24k mono -> aid', o2.aid > 0);
  pause(st1);                                   // isolate st2
  pushS16(st2, [0, 8192, 16384, -16384]);       // mono ramp: 0, .25, .5, -.5
  play(st2);
  n = kernel.audioPump(8);
  // ratio 0.5: out[n] samples src at n/2 -> 0, .125, .25, .375, .5, 0, -.5(clamped tail)
  check('resample produced 8 frames', n === 8, n);
  f = out.read(8);
  const expL = [0, 0.125, 0.25, 0.375, 0.5, 0, -0.5, -0.5];
  let interpOk = true;
  for (let i = 0; i < 8; i++) {
    if (!near(f[i][0], expL[i]) || !near(f[i][1], expL[i])) interpOk = false;
  }
  check('linear interp exact + mono fans to both channels', interpOk,
    JSON.stringify(f.map((x) => x[0])));
  check('resample consumed whole src frames', queued(st2) === 0);

  // ---- cursor continuity across pumps (fractional carry) ----
  pushS16(st2, [0, 8192]);
  n = kernel.audioPump(3);                      // 3 out frames <- 1.5 src frames
  check('partial pump produced 3', n === 3, n);
  check('fractional frame kept queued', queued(st2) === 2, queued(st2));  // consumed 1 of 2
  f = out.read(3);
  pushS16(st2, [16384]);
  n = kernel.audioPump(3);
  const f2 = out.read(n);
  // continuation: src ramp 0, .25, .5 -> out .375 (pos 1.5), .5 (pos 2, clamp tail)
  check('cursor carries across pumps', near(f[2][0], 0.25) && near(f2[0][0], 0.375),
    JSON.stringify([f[2][0], f2[0][0]]));
  // drain st2 dry for the next sections
  kernel.audioPump(100); out.read(out.queued() / 8);
  pause(st2);

  // ---- two streams: sum + silence-padding + clamp ----
  play(st1);
  pushS16(st1, [8192, 8192, 8192, 8192, 26000, -26000]);  // 3 frames
  const st3 = makeStream();
  const o3 = await openStream(appPid, st3, 48000, K.AU_FMT_S16, 2);
  pushS16(st3, [8192, -4096, 8192, -4096, 26000, -26000, 26000, 26000]); // 4 frames
  play(st3);
  n = kernel.audioPump(10);
  check('mix bounded by the MOST-available stream', n === 4, n);
  f = out.read(4);
  check('two streams sum (0.25+0.25, 0.25-0.125)', near(f[0][0], 0.5) && near(f[0][1], 0.125),
    JSON.stringify(f[0]));
  check('sum clamps to [-1, 1]', f[2][0] === 1 && f[2][1] === -1, JSON.stringify(f[2]));
  check('short stream pads with silence (st3 alone on frame 3)',
    near(f[3][0], 26000 / 32768) && near(f[3][1], 26000 / 32768), JSON.stringify(f[3]));
  check('both sources drained', queued(st1) === 0 && queued(st3) === 0);

  // ---- target-depth pacing: unbounded pump stops at AU_TARGET_MS ----
  const targetFrames = Math.floor(K.AU_TARGET_MS * 48000 / 1000);
  const big = new Array(2 * (targetFrames + 1000)).fill(100);
  pushS16(st3, big);
  n = kernel.audioPump();
  check('pump tops up to the target depth', n === targetFrames, n);
  check('second pump adds nothing (target met)', kernel.audioPump() === 0);
  out.read(out.queued() / 8);
  n = kernel.audioPump();
  check('after the page drains, pump refills', n === 1000, n);
  out.read(out.queued() / 8);

  // ---- clear()-race heal: negative queuedBytes clamps back to 0 ----
  Atomics.store(st3.control, K.AU_QUEUED, -64);
  check('negative queued (clear race) heals + idles', kernel.audioPump(4) === 0 &&
    queued(st3) === 0);

  // ---- drain-on-close: queued tail finishes, then reclaim ----
  pushS16(st1, [4096, 4096, 4096, 4096]);       // 2 frames queued
  const cWrong = await rpc(1, K.OP.AUDIO_CLOSE, { aid: o1.aid });
  check('close from the wrong process -> EINVAL', cWrong.errno === 'EINVAL');
  await rpc(appPid, K.OP.AUDIO_CLOSE, { aid: o1.aid });
  let list = kernel.audioList();
  check('closed stream is dying, still listed', list.some((s) => s.aid === o1.aid && s.dying));
  n = kernel.audioPump(10);
  f = out.read(2);
  check('dying stream drains its tail', n === 2 && near(f[0][0], 0.125), JSON.stringify([n, f[0]]));
  kernel.audioPump(10);                          // reclaim sweep
  list = kernel.audioList();
  check('drained dying stream reclaimed', !list.some((s) => s.aid === o1.aid), JSON.stringify(list));

  // ---- close while paused: dropped immediately (nothing can drain it) ----
  pushS16(st2, [5, 5]);
  await rpc(appPid, K.OP.AUDIO_CLOSE, { aid: o2.aid });
  check('paused dying stream dropped at once', !kernel.audioList().some((s) => s.aid === o2.aid));

  // ---- lifecycle: SIGKILL mid-play drains then reclaims; mixer keeps running ----
  const r2 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const st4 = makeStream();
  const o4 = await openStream(r2.pid, st4, 48000, K.AU_FMT_S16, 2);
  pushS16(st4, [8192, 8192, 8192, 8192]);
  play(st4);
  pushS16(st3, [8192, -8192, 8192, -8192, 8192, -8192]);  // survivor keeps playing
  play(st3);
  kernel.kill(r2.pid, 9, null);
  check('worker terminated', workers.get(r2.pid).terminated === true);
  check('killed stream is dying', kernel.audioList().some((s) => s.aid === o4.aid && s.dying));
  n = kernel.audioPump(10);
  f = out.read(3);
  check('kill: tail mixes with the survivor (0.25+0.25)', n === 3 &&
    near(f[0][0], 0.5) && near(f[0][1], 0.0), JSON.stringify([n, f[0]]));
  check('kill: survivor alone on frame 3', near(f[2][0], 0.25) && near(f[2][1], -0.25),
    JSON.stringify(f[2]));
  kernel.audioPump(10);
  check('killed stream reclaimed, survivor lives',
    !kernel.audioList().some((s) => s.aid === o4.aid) &&
    kernel.audioList().some((s) => s.aid === o3.aid), JSON.stringify(kernel.audioList()));

  // ---- lifecycle: normal exit reclaims via the same path ----
  workers.get(appPid).msg({ type: 'exited', code: 0 });
  await tick();
  kernel.audioPump(10);                          // st3 was dry -> dropped by the sweep
  check('exit reclaims the remaining stream', kernel.audioList().length === 0,
    JSON.stringify(kernel.audioList()));
  check('pump on an empty table stays a no-op', kernel.audioPump() === 0);

  console.log(failures ? `\ntest_audio: ${failures} FAILED` : '\ntest_audio: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
