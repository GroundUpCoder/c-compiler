#!/usr/bin/env node
// SDL_Delay as a cooperative worker sleep, end-to-end (todos/0224): a REAL C
// SDL program built around the classic corpus loop —
//   while (running) { poll events; draw; SDL_Delay(16); }
// — compiled by compiler.js and run as a worker_thread under the kernel.
// Before 0224 SDL_Delay threw UNIFORMLY (the standalone main-thread-browser
// constraint applied to every flavor); now the OS worker flavor sleeps in
// pumpWait parks (host.js sdlDelay). Proves the whole contract:
//   - pre-window (no input ring yet) SDL_Delay falls back to the raw
//     blocking sleep and honours the duration (no spin, no throw)
//   - the classic loop renders and receives injected input, unmodified
//   - an event arriving MID-delay does not shorten the sleep (SDL
//     semantics: Delay sleeps its full duration) but is queued for the
//     next SDL_PollEvent — input flows while the app sleeps
//   - IDLE-POWER parking discipline: a present while the compositor is
//     PARKED rings the doorbell (want-frame), and the app's next
//     SDL_Delay entry releases the pin (frame-idle) — an app dawdling in
//     SDL_Delay does NOT pin the compositor awake (compKeepAlive false)
//   - the standalone-browser flavor (createBrowserSDL) still throws loud,
//     and the headless null flavor (createNullSDL) really sleeps
//
// Run: node tests/kernel/test_sdl_delay_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const H = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const APP_C = `
#include <SDL.h>
#include <stdio.h>
#include <stdint.h>

