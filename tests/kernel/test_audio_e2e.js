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

// #722 (#529-A) phases, one binary dispatched on argv[1]:
//   tones  — two synthesized tones from DIFFERENT formats/rates (S16 mono
//            24k, U8 mono 48k) converted by MEMORY streams, combined with
//            SDL_MixAudio into ONE device stream, plus a deliberately
//            clipping segment (0.8 + 0.8 in phase — MixAudio must pin 1.0);
//            frame_cb re-flushes the device stream so the C backlog keeps
//            pumping into the ring as the test drains it.
//   ring   — the undersized-ring destroy oracle: put + flush more unique
//            frames than the 256K source ring holds, prove the prefix was
//            submitted and the remainder stayed C-side, then destroy while
//            playing: ONLY the SAB-accepted prefix may reach the mixer.
//   ring2  — a fresh open + playback after the cancelled destroy.
//   epochs — three converted source epochs (S8/8k mono, S16/44.1k stereo,
//            F32/96k stereo) into an S16/2/48k device stream; frame_cb
//            prints SDL_GetAudioStreamQueued whenever it changes, so the
//            driver can force partial frame-aligned kernel drains and
//            compare exact original-byte retirement against a model.
//   loadwav — the #723 (#529-B) integration: two COMMITTED WAV fixtures are
//            planted at real filesystem paths (fwrite through the process
//            fs), decoded by the demand-linked upstream SDL_LoadWAV, and
//            pushed into ONE device stream — float32_stereo.wav (F32/2/48k,
//            the device-ingest spec: its decoded bytes must reach the ring
//            IDENTITY) and imaadpcm_mono.wav (decodes S16/1/22050, converted
//            by a #722 MEMORY stream to the device spec; the app prints the
//            crc of exactly what it pushed and the driver checks the ring
//            against it). Headless-deterministic; no acoustic inference.
const APP2_C = `
#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>

/*__FIXTURE_ARRAYS__*/

static SDL_AudioStream *dev;

static void flush_cb(void) { SDL_FlushAudioStream(dev); }

static unsigned crc32b(const unsigned char *p, unsigned n) {
    unsigned crc = 0xffffffffu, i;
    for (i = 0; i < n; i++) {
        int b;
        crc ^= p[i];
        for (b = 0; b < 8; b++)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}

static void plant(const char *pathn, const unsigned char *b, unsigned n) {
    FILE *f = fopen(pathn, "wb");
    if (!f || fwrite(b, 1, n, f) != n) { printf("PLANTFAIL %s\\n", pathn); exit(3); }
    fclose(f);
}

static void loadwav_mode(void) {
    SDL_AudioSpec dspec = { SDL_AUDIO_F32, 2, 48000 };
    SDL_AudioSpec spec;
    Uint8 *buf;
    Uint32 len;
    static unsigned char conv[65536];
    plant("/float32_stereo.wav", fix_f32, (unsigned)sizeof fix_f32);
    plant("/imaadpcm_mono.wav", fix_ima, (unsigned)sizeof fix_ima);
    dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &dspec, 0, 0);
    if (!dev) { printf("NOSTREAM\\n"); exit(3); }
    /* leg 1: the WAV already matches the device-ingest spec — decoded bytes
       must reach the output ring byte-exact vs the committed fixture. */
    if (!SDL_LoadWAV("/float32_stereo.wav", &spec, &buf, &len)) { printf("LOADFAIL %s\\n", SDL_GetError()); exit(3); }
    if (spec.format != SDL_AUDIO_F32 || spec.channels != 2 || spec.freq != 48000) { printf("BADSPEC1\\n"); exit(3); }
    SDL_PutAudioStreamData(dev, buf, (int)len);
    printf("WAV1 %u\\n", (unsigned)len);
    SDL_free(buf);
    /* leg 2: IMA ADPCM -> S16/1/22050 -> #722 MEMORY conversion to the device
       spec; the crc printed here is the driver's ring oracle. */
    if (!SDL_LoadWAV("/imaadpcm_mono.wav", &spec, &buf, &len)) { printf("LOADFAIL %s\\n", SDL_GetError()); exit(3); }
    if (spec.format != SDL_AUDIO_S16 || spec.channels != 1 || spec.freq != 22050) { printf("BADSPEC2\\n"); exit(3); }
    {
        SDL_AudioStream *cv = SDL_CreateAudioStream(&spec, &dspec);
        int got, total = 0;
        if (!cv) { printf("NOSTREAM\\n"); exit(3); }
        SDL_PutAudioStreamData(cv, buf, (int)len);
        SDL_FlushAudioStream(cv);
        while ((got = SDL_GetAudioStreamData(cv, conv + total, (int)(sizeof conv - (unsigned)total))) > 0) total += got;
        SDL_DestroyAudioStream(cv);
        SDL_PutAudioStreamData(dev, conv, total);
        printf("WAV2 %d %08x\\n", total, crc32b(conv, (unsigned)total));
    }
    SDL_free(buf);
    SDL_ResumeAudioStreamDevice(dev);
    __setAnimationFrameFunc(flush_cb);
    printf("WAVS READY\\n");
    fflush(stdout);
}

static void tones(void) {
    SDL_AudioSpec dspec = { SDL_AUDIO_F32, 2, 48000 };
    SDL_AudioSpec aspec = { SDL_AUDIO_S16, 1, 24000 };
    SDL_AudioSpec bspec = { SDL_AUDIO_U8, 1, 48000 };
    static short ta[24000];
    static unsigned char tb[48000];
    static unsigned char ba[32768], bb[32768];
    static float ca[4800 * 2], cb[4800 * 2];
    SDL_AudioStream *ma, *mb;
    int i;
    dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &dspec, 0, 0);
    ma = SDL_CreateAudioStream(&aspec, &dspec);
    mb = SDL_CreateAudioStream(&bspec, &dspec);
    if (!dev || !ma || !mb) { printf("NOSTREAM\\n"); exit(3); }
    for (i = 0; i < 24000; i++)
        ta[i] = (short)(0.4 * 32767.0 * sin(2.0 * 3.14159265358979323846 * 750.0 * i / 24000.0));
    for (i = 0; i < 48000; i++)
        tb[i] = (unsigned char)(128.0 + 0.4 * 127.0 * sin(2.0 * 3.14159265358979323846 * 3000.0 * i / 48000.0));
    SDL_PutAudioStreamData(ma, ta, (int)sizeof ta);
    SDL_FlushAudioStream(ma);
    SDL_PutAudioStreamData(mb, tb, (int)sizeof tb);
    SDL_FlushAudioStream(mb);
    for (;;) {
        int ga = SDL_GetAudioStreamData(ma, ba, (int)sizeof ba);
        int gb = SDL_GetAudioStreamData(mb, bb, (int)sizeof bb);
        int n = ga < gb ? ga : gb;
        if (n <= 0) break;
        SDL_MixAudio(ba, bb, SDL_AUDIO_F32, (Uint32)n, 1.0f);
        SDL_PutAudioStreamData(dev, ba, n);
    }
    for (i = 0; i < 4800; i++) {
        float v = 0.8f * (float)sin(2.0 * 3.14159265358979323846 * 750.0 * i / 48000.0);
        ca[i * 2] = v; ca[i * 2 + 1] = v;
        cb[i * 2] = v; cb[i * 2 + 1] = v;
    }
    SDL_MixAudio((Uint8 *)ca, (const Uint8 *)cb, SDL_AUDIO_F32, (Uint32)sizeof ca, 1.0f);
    SDL_PutAudioStreamData(dev, ca, (int)sizeof ca);
    SDL_DestroyAudioStream(ma);
    SDL_DestroyAudioStream(mb);
    SDL_ResumeAudioStreamDevice(dev);
    __setAnimationFrameFunc(flush_cb);
    printf("TONES READY\\n");
    fflush(stdout);
}

static void ring(void) {
    SDL_AudioSpec dspec = { SDL_AUDIO_S16, 2, 48000 };
    static short frames[81920 * 2];
    int i;
    dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &dspec, 0, 0);
    if (!dev) { printf("NOSTREAM\\n"); exit(3); }
    for (i = 0; i < 81920; i++) {              /* unique, reconstructible frames */
        frames[i * 2] = (short)(i % 32000);
        frames[i * 2 + 1] = (short)(i / 32000);
    }
    SDL_PutAudioStreamData(dev, frames, (int)sizeof frames);
    SDL_FlushAudioStream(dev);
    printf("RING QUEUED %d\\n", SDL_GetAudioStreamQueued(dev));
    SDL_ResumeAudioStreamDevice(dev);
    SDL_DestroyAudioStream(dev);
    printf("DESTROYED\\n");
    fflush(stdout);
}

extern int __sdl_audiostream_failalloc(int nth);

/* ringfail (review finding 2 against the REAL ring): phase 1 arms each of
   the identity put's two allocations in turn against a 300K put the ring
   would partially accept — nothing may reach the SAB ring (the driver
   verifies ring emptiness while this app parks). Phase 2 proves the
   fail-then-clean-retry sequence on ONE stream: the armed put accepts
   nothing, the retry submits exactly the 256K prefix and backlogs the rest. */
static void ringfail(int phase) {
    SDL_AudioSpec dspec = { SDL_AUDIO_S16, 2, 48000 };
    static short frames[76800 * 2];
    int i, r1, r2;
    dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &dspec, 0, 0);
    if (!dev) { printf("NOSTREAM\n"); exit(3); }
    for (i = 0; i < 76800; i++) { frames[i * 2] = (short)(i % 32000); frames[i * 2 + 1] = (short)(i / 32000); }
    if (phase == 1) {
        __sdl_audiostream_failalloc(1);   /* the ledger node */
        r1 = SDL_PutAudioStreamData(dev, frames, (int)sizeof frames);
        __sdl_audiostream_failalloc(2);   /* node ok, the backlog reserve */
        r2 = SDL_PutAudioStreamData(dev, frames, (int)sizeof frames);
        __sdl_audiostream_failalloc(0);
        printf("FAILPUTS %d %d queued %d\n", r1, r2, SDL_GetAudioStreamQueued(dev));
        fflush(stdout);
        return;   /* park with the stream open; the driver inspects the ring */
    }
    __sdl_audiostream_failalloc(1);
    r1 = SDL_PutAudioStreamData(dev, frames, (int)sizeof frames);
    __sdl_audiostream_failalloc(0);
    r2 = SDL_PutAudioStreamData(dev, frames, (int)sizeof frames);
    printf("RETRY %d %d queued %d\n", r1, r2, SDL_GetAudioStreamQueued(dev));
    fflush(stdout);
}

static void park(void) {
    for (;;) sleep(3600);   /* pid-1 init parks so later boots stay legal */
}

static void ring2(void) {
    SDL_AudioSpec dspec = { SDL_AUDIO_S16, 2, 48000 };
    static short beep[4800 * 2];
    int i;
    dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &dspec, 0, 0);
    if (!dev) { printf("NOSTREAM\\n"); exit(3); }
    for (i = 0; i < 4800; i++) { beep[i * 2] = 8192; beep[i * 2 + 1] = 8192; }
    SDL_PutAudioStreamData(dev, beep, (int)sizeof beep);
    SDL_ResumeAudioStreamDevice(dev);
    printf("SECOND OPEN\\n");
    fflush(stdout);
}

static int lastq = -1;
static void q_cb(void) {
    int q = SDL_GetAudioStreamQueued(dev);
    if (q != lastq) { lastq = q; printf("Q %d\\n", q); fflush(stdout); }
}

static void epochs(void) {
    SDL_AudioSpec dspec = { SDL_AUDIO_S16, 2, 48000 };
    SDL_AudioSpec e1 = { SDL_AUDIO_S8, 1, 8000 };
    SDL_AudioSpec e2 = { SDL_AUDIO_S16, 2, 44100 };
    SDL_AudioSpec e3 = { SDL_AUDIO_F32, 2, 96000 };
    static signed char p1[1000];
    static short p2[800 * 2];
    static float p3[500 * 2];
    int i;
    dev = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &dspec, 0, 0);
    if (!dev) { printf("NOSTREAM\\n"); exit(3); }
    for (i = 0; i < 1000; i++) p1[i] = (signed char)((i * 7) % 200 - 100);
    for (i = 0; i < 800; i++) { p2[i * 2] = (short)(i * 13); p2[i * 2 + 1] = (short)(-i * 11); }
    for (i = 0; i < 500; i++) { p3[i * 2] = (float)i / 1000.0f; p3[i * 2 + 1] = -(float)i / 1000.0f; }
    SDL_SetAudioStreamFormat(dev, &e1, 0);
    SDL_PutAudioStreamData(dev, p1, (int)sizeof p1);
    SDL_SetAudioStreamFormat(dev, &e2, 0);
    SDL_PutAudioStreamData(dev, p2, (int)sizeof p2);
    SDL_SetAudioStreamFormat(dev, &e3, 0);
    SDL_PutAudioStreamData(dev, p3, (int)sizeof p3);
    SDL_FlushAudioStream(dev);
    printf("EPOCHS %d\\n", SDL_GetAudioStreamQueued(dev));
    SDL_ResumeAudioStreamDevice(dev);
    __setAnimationFrameFunc(q_cb);
    fflush(stdout);
}

int main(int argc, char **argv) {
    SDL_Init(SDL_INIT_AUDIO);
    if (argc < 2) return 2;
    if (strcmp(argv[1], "init") == 0) park();
    else if (strcmp(argv[1], "tones") == 0) tones();
    else if (strcmp(argv[1], "ring") == 0) ring();
    else if (strcmp(argv[1], "ringfail1") == 0) ringfail(1);
    else if (strcmp(argv[1], "ringfail2") == 0) ringfail(2);
    else if (strcmp(argv[1], "ring2") == 0) ring2();
    else if (strcmp(argv[1], "epochs") == 0) epochs();
    else if (strcmp(argv[1], "loadwav") == 0) loadwav_mode();
    else return 2;
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);
const cfile2 = path.join(tmp, 'app2.c');
const wasm2 = path.join(tmp, 'app2.wasm');
// The loadwav mode's fixture bytes come from the COMMITTED corpus (the same
// files the #723 differential suite pins against the upstream oracle).
const FIXDIR = path.join(ROOT, 'tests/unit/sdl_load_wav_fixtures');
const fixF32 = fs.readFileSync(path.join(FIXDIR, 'float32_stereo.wav'));
const fixIma = fs.readFileSync(path.join(FIXDIR, 'imaadpcm_mono.wav'));
const cArray = (name, buf) =>
  `static const unsigned char ${name}[] = {${Array.from(buf).join(',')}};`;
fs.writeFileSync(cfile2, APP2_C.replace('/*__FIXTURE_ARRAYS__*/',
  cArray('fix_f32', fixF32) + '\n' + cArray('fix_ima', fixIma)));
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile2, '-o', wasm2], { stdio: 'pipe' });
const image2 = fs.readFileSync(wasm2);

let out = '';
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : p === '/bin/app2' ? image2 : null),
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

  // pid 1 is a parked init (killing the REAL test apps must not halt the
  // kernel — later #722 legs boot fresh processes).
  await kernel.boot({ path: '/bin/app2', argv: ['app2', 'init'], envp: [], cwd: '/' });
  const pidApp = await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
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
  kernel.kill(pidApp, 9, null);
  await waitFor(() => {
    kernel.audioPump(4096);
    Atomics.store(octl, K.AU_QUEUED, 0);   // page keeps draining
    return kernel.audioList().length === 0;
  });
  check('SIGKILL: streams drained + reclaimed', kernel.audioList().length === 0);
  check('pump after reclaim stays a no-op', kernel.audioPump() === 0);

  // ==================== #722 (#529-A) legs ====================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Drain everything currently in the output ring into `dst` (interleaved
  // f32 stereo), returning the number of frames read.
  const drainOut = (dst, at) => {
    const qb = Atomics.load(octl, K.AU_QUEUED);
    if (qb <= 0) return 0;
    const wpos = Atomics.load(octl, K.AU_WPOS) % outInfo.bufferSize;
    let rp = ((wpos - qb) % outInfo.bufferSize + outInfo.bufferSize) % outInfo.bufferSize;
    const frames = Math.floor(qb / 8);
    for (let i = 0; i < frames; i++) {
      if (at + i < dst.length / 2) {
        dst[(at + i) * 2] = odv.getFloat32(rp, true);
        dst[(at + i) * 2 + 1] = odv.getFloat32(rp + 4, true);
      }
      rp = (rp + 8) % outInfo.bufferSize;
    }
    Atomics.sub(octl, K.AU_QUEUED, frames * 8);
    return frames;
  };
  const reapAll = async () => {
    await waitFor(() => {
      kernel.audioPump(4096);
      Atomics.store(octl, K.AU_QUEUED, 0);
      return kernel.audioList().length === 0;
    });
  };
  // Exact-bin Goertzel power (all three probe tones are integer-periodic in
  // the 4480-sample window, so leakage is zero and the ratios are decisive).
  const goertzel = (x, freq) => {
    const c = 2 * Math.cos(2 * Math.PI * freq / 48000);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - c * s1 * s2;
  };

  // -- tones: MEMORY conversion from two formats/rates + SDL_MixAudio into
  // one device stream; both spectral contributions present; the loud tail
  // segment clamps at exactly 1.0. --
  const pidT = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'tones'], envp: [], cwd: '/' });
  await waitOut('TONES READY');
  {
    const want = 52800;
    const cap = new Float32Array(want * 2);
    let got = 0, idle = 0;
    while (got < want && idle < 800) {
      kernel.audioPump(512);
      const n = drainOut(cap, got);
      if (n === 0) { idle++; await sleep(5); continue; }
      idle = 0;
      got += n;
    }
    check('tones: captured the full program', got === want, got);
    const left = new Float32Array(4480);
    for (let i = 0; i < 4480; i++) left[i] = cap[i * 2];
    const p750 = goertzel(left, 750), p3000 = goertzel(left, 3000), p5250 = goertzel(left, 5250);
    check('tone A (750 Hz via S16 mono 24k) present', p750 > 1e5 && p750 > 1000 * (p5250 + 1e-9),
          `p750=${p750.toExponential(2)} p5250=${p5250.toExponential(2)}`);
    check('tone B (3000 Hz via U8 mono 48k) present', p3000 > 1e5 && p3000 > 1000 * (p5250 + 1e-9),
          `p3000=${p3000.toExponential(2)}`);
    let maxAbs = 0, flat = 0;
    for (let i = 48000; i < want; i++) {
      const v = Math.abs(cap[i * 2]);
      if (v > maxAbs) maxAbs = v;
      if (v > 0.9995) flat++;
    }
    check('mix clamps at exactly 1.0', maxAbs <= 1.0000001 && maxAbs > 0.9999, maxAbs);
    check('clipped region is really clipped', flat > 100, flat);
  }
  kernel.kill(pidT, 9, null);
  await reapAll();

  // -- ring: the undersized-ring destroy oracle. 81920 unique frames against
  // a 65536-frame source ring: the prefix is SAB-submitted, the remainder is
  // C-side; destroy cancels the C side without pumping, so the mixer plays
  // exactly the prefix, then the source reclaims. --
  const pidR = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'ring'], envp: [], cwd: '/' });
  await waitOut('RING QUEUED 327680');   // exact original bytes, remainder C-side
  {
    const l = kernel.audioList();
    check('ring: exactly the 256K prefix was submitted', l.length === 1 && l[0].queued === 262144,
          JSON.stringify(l));
  }
  await waitOut('DESTROYED');
  {
    const capB = new Float32Array(70000 * 2);
    let got = 0;
    await waitFor(() => {
      kernel.audioPump(4096);
      got += drainOut(capB, got);
      return kernel.audioList().length === 0;
    });
    check('ring: captured exactly the submitted prefix', got === 65536, got);
    let okSeq = true, firstBad = -1;
    for (let j = 0; j < 65536; j++) {
      const idx = Math.round(capB[j * 2 + 1] * 32768) * 32000 + Math.round(capB[j * 2] * 32768);
      if (idx !== j) { okSeq = false; firstBad = j; break; }
    }
    check('ring: prefix frames are bit-exact and in order', okSeq, 'first bad frame ' + firstBad);
    check('ring: no backlog byte leaked past the prefix', kernel.audioPump(64) === 0);
  }

  // -- ring2: a fresh open + audible playback after the cancelled destroy --
  const pidR2 = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'ring2'], envp: [], cwd: '/' });
  await waitOut('SECOND OPEN');
  {
    const capC = new Float32Array(1024 * 2);
    let got = 0, idle = 0;
    while (got < 1024 && idle < 200) {
      kernel.audioPump(256);
      const n = drainOut(capC, got);
      if (n === 0) { idle++; await sleep(5); continue; }
      got += n;
    }
    check('ring2: playback works after the cancelled destroy',
          got >= 1024 && near(capC[0], 0.25) && near(capC[2046], 0.25), got);
  }
  kernel.kill(pidR2, 9, null);
  await reapAll();

  // -- ringfail: injected allocation failure inside a partial-ring put
  // submits NOTHING to the SAB ring (finding 2's atomicity, proven against
  // the real transport); then fail-and-clean-retry on one stream submits
  // exactly the prefix. --
  const pidRF = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'ringfail1'], envp: [], cwd: '/' });
  await waitOut('FAILPUTS 0 0 queued 0');   // the app is parked now: state is at rest
  {
    const l = kernel.audioList();
    check('ringfail: failed puts submitted nothing to the ring',
          l.length === 1 && l[0].queued === 0, JSON.stringify(l));
  }
  kernel.kill(pidRF, 9, null);
  await reapAll();
  const pidRF2 = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'ringfail2'], envp: [], cwd: '/' });
  await waitOut('RETRY 0 1 queued 307200');
  {
    const l = kernel.audioList();
    check('ringfail: clean retry submitted exactly the ring prefix',
          l.length === 1 && l[0].queued === 262144, JSON.stringify(l));
  }
  kernel.kill(pidRF2, 9, null);
  await reapAll();

  // -- epochs: three converted source epochs, partial frame-aligned kernel
  // drains stopping inside spans and at epoch boundaries; the app's
  // SDL_GetAudioStreamQueued must match the receipt-ledger model exactly. --
  const pidE = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'epochs'], envp: [], cwd: '/' });
  await waitOut('EPOCHS 8200');   // 1000 + 3200 + 4000 original bytes
  {
    // model: epoch spans in device frames (ingest S16 stereo 48k), original
    // frames/bytes, source rates — retirement per the proposal's ledger rule.
    const E = [
      { D: 6000, origBytes: 1000, sfb: 1, sf: 8000 },
      { D: 871,  origBytes: 3200, sfb: 4, sf: 44100 },
      { D: 250,  origBytes: 4000, sfb: 8, sf: 96000 },
    ];
    const DEVTOTAL = 7121;
    const model = (a) => {
      let retired = 0;
      for (const e of E) {
        const ae = Math.max(0, Math.min(a, e.D));
        if (ae === e.D) retired += e.origBytes;
        else retired += Math.min(e.origBytes / e.sfb, Math.floor(ae * e.sf / 48000)) * e.sfb;
        a -= ae;
      }
      return 8200 - retired;
    };
    const l0 = kernel.audioList();
    check('epochs: all three epochs converted + submitted',
          l0.length === 1 && l0[0].queued === DEVTOTAL * 4, JSON.stringify(l0));
    const consumedFrames = () => {
      const l = kernel.audioList();
      return (DEVTOTAL * 4 - (l.length ? l[0].queued : 0)) / 4;
    };
    // stops inside epoch 1, one frame before its boundary, at the boundary,
    // inside epoch 2, at its boundary, inside epoch 3, and at the end
    const stops = [1000, 5999, 6000, 6500, 6871, 7000, 7121];
    for (const target of stops) {
      await waitFor(() => {
        const have = consumedFrames();
        if (have >= target) return true;
        Atomics.store(octl, K.AU_QUEUED, 0);
        kernel.audioPump(Math.min(target - have, 2000));
        return consumedFrames() >= target;
      });
      check('epochs: drain stopped at ' + target + ' device frames', consumedFrames() === target);
      const expectQ = 'Q ' + model(target) + '\n';
      await waitOut(expectQ);
      check('epochs: exact original-byte retirement at ' + target + ' (queued ' + model(target) + ')', true);
    }
  }
  kernel.kill(pidE, 9, null);
  await reapAll();
  check('all #722 sources reclaimed', kernel.audioList().length === 0);

  // ==================== #723 (#529-B) leg ====================
  // Committed WAV fixtures through REAL filesystem paths -> the demand-linked
  // upstream decoder -> (#722 conversion where the spec differs) -> the one
  // device stream -> the captured kernel output ring, byte-exact.
  const pidW = await kernel.boot({ path: '/bin/app2', argv: ['app2', 'loadwav'], envp: [], cwd: '/' });
  await waitOut('WAVS READY');
  {
    const m1 = /WAV1 (\d+)\n/.exec(out);
    const m2 = /WAV2 (\d+) ([0-9a-f]{8})\n/.exec(out);
    check('loadwav: both fixtures decoded in-OS', !!(m1 && m2), JSON.stringify(out.slice(-200)));
    const len1 = m1 ? Number(m1[1]) : 0;
    const len2 = m2 ? Number(m2[1]) : 0;
    // leg 1 expectation: the committed fixture's own data chunk (PCM float is
    // pass-through: RIFF(12) + fmt(8+16) + data hdr(8) = offset 44), through
    // the mixer's [-1,1] clamp. Byte-exact, from the file the repo ships.
    const fixFloats = new Float32Array(len1 / 4);
    for (let i = 0; i < fixFloats.length; i++) fixFloats[i] = Math.fround(fixF32.readFloatLE(44 + i * 4));
    check('loadwav: fixture decode length matches the committed data chunk',
          len1 === fixF32.length - 44, `${len1} vs ${fixF32.length - 44}`);

    const wantFrames = (len1 + len2) / 8;
    const cap = new Float32Array(wantFrames * 2);
    let got = 0, idle = 0;
    while (got < wantFrames && idle < 800) {
      kernel.audioPump(512);
      const n = drainOut(cap, got);
      if (n === 0) { idle++; await sleep(5); continue; }
      idle = 0;
      got += n;
    }
    check('loadwav: captured the full pushed program', got === wantFrames, got);

    let exact = true, firstBad = -1;
    for (let i = 0; i < len1 / 4; i++) {
      const want = Math.max(-1, Math.min(1, fixFloats[i]));
      if (!Object.is(Math.fround(want), cap[i])) { exact = false; firstBad = i; break; }
    }
    check('loadwav: F32 fixture bytes reached the ring byte-exact', exact, 'first bad sample ' + firstBad);

    // leg 2 expectation: crc32 of the ring bytes after leg 1 == the crc the
    // app printed of EXACTLY what #722's converter handed it.
    const zlib = require('zlib');
    const leg2 = Buffer.alloc(len2);
    for (let i = 0; i < len2 / 4; i++) leg2.writeFloatLE(cap[len1 / 4 + i], i * 4);
    const gotCrc = (zlib.crc32(leg2) >>> 0).toString(16).padStart(8, '0');
    check('loadwav: converted IMA program reached the ring byte-exact (crc)',
          m2 && gotCrc === m2[2], `ring crc ${gotCrc} vs app ${m2 && m2[2]}`);
  }
  kernel.kill(pidW, 9, null);
  await reapAll();
  check('loadwav: sources reclaimed', kernel.audioList().length === 0);

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\naudio e2e: PASS' : `\naudio e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
