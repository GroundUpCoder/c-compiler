#!/usr/bin/env node
// SDL_WaitEvent / SDL_WaitEventTimeout end-to-end (todos/0161, IDLE-POWER
// Stage 2): a REAL C SDL program compiled by compiler.js runs as a
// worker_thread under the kernel and parks on the OS input ring via the
// __sdl_pump_wait seam (host.js pumpWait — the same futex user32's blocking
// GetMessage uses). Proves the wait contract end-to-end:
//   - no window yet -> no ring: the nanosleep fallback honours the timeout
//     instead of hot-spinning
//   - WaitEventTimeout with no input parks the FULL timeout, returns false
//   - an infinite SDL_WaitEvent crosses 1s park chunks and wakes promptly
//     on injected input (wmInjectKey -> ring push -> Atomics.notify)
//   - a cooperative signal posted to a PARKED waiter runs its C handler at
//     the next chunk boundary (env-import return = signal safe point) and
//     the wait keeps waiting — the chunking-for-signals design holds
//   - SDL_WaitEvent(NULL) peeks: the waking event stays queued for
//     SDL_PollEvent
//
// Run: node tests/kernel/test_waitevent_e2e.js
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

const APP_C = `
#include <SDL.h>
#include <stdio.h>
#include <signal.h>

static volatile int usr1 = 0;
static void on_usr1(int sig) { (void)sig; usr1 = 1; printf("USR1\\n"); fflush(stdout); }

int main(void) {
    SDL_Event ev;
    Uint64 t0;
    int got;

    /* Leg 0: pre-window there is no input ring — the veneer's nanosleep
       fallback must still sleep out the timeout (no hot spin). */
    t0 = SDL_GetTicks();
    got = SDL_WaitEventTimeout(&ev, 150);
    printf("L0 got=%d slept=%d\\n", got, (int)(SDL_GetTicks() - t0) >= 100 ? 1 : 0);
    fflush(stdout);

    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("waitbox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }
    signal(SIGUSR1, on_usr1);

    /* Leg 1: real ring, no input — park the full timeout, return false.
       Zero-timeout first: pure poll, must return immediately. */
    got = SDL_WaitEventTimeout(&ev, 0);
    printf("READY poll0=%d\\n", got);
    fflush(stdout);
    t0 = SDL_GetTicks();
    got = SDL_WaitEventTimeout(&ev, 300);
    printf("L1 got=%d dt=%d\\n", got, (int)(SDL_GetTicks() - t0));
    fflush(stdout);

    /* Leg 2: infinite park across >2 one-second chunks. The test posts
       SIGUSR1 mid-park (handler must run while we keep waiting), then
       injects a key (must wake us). */
    printf("PARK2\\n");
    fflush(stdout);
    t0 = SDL_GetTicks();
    got = SDL_WaitEvent(&ev);
    printf("L2 got=%d iskey=%d sym=%d usr1=%d dt=%d\\n", got,
           ev.type == SDL_EVENT_KEY_DOWN, (int)ev.key.key, usr1,
           (int)(SDL_GetTicks() - t0));
    fflush(stdout);

    /* Leg 3: NULL event peeks — the waking event stays queued and the
       next SDL_PollEvent dequeues exactly it. */
    printf("PARK3\\n");
    fflush(stdout);
    got = SDL_WaitEvent(NULL);
    int polled = SDL_PollEvent(&ev);
    printf("L3 got=%d polled=%d iskey=%d sym=%d\\n", got, polled,
           ev.type == SDL_EVENT_KEY_DOWN, (int)ev.key.key);
    fflush(stdout);

    SDL_Quit();
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waitevent-e2e-'));
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
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (tag) => {
  const m = out.split('\n').find((l) => l.startsWith(tag + ' '));
  return m || '';
};
const field = (tag, key) => {
  const m = line(tag).match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — waitevent e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  // Leg 0: no-ring fallback honoured the timeout.
  await waitOut('L0 ');
  check('L0: no-ring WaitEventTimeout returns false', field('L0', 'got') === 0, line('L0'));
  check('L0: no-ring fallback really slept the timeout', field('L0', 'slept') === 1, line('L0'));

  // Leg 1: zero-timeout poll + full-timeout park.
  await waitOut('L1 ');
  check('poll0: zero timeout returns immediately, false', /poll0=0/.test(out), line('READY'));
  check('L1: timeout park returns false', field('L1', 'got') === 0, line('L1'));
  check('L1: parked the full timeout (>=250ms)', field('L1', 'dt') >= 250, line('L1'));

  // Leg 2: park across chunk boundaries; signal mid-park; key wakes.
  await waitOut('PARK2');
  const sid = kernel.wmList().find((s) => s.title === 'waitbox').sid;
  await sleep(400);
  kernel.kill(1, 10, null);                       // SIGUSR1 to the parked waiter
  // The handler runs at the NEXT chunk boundary (<=1s park chunks + slack).
  await waitOut('USR1', 4000);
  check('signal handler ran while parked (chunk = safe point)', !out.includes('L2 '), line('L2'));
  await sleep(1600);                              // stay parked past another chunk
  check('still parked after the handler + 2s (no phantom wake)', !out.includes('L2 '), out);
  kernel.wmInjectKey(sid, true, 4, 97, 0);        // 'a' down
  const wakeMs = await waitOut('L2 ', 4000);
  check('L2: injected key woke the infinite wait', field('L2', 'got') === 1, line('L2'));
  check('L2: woke promptly on input (<500ms), not on a chunk tick', wakeMs < 500, wakeMs + 'ms');
  check('L2: event is the injected KEY_DOWN a', field('L2', 'iskey') === 1 && field('L2', 'sym') === 97, line('L2'));
  check('L2: handler observed before the wake (usr1=1)', field('L2', 'usr1') === 1, line('L2'));
  check('L2: waited across chunks (dt>=1800ms)', field('L2', 'dt') >= 1800, line('L2'));

  // Leg 3: NULL peek leaves the event queued.
  await waitOut('PARK3');
  await sleep(300);
  kernel.wmInjectKey(sid, true, 5, 98, 0);        // 'b' down
  await waitOut('L3 ', 4000);
  check('L3: NULL WaitEvent returned true on the queued event', field('L3', 'got') === 1, line('L3'));
  check('L3: event stayed queued for PollEvent (peek semantics)', field('L3', 'polled') === 1 && field('L3', 'iskey') === 1 && field('L3', 'sym') === 98, line('L3'));

  await waitOut('DONE');
  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nwaitevent e2e: PASS' : `\nwaitevent e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
