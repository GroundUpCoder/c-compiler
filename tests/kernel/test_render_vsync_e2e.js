#!/usr/bin/env node
// #500: SDL_SetRenderVSync / SDL_GetRenderVSync — honest renderer vsync on the
// compositor tick (the ONE display clock, kernel.js vsyncTick). Instruments
// are TICKS, not milliseconds, and are disjoint from #492's (sleep
// percentiles). The GPU-tier twin is tests/browser/os-vsync.mjs.
//
// Leg A (deterministic, worker_threads, no wasm): KernelClient.vsyncWaitUntil
//   — the software present's blocking park — against a hand-driven tick word:
//   - parks ARMED with the PARKED-gated want-frame doorbell (the 0169 Dekker
//     pair vsyncWait implements; without the doorbell a paced app strands
//     against the on-demand parked compositor)
//   - no ticks = stays parked (the honest pause: nothing fires, nothing
//     bursts) and returns EXACTLY at the target seq, never early
//   - STOP releases the compositor: a SIGSTOPped vsync waiter re-parks
//     UNARMED in _stopWait (KP_VSYNC_ARMED drops to 0 — compKeepAlive counts
//     STOPPED pcbs' ARMED, so a stopped paced game must not pin the rAF
//     awake), and re-arms after CONT
//   - a deliverable pending signal interrupts the park (FS_WAIT's EINTR
//     shape): returns early so dispatch runs at the import-return safe point
//   - seq compare is signed-diff, wrap safe
//
// Leg B (real OS, boot.js --vsync=20 — the #424 timer clock): contract legs
//   through the real veneer + in-OS cc, then pacing honesty: a vsync=1
//   software renderer's BLOCKING present loop ships one frame per tick (30
//   frames at 20Hz >= 1100ms wall; unpaced software presents run ~ms), and
//   vsync=2 halves the rate at the same tick budget. Multi-window: an
//   unpaced sibling renderer does not break the paced one.
//
// Leg C (plain boot, no --vsync): no display clock — SDL_SetRenderVSync(1)
//   returns false with SDL_GetError set and the mode UNCHANGED; vsync=0
//   still accepted. The honest refusal, never a setTimeout stand-in.
//
// Leg D (warm reboots): the tick clock at 60/90/120/144 Hz — vsync=1 elapsed
//   tracks the tick period (lower bounds prove pacing; loose upper bounds
//   prove ticks flow — load stretches, never shrinks, so the load-bearing
//   bound is the lower one).
//
// Run: node tests/kernel/test_render_vsync_e2e.js
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const K = require(path.resolve(__dirname, '../../kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- Leg A: vsyncWaitUntil discipline (deterministic ticks) ------------- */

// The worker runs the REAL KernelClient.vsyncWaitUntil on a shared kernel
// page; want-frame posts are counted in ctl[0], the returned seq lands in
// ctl[1] (+1, so 0 stays "not returned"), via ctl[2] as a done flag.
const WORKER_SRC = `
const { workerData } = require('worker_threads');
const K = require(workerData.kernelPath);
const ctl = new Int32Array(workerData.ctl);
const c = new K.KernelClient(workerData.page, function (m) {
  if (m && m.type === 'want-frame') Atomics.add(ctl, 0, 1);
});
const got = c.vsyncWaitUntil(workerData.target);
Atomics.store(ctl, 1, got + 1);
Atomics.store(ctl, 2, 1);
Atomics.notify(ctl, 2);
`;

function spawnWaiter(page, target, ctl) {
  return new Worker(WORKER_SRC, {
    eval: true,
    workerData: { kernelPath: path.resolve(__dirname, '../../kernel.js'), page, target, ctl: ctl.buffer },
  });
}

async function armedIs(i32, want, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (Atomics.load(i32, K.KP_VSYNC_ARMED) === want) return true;
    await sleep(10);
  }
  return Atomics.load(i32, K.KP_VSYNC_ARMED) === want;
}

async function legA() {
  console.log('vsyncWaitUntil (deterministic ticks):');

  // -- park + doorbell + exact-target return ------------------------------
  {
    const page = new SharedArrayBuffer(K.KP_SIZE);
    const i32 = new Int32Array(page);
    Atomics.store(i32, K.KP_VSYNC_EN, 1);
    Atomics.store(i32, K.KP_COMP_PARKED, 1);       // compositor parked: the arm must ring
    const ctl = new Int32Array(new SharedArrayBuffer(12));
    const w = spawnWaiter(page, 3, ctl);
    check('waiter arms (KP_VSYNC_ARMED 1)', await armedIs(i32, 1, 3000));
    check('arm-while-parked rings the want-frame doorbell', Atomics.load(ctl, 0) >= 1,
      'posts=' + Atomics.load(ctl, 0));

    // no ticks for a beat = the honest pause: still parked, nothing returned
    await sleep(1200);
    // armedIs (not a one-shot read): the 1s chunk re-arm has a sub-µs
    // disarmed window a single sample could land in.
    check('no ticks -> stays parked (honest pause)', Atomics.load(ctl, 2) === 0 &&
      await armedIs(i32, 1, 500));

    // ticks 1..2: below target, must NOT return
    for (let t = 0; t < 2; t++) { Atomics.add(i32, K.KP_VSYNC_SEQ, 1); Atomics.notify(i32, K.KP_VSYNC_SEQ); }
    await sleep(150);
    check('2 of 3 ticks -> still parked (never early)', Atomics.load(ctl, 2) === 0);

    Atomics.add(i32, K.KP_VSYNC_SEQ, 1); Atomics.notify(i32, K.KP_VSYNC_SEQ);
    await new Promise((res) => { w.on('exit', res); });
    check('3rd tick releases at exactly seq 3', Atomics.load(ctl, 1) - 1 === 3,
      'got=' + (Atomics.load(ctl, 1) - 1));
    check('disarmed after return', Atomics.load(i32, K.KP_VSYNC_ARMED) === 0);
  }

  // -- STOP releases the compositor; CONT re-arms (the #500 SIGSTOP pin) --
  {
    const page = new SharedArrayBuffer(K.KP_SIZE);
    const i32 = new Int32Array(page);
    Atomics.store(i32, K.KP_VSYNC_EN, 1);
    const ctl = new Int32Array(new SharedArrayBuffer(12));
    const w = spawnWaiter(page, 5, ctl);
    check('waiter arms', await armedIs(i32, 1, 3000));

    Atomics.or(i32, K.KP_FLAGS, K.KF_STOP);
    Atomics.notify(i32, K.KP_VSYNC_SEQ);           // wake the chunk; the loop must see STOP
    check('STOP -> re-parks UNARMED (a stopped vsync app releases the compositor)',
      await armedIs(i32, 0, 3000));
    check('still parked under STOP (not returned)', Atomics.load(ctl, 2) === 0);

    Atomics.and(i32, K.KP_FLAGS, ~K.KF_STOP);
    Atomics.notify(i32, K.KP_DOORBELL);            // _stopWait parks on the doorbell
    check('CONT -> re-arms and resumes the vsync park', await armedIs(i32, 1, 3000));

    for (let t = 0; t < 5; t++) { Atomics.add(i32, K.KP_VSYNC_SEQ, 1); Atomics.notify(i32, K.KP_VSYNC_SEQ); }
    await new Promise((res) => { w.on('exit', res); });
    check('paces to target after CONT', Atomics.load(ctl, 1) - 1 === 5,
      'got=' + (Atomics.load(ctl, 1) - 1));
  }

  // -- deliverable pending signal interrupts the park (EINTR shape) -------
  {
    const page = new SharedArrayBuffer(K.KP_SIZE);
    const i32 = new Int32Array(page);
    Atomics.store(i32, K.KP_VSYNC_EN, 1);
    const ctl = new Int32Array(new SharedArrayBuffer(12));
    const w = spawnWaiter(page, 1000, ctl);
    check('waiter arms', await armedIs(i32, 1, 3000));
    Atomics.or(i32, K.KP_SIGPEND, 1 << (10 - 1));  // SIGUSR1 pending, unblocked
    Atomics.notify(i32, K.KP_VSYNC_SEQ);
    await new Promise((res) => { w.on('exit', res); });
    check('pending signal returns early (dispatch runs at the safe point)',
      Atomics.load(ctl, 2) === 1 && Atomics.load(ctl, 1) - 1 < 1000,
      'got=' + (Atomics.load(ctl, 1) - 1));
  }

  // -- wrap safety: signed-diff compare across the int32 boundary ---------
  {
    const page = new SharedArrayBuffer(K.KP_SIZE);
    const i32 = new Int32Array(page);
    Atomics.store(i32, K.KP_VSYNC_EN, 1);
    Atomics.store(i32, K.KP_VSYNC_SEQ, 0x7ffffffe);
    const ctl = new Int32Array(new SharedArrayBuffer(12));
    const w = spawnWaiter(page, (0x7ffffffe + 2) | 0, ctl);   // wraps negative
    check('waiter arms near INT32_MAX', await armedIs(i32, 1, 3000));
    for (let t = 0; t < 2; t++) { Atomics.add(i32, K.KP_VSYNC_SEQ, 1); Atomics.notify(i32, K.KP_VSYNC_SEQ); }
    await new Promise((res) => { w.on('exit', res); });
    check('seq wrap does not wedge the park',
      Atomics.load(ctl, 2) === 1 && (Atomics.load(ctl, 1) - 1) === ((0x7ffffffe + 2) | 0));
  }
}

/* ---- the in-OS C instrument -------------------------------------------- */

const APP_LINES = [
  "cat > /root/vs.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  '#include <string.h>',
  '#include <stdlib.h>',
  '#include <time.h>',
  'static long long now_ms(void) {',
  '    struct timespec ts;',
  '    clock_gettime(CLOCK_MONOTONIC, &ts);',
  '    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;',
  '}',
  'int main(int argc, char **argv) {',
  '    const char *mode = argc > 1 ? argv[1] : "contract";',
  '    SDL_Init(SDL_INIT_VIDEO);',
  '    SDL_Window *w = SDL_CreateWindow("vs", 64, 48, 0);',
  '    SDL_Renderer *r = SDL_CreateRenderer(w, "software");',
  '    if (!r) { printf("NOREND %s\\n", SDL_GetError()); return 2; }',
  '    int v = 99;',
  '    if (!strcmp(mode, "contract")) {',
  '        SDL_GetRenderVSync(r, &v); printf("DEFAULT=%d\\n", v);',
  '        printf("SET1=%d\\n", (int)SDL_SetRenderVSync(r, 1));',
  '        printf("SET1ERR=%d\\n", (int)(strlen(SDL_GetError()) > 0));',
  '        SDL_GetRenderVSync(r, &v); printf("GET1=%d\\n", v);',
  '        printf("ADAPT=%d\\n", (int)SDL_SetRenderVSync(r, SDL_RENDERER_VSYNC_ADAPTIVE));',
  '        printf("ADAPTERR=%d\\n", (int)(strlen(SDL_GetError()) > 0));',
  '        SDL_GetRenderVSync(r, &v); printf("GETA=%d\\n", v);',
  '        printf("SET0=%d\\n", (int)SDL_SetRenderVSync(r, SDL_RENDERER_VSYNC_DISABLED));',
  '        SDL_GetRenderVSync(r, &v); printf("GET0=%d\\n", v);',
  '        printf("SET3=%d\\n", (int)SDL_SetRenderVSync(r, 3));',
  '        SDL_GetRenderVSync(r, &v); printf("GET3=%d\\n", v);',
  '        fflush(stdout); SDL_Quit(); return 0;',
  '    }',
  '    if (!strcmp(mode, "paced")) {   /* paced N M: N ticks per present, M presents */',
  '        int n = atoi(argv[2]), m = atoi(argv[3]);',
  '        printf("SETP=%d\\n", (int)SDL_SetRenderVSync(r, n));',
  '        SDL_Event e;',
  '        long long t0 = now_ms();',
  '        for (int i = 0; i < m; i++) {',
  '            while (SDL_PollEvent(&e)) {}',
  '            SDL_SetRenderDrawColor(r, i & 255, 40, 80, 255);',
  '            SDL_RenderClear(r);',
  '            SDL_RenderPresent(r);',
  '        }',
  '        printf("ELAPSED %lld FRAMES %d\\n", now_ms() - t0, m);',
  '        fflush(stdout); SDL_Quit(); return 0;',
  '    }',
  '    if (!strcmp(mode, "multiwin")) {   /* paced r1 + unpaced sibling r2 */',
  '        SDL_Window *w2 = SDL_CreateWindow("vs2", 64, 48, 0);',
  '        SDL_Renderer *r2 = SDL_CreateRenderer(w2, "software");',
  '        if (!r2) { printf("NOREND2 %s\\n", SDL_GetError()); return 2; }',
  '        printf("SETP=%d\\n", (int)SDL_SetRenderVSync(r, 1));',
  '        SDL_GetRenderVSync(r2, &v); printf("SIB=%d\\n", v);   /* per-renderer state */',
  '        SDL_Event e;',
  '        long long t0 = now_ms();',
  '        for (int i = 0; i < 20; i++) {',
  '            while (SDL_PollEvent(&e)) {}',
  '            SDL_RenderClear(r2); SDL_RenderPresent(r2);   /* unpaced: must not stall */',
  '            SDL_RenderClear(r);  SDL_RenderPresent(r);    /* paced: 1/tick */',
  '        }',
  '        printf("ELAPSED %lld FRAMES 20\\n", now_ms() - t0);',
  '        fflush(stdout); SDL_Quit(); return 0;',
  '    }',
  '    printf("BADMODE\\n"); return 2;',
  '}',
  'EOF',
  'cd /root && cc vs.c -o vs',
];

function grabNum(out, re) { const m = re.exec(String(out)); return m ? Number(m[1]) : null; }
function has(out, s) { return String(out).includes(s); }

async function main() {
  await legA();

  /* ---- Leg B: real OS at --vsync=20 --------------------------------- */
  console.log('contract + pacing (boot --vsync=20):');
  const rB = driveBoot([
    ...APP_LINES,
    'echo ==contract',
    './vs contract',
    'echo ==paced1',
    './vs paced 1 30',
    'echo ==paced2',
    './vs paced 2 15',
    'echo ==multiwin',
    './vs multiwin',
    'echo ==done',
    'exit',
  ], { prefix: 'os-rvsync-', args: ['--vsync=20'], timeout: 600000 });
  check('session exits clean', rB.status === 0,
    `status=${rB.status} stderr=${String(rB.stderr || '').slice(-300)}`);

  const con = section(rB.stdout, 'contract');
  check('fresh renderer reports vsync 0 (the SDL3 default)', has(con, 'DEFAULT=0'), con);
  check('set 1 accepted over the tick clock', has(con, 'SET1=1'));
  check('get round-trips 1', has(con, 'GET1=1'));
  check('adaptive (-1) refused with SDL_GetError set', has(con, 'ADAPT=0') && has(con, 'ADAPTERR=1'));
  check('refused mode leaves the setting UNCHANGED', has(con, 'GETA=1'));
  check('set 0 accepted, round-trips', has(con, 'SET0=1') && has(con, 'GET0=0'));
  check('vsync=3 accepted, round-trips', has(con, 'SET3=1') && has(con, 'GET3=3'));

  // 30 presents at vsync=1 on a 20Hz clock: >= 29 tick intervals ~ 1450ms
  // nominal. Unpaced software presents of 30 tiny frames measure ~ms, so the
  // lower bound is the load-bearing red (load stretches, never shrinks).
  const p1 = section(rB.stdout, 'paced1');
  const e1 = grabNum(p1, /ELAPSED (\d+) FRAMES 30/);
  check('paced1: set accepted', has(p1, 'SETP=1'));
  check('vsync=1: 30 presents take >= 1100ms at 20Hz (1 frame per tick)',
    e1 !== null && e1 >= 1100, `elapsed=${e1}`);
  check('vsync=1: ticks flow (<= 8000ms)', e1 !== null && e1 <= 8000, `elapsed=${e1}`);

  // vsync=2, 15 presents: the SAME ~30-tick budget — proves the divisor.
  const p2 = section(rB.stdout, 'paced2');
  const e2 = grabNum(p2, /ELAPSED (\d+) FRAMES 15/);
  check('paced2: set accepted', has(p2, 'SETP=1'));
  check('vsync=2: 15 presents take >= 1100ms at 20Hz (1 frame per 2 ticks)',
    e2 !== null && e2 >= 1100, `elapsed=${e2}`);
  check('vsync=2: ticks flow (<= 8000ms)', e2 !== null && e2 <= 8000, `elapsed=${e2}`);

  // multi-window: sibling starts unpaced (per-renderer state) and the pair
  // completes at the paced renderer's cadence (20 frames ~ 1000ms nominal).
  const mw = section(rB.stdout, 'multiwin');
  const em = grabNum(mw, /ELAPSED (\d+) FRAMES 20/);
  check('multiwin: paced set accepted, sibling defaults 0', has(mw, 'SETP=1') && has(mw, 'SIB=0'));
  check('multiwin: unpaced sibling does not break pacing (>= 700ms)',
    em !== null && em >= 700, `elapsed=${em}`);

  /* ---- Leg C: plain boot = no display clock -------------------------- */
  console.log('no display clock (plain boot):');
  const rC = driveBoot([
    'echo ==contract',
    '/root/vs contract',
    'echo ==done',
    'exit',
  ], { image: rB.image, timeout: 600000 });
  check('session exits clean', rC.status === 0,
    `status=${rC.status} stderr=${String(rC.stderr || '').slice(-300)}`);
  const cc = section(rC.stdout, 'contract');
  check('fresh renderer still reports 0', has(cc, 'DEFAULT=0'));
  check('set 1 REFUSED without a display clock (false + SDL_GetError)',
    has(cc, 'SET1=0') && has(cc, 'SET1ERR=1'), cc);
  check('refused set leaves the mode at 0', has(cc, 'GET1=0'));
  check('set 0 still accepted', has(cc, 'SET0=1') && has(cc, 'GET0=0'));
  check('vsync=3 refused too', has(cc, 'SET3=0') && has(cc, 'GET3=0'));

  /* ---- Leg D: the tick clock at 60/90/120/144 Hz --------------------- */
  console.log('rate sweep (60/90/120/144 Hz, vsync=1):');
  for (const hz of [60, 90, 120, 144]) {
    const frames = 40;
    const nominal = (frames - 1) * 1000 / hz;
    const rD = driveBoot([
      'echo ==paced1',
      `/root/vs paced 1 ${frames}`,
      'echo ==done',
      'exit',
    ], { image: rB.image, args: [`--vsync=${hz}`], timeout: 600000 });
    check(`${hz}Hz session exits clean`, rD.status === 0,
      `status=${rD.status} stderr=${String(rD.stderr || '').slice(-300)}`);
    const eD = grabNum(section(rD.stdout, 'paced1'), new RegExp(`ELAPSED (\\d+) FRAMES ${frames}`));
    check(`${hz}Hz: ${frames} presents >= ${Math.round(nominal * 0.6)}ms (pacing tracks the clock)`,
      eD !== null && eD >= nominal * 0.6, `elapsed=${eD} nominal=${Math.round(nominal)}`);
    check(`${hz}Hz: ticks flow (<= ${Math.round(nominal * 12)}ms)`,
      eD !== null && eD <= nominal * 12, `elapsed=${eD}`);
  }

  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