int main(void) {
    Uint64 t0;
    int i;

    /* L0: pre-window there is no input ring — the blocking-sleep fallback
       must still honour the duration (no spin, no throw). */
    t0 = SDL_GetTicks();
    SDL_Delay(200);
    printf("L0 slept=%d\\n", (int)(SDL_GetTicks() - t0) >= 150 ? 1 : 0);
    fflush(stdout);

    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("delaybox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }
    SDL_Surface *s = SDL_GetWindowSurface(w);
    uint32_t *px = (uint32_t *)s->pixels;

    /* L1: the classic corpus loop, verbatim shape — poll, draw, Delay.
       The test injects a key while it runs; PollEvent must see it. */
    int frames, keys = 0, lastkey = 0;
    printf("LOOP1\\n");
    fflush(stdout);
    t0 = SDL_GetTicks();
    for (frames = 0; frames < 20; frames++) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_EVENT_KEY_DOWN) { keys++; lastkey = (int)ev.key.key; }
        }
        for (i = 0; i < s->w * s->h; i++) px[i] = 0xFF102030u + (uint32_t)frames;
        SDL_UpdateWindowSurface(w);
        SDL_Delay(50);
    }
    printf("L1 dt=%d keys=%d lastkey=%d\\n",
           (int)(SDL_GetTicks() - t0), keys, lastkey);
    fflush(stdout);

    /* L2: full-duration semantics — a key injected mid-delay must NOT
       shorten the sleep, and must be queued for the next PollEvent. */
    printf("PARK2\\n");
    fflush(stdout);
    t0 = SDL_GetTicks();
    SDL_Delay(1500);
    {
        SDL_Event ev;
        int polled = SDL_PollEvent(&ev);
        printf("L2 dt=%d polled=%d iskey=%d sym=%d\\n",
               (int)(SDL_GetTicks() - t0), polled,
               ev.type == SDL_EVENT_KEY_DOWN, (int)ev.key.key);
        fflush(stdout);
    }

    /* L3: parking discipline — one present, then a long delay. The test
       (playing a PARKED compositor) sees the present's doorbell and then
       the delay entry's frame-idle release. */
    for (i = 0; i < s->w * s->h; i++) px[i] = 0xFFFF00FFu;
    SDL_UpdateWindowSurface(w);
    printf("PRESENT3\\n");
    fflush(stdout);
    SDL_Delay(3000);
    printf("L3 done\\n");
    fflush(stdout);

    SDL_Quit();
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdl-delay-e2e-'));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const waitPred = (fn, label, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 8000)) return reject(new Error('timeout: ' + label));
    setTimeout(poll, 10);
  })();
});
const line = (tag) => out.split('\n').find((l) => l.startsWith(tag + ' ')) || '';
const field = (tag, key) => {
  const m = line(tag).match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — sdl-delay e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  // ---- flavor-scoping legs (in-process, no worker) ----------------------
  // The standalone-browser flavor keeps the loud throw: that is the ONE
  // context where a blocking loop genuinely can't work (rAF callback model,
  // input/presents ride the message loop).
  let threw = null;
  try {
    H.createBrowserSDL({
      canvas: {},
      ctx: { readString: () => '', getMemory: () => null, getExports: () => null },
    }).c.__sdl_delay(16);
  } catch (e) { threw = e; }
  check('standalone-browser flavor: SDL_Delay still throws loudly',
    !!threw && /SDL_Delay/.test(String(threw && threw.message)), String(threw));

  // The headless null flavor really sleeps (same primitive as usleep).
  {
    const nsdl = H.createNullSDL().c;
    const t0 = Date.now();
    nsdl.__sdl_delay(150);
    const dt = Date.now() - t0;
    check('null flavor: SDL_Delay really blocks (~150ms)', dt >= 120, dt + 'ms');
  }

  // ---- the real thing: classic loop as an OS process --------------------
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  await waitOut('L0 ');
  check('L0: pre-window SDL_Delay slept the duration (no ring fallback)',
    field('L0', 'slept') === 1, line('L0'));

  // L1: inject a key while the poll/draw/Delay loop is running.
  await waitOut('LOOP1');
  await waitPred(() => kernel.wmList().some((s) => s.title === 'delaybox'), 'window up', 8000);
  const sid = kernel.wmList().find((s) => s.title === 'delaybox').sid;
  const pcb = kernel.process(1);
  await sleep(200);                               // mid-loop
  kernel.wmInjectKey(sid, true, 4, 97, 0);        // 'a' down
  await waitOut('L1 ');
  check('L1: classic loop ran 20 frames at ~50ms pace (dt>=900ms)',
    field('L1', 'dt') >= 900, line('L1'));
  check('L1: loop was not slowed to a crawl (dt<5000ms)',
    field('L1', 'dt') < 5000, line('L1'));
  check('L1: injected key reached SDL_PollEvent mid-loop',
    field('L1', 'keys') >= 1 && field('L1', 'lastkey') === 97, line('L1'));

  // L2: key lands MID-delay — the sleep must run full duration AND the
  // event must be queued for the next poll (input flows while sleeping).
  await waitOut('PARK2');
  kernel.compSetParked(true);                     // arm the L3 doorbell now,
                                                  // before the app's present
  let damage = 0;
  kernel.wmOnDamage(() => damage++);
  await sleep(300);                               // app is inside SDL_Delay(1500)
  kernel.wmInjectKey(sid, true, 5, 98, 0);        // 'b' down, mid-delay
  await waitOut('L2 ', 6000);
  check('L2: mid-delay event did not shorten the sleep (dt>=1400ms)',
    field('L2', 'dt') >= 1400, line('L2'));
  check('L2: ...and did not stretch it either (dt<2500ms)',
    field('L2', 'dt') < 2500, line('L2'));
  check('L2: mid-delay key was queued for the next PollEvent',
    field('L2', 'polled') === 1 && field('L2', 'iskey') === 1 && field('L2', 'sym') === 98,
    line('L2'));

  // L3: parking discipline. The present while PARKED must ring the doorbell
  // (want-frame -> damage hook), and the immediately-following SDL_Delay
  // entry must release the pin — an app sleeping in SDL_Delay lets the
  // compositor stay parked. The pin itself is transient (present and delay
  // entry are back-to-back), so assert its two observable effects instead
  // of racing to see wantFrame flicker true.
  const damageBase = damage;
  await waitOut('PRESENT3');
  await waitPred(() => damage > damageBase, 'present-while-parked doorbell', 4000);
  check('L3: present while PARKED rang the doorbell (damage hook)', true);
  await sleep(500);                               // app is inside SDL_Delay(3000)
  check('L3: SDL_Delay entry released the frame pin (wantFrame false mid-delay)',
    pcb.wantFrame === false);
  check('L3: compKeepAlive false — a delaying app does not pin the compositor',
    kernel.compKeepAlive() === false);

  await waitOut('L3 done', 8000);
  await waitOut('DONE');
  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsdl-delay e2e: PASS' : `\nsdl-delay e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
