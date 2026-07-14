#!/usr/bin/env node
// On-demand compositor wake protocol, end-to-end (todos/0169, IDLE-POWER
// piece B): a REAL C SDL program compiled by compiler.js runs as a
// worker_thread under the kernel while the TEST plays the compositor
// (compSetParked / compKeepAlive / wmOnDamage). Proves the host.js half of
// the protocol against real presents:
//   - a present while UNPARKED rings nothing (no want-frame, no damage)
//   - a present while PARKED posts want-frame -> pcb.wantFrame pins +
//     the damage hook fires (the doorbell a parked compositor wakes on)
//   - the app's next WaitEvent entry posts frame-idle -> the pin drops
//     (compKeepAlive falls, the compositor may re-park)
//   - SIGKILL mid-pin clears it (a dead app can't pin the clock)
//
// NB the pin is deliberately transient on a healthy app: present ->
// want-frame, next WaitEvent entry -> frame-idle, often within the same
// event-loop turn. The 'b' key presents and then usleeps BEFORE returning
// to WaitEvent, holding the pin open long enough to observe — the same
// window a WM_TIMER app is in while it repaints.
//
// The vsync/ARMED half is unit-covered in test_vsync.js; the browser side
// (real rAF park) is tests/browser/os-compositor.mjs.
//
// Run: node tests/kernel/test_comp_park_e2e.js
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
#include <stdint.h>
#include <unistd.h>
int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("parkbox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }
    SDL_Surface *s = SDL_GetWindowSurface(w);
    uint32_t *px = (uint32_t *)s->pixels;
    int n = 0, i;
    for (i = 0; i < s->w * s->h; i++) px[i] = 0xFF2050C0u;
    SDL_UpdateWindowSurface(w);
    printf("PRESENTED %d\\n", n++);
    fflush(stdout);
    for (;;) {
        SDL_Event ev;
        if (!SDL_WaitEvent(&ev)) continue;
        if (ev.type != SDL_EVENT_KEY_DOWN) continue;
        if (ev.key.key == 113) break;             /* 'q' */
        for (i = 0; i < s->w * s->h; i++) px[i] = 0xFF20C050u + (uint32_t)n;
        SDL_UpdateWindowSurface(w);
        printf("PRESENTED %d\\n", n++);
        fflush(stdout);
        /* 'b': hold the post-present pin open before the next WaitEvent —
           the observable window (a WM_TIMER app's repaint looks like this). */
        if (ev.key.key == 98) usleep(900000);
    }
    SDL_Quit();
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-park-e2e-'));
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
// Poll a live predicate (worker postMessages land asynchronously).
const waitPred = (fn, label, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (fn()) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 8000)) return reject(new Error('timeout: ' + label));
    setTimeout(poll, 10);
  })();
});

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — comp-park e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('PRESENTED 0');
  const pcb = kernel.process(1);
  const page = new Int32Array(pcb.page);
  const sid = kernel.wmList().find((s) => s.title === 'parkbox').sid;

  let damage = 0;
  kernel.wmOnDamage(() => damage++);
  await sleep(300);   // the boot present's frame-idle drains
  check('boot present while UNPARKED leaves no pin', pcb.wantFrame === false);
  check('keepAlive false with the app parked in WaitEvent', kernel.compKeepAlive() === false);

  // ---- present while UNPARKED: silent (the armed composite's seq gate
  // sees the pixels; no doorbell traffic).
  kernel.wmInjectKey(sid, true, 4, 97, 0);        // 'a' -> one present
  await waitOut('PRESENTED 1');
  await sleep(300);
  check('present while UNPARKED posts no want-frame', pcb.wantFrame === false);
  check('...and fires no damage hook', damage === 0, 'damage=' + damage);

  // ---- present while PARKED: the doorbell. 'b' holds the pin open with a
  // post-present usleep, so the pinned state itself is observable.
  kernel.compSetParked(true);
  check('compSetParked stamps the pcb page', Atomics.load(page, K.KP_COMP_PARKED) === 1);
  kernel.wmInjectKey(sid, true, 5, 98, 0);        // input wakes the RING directly
  await waitOut('PRESENTED 2');
  await waitPred(() => pcb.wantFrame === true, 'want-frame pin', 4000);
  check('present while PARKED posts want-frame (pcb pinned)', true);
  check('the doorbell fired the damage hook (compositor wake)', damage > 0, 'damage=' + damage);
  check('keepAlive true while pinned', kernel.compKeepAlive() === true);

  // ---- the app re-enters WaitEvent: frame-idle drops the pin.
  kernel.compSetParked(false);                    // what scheduleFrame does
  await waitPred(() => pcb.wantFrame === false, 'frame-idle release', 4000);
  check('WaitEvent entry posts frame-idle (pin released)', true);
  check('keepAlive falls — the compositor may re-park', kernel.compKeepAlive() === false);

  // ---- SIGKILL mid-pin: exit must clear it.
  kernel.compSetParked(true);
  kernel.wmInjectKey(sid, true, 5, 98, 0);        // 'b': pin + usleep window
  await waitPred(() => pcb.wantFrame === true, 're-pin', 4000);
  kernel.kill(1, 9, null);                        // SIGKILL mid-usleep
  await waitPred(() => pcb.wantFrame === false, 'exit clears pin', 4000);
  check('SIGKILL mid-pin clears it (a dead app cannot pin the clock)', true);
  check('keepAlive false after the kill (zombie ignored)', kernel.compKeepAlive() === false);

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\ncomp-park e2e: PASS' : `\ncomp-park e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
