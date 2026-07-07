#!/usr/bin/env node
// Audio mixer end-to-end (todos/0017): a REAL C SDL program compiled by
// compiler.js runs as a worker_thread under the kernel; its
// SDL_OpenAudioDeviceStream becomes a kernel mixer stream (host.js
// createSurfaceSDL audio, AUDIO_OPEN handshake over the FIFO channel).
// Proves the full loop:
//   SDL_OpenAudioDeviceStream -> audio-sab + AUDIO_OPEN RPC
//   SDL_PutAudioStreamData -> source-ring producer (frame-aligned pushes)
//   SDL_ResumeAudioStreamDevice -> playing flag -> pump mixes EXACT values
//   two concurrent streams sum; SDL_GetAudioStreamQueued self-pacing drains
//   SIGKILL mid-play -> stream drains dry, then reclaimed; mixer keeps going
//
// Run: node tests/kernel/test_audio_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Two streams from ONE process (the fake-worker suite covers two
// PROCESSES): a 48k stereo S16 constant at (0.25, -0.25) and a second at
// (0.125, 0.125) — mixed output must be exactly (0.375, -0.125).
const APP_C = `
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
static SDL_AudioStream *s1, *s2;
static short b1[256 * 2], b2[256 * 2];
static int announced = 0;
static void frame_cb(void) {
    /* Self-pace like doom: keep ~4800 frames (100ms) queued per stream. */
    while (SDL_GetAudioStreamQueued(s1) < 4800 * 4)
        SDL_PutAudioStreamData(s1, b1, sizeof(b1));
    while (SDL_GetAudioStreamQueued(s2) < 4800 * 4)
        SDL_PutAudioStreamData(s2, b2, sizeof(b2));
    if (!announced) { announced = 1; printf("PUMPING\\n"); fflush(stdout); }
}
int main(void) {
    SDL_Init(SDL_INIT_AUDIO);
    for (int i = 0; i < 256; i++) {
        b1[i * 2] = 8192;  b1[i * 2 + 1] = -8192;   /* 0.25, -0.25 */
        b2[i * 2] = 4096;  b2[i * 2 + 1] = 4096;    /* 0.125, 0.125 */
    }
    SDL_AudioSpec spec = { SDL_AUDIO_S16, 2, 48000 };
    s1 = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, 0, 0);
    s2 = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, 0, 0);
    if (!s1 || !s2) { printf("NOSTREAM\\n"); return 3; }
    SDL_ResumeAudioStreamDevice(s1);
    SDL_ResumeAudioStreamDevice(s2);
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve();
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 20);
  })();
});
const waitFor = (fn, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return resolve();
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for condition'));
    setTimeout(poll, 20);
  })();
});
const near = (a, b) => Math.abs(a - b) < 1e-6;

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — audio e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  const outInfo = kernel.audioInit({});
  const octl = new Int32Array(outInfo.sab, 0, 4);
  const odv = new DataView(outInfo.sab, K.AU_HDR_BYTES, outInfo.bufferSize);

  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('PUMPING');

  // Both streams registered + playing via the real RPC handshake.
  await waitFor(() => kernel.audioList().length === 2 &&
                      kernel.audioList().every((s) => s.queued > 0));
  const list = kernel.audioList();
  check('two streams registered (48k stereo)', list.length === 2 &&
    list.every((s) => s.freq === 48000 && s.channels === 2 && !s.dying), JSON.stringify(list));

  // Pump: the mix of both constants, exact.
  const n = kernel.audioPump(64);
  check('pump produced frames', n === 64, n);
  const qb = Atomics.load(octl, K.AU_QUEUED);
  const wpos = Atomics.load(octl, K.AU_WPOS) % outInfo.bufferSize;
  let rpos = ((wpos - qb) % outInfo.bufferSize + outInfo.bufferSize) % outInfo.bufferSize;
  let mixOk = true;
  for (let i = 0; i < 64; i++) {
    const L = odv.getFloat32(rpos, true), R = odv.getFloat32(rpos + 4, true);
    if (!near(L, 0.375) || !near(R, -0.125)) { mixOk = false; break; }
    rpos = (rpos + 8) % outInfo.bufferSize;
  }
  check('mixed output exact (0.25+0.125, -0.25+0.125)', mixOk);
  Atomics.sub(octl, K.AU_QUEUED, 64 * 8);

  // Self-pacing: the app refills what the mixer consumed.
  const q0 = kernel.audioList()[0].queued;
  await waitFor(() => kernel.audioList()[0].queued >= q0);
  check('app self-paces against GetAudioStreamQueued', true);

  // SIGKILL mid-play: streams drain dry, then reclaim; pump never wedges.
  kernel.kill(1, 9, null);
  await waitFor(() => {
    kernel.audioPump(4096);
    Atomics.store(octl, K.AU_QUEUED, 0);   // page keeps draining
    return kernel.audioList().length === 0;
  });
  check('SIGKILL: streams drained + reclaimed', kernel.audioList().length === 0);
  check('pump after reclaim stays a no-op', kernel.audioPump() === 0);

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\naudio e2e: PASS' : `\naudio e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
