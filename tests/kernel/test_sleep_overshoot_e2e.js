#!/usr/bin/env node
// #492: timed-sleep overshoot stays compensated — a QUALITY ladder, not a
// contract test. The governing contracts (POSIX nanosleep/usleep, SDL_Delay)
// promise a MINIMUM duration, so overshoot is permitted-envelope behavior;
// what this pins is the measured quality target that made the textbook 60Hz
// SDL_Delay(16) game loop run 44fps: the OS timed-wait leeway (deterministic
// min(request/2, 10ms) on macOS) must stay compensated by the #492
// monotonic-deadline loops in all three sleep substrates:
//   - usleep/nanosleep under a kernel  -> KernelClient.park (doorbell wait)
//   - SDL_Delay pre-window             -> blockingSleepMs (private cell)
//   - SDL_Delay with a window          -> sdlDelay over pumpWait (input ring)
// Per verb, 40 x 16ms against CLOCK_MONOTONIC; asserts are split by
// instrument (todos/PRINCIPLES.md): the hard contract bound (never early,
// -0.5ms epsilon for clock quantization) and the statistical quality target
// (p50 overshoot < 4ms — uncompensated leeway measures 8ms, compensated
// 0.03ms, so both sides have >2x margin even under CPU load; p50, not p99,
// keeps the flake gate honest). A red here is a QUALITY red.
//
// Run: node tests/kernel/test_sleep_overshoot_e2e.js
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
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define ITERS 40
#define REQ_MS 16

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}
static int cmp(const void *a, const void *b) {
    double d = *(const double *)a - *(const double *)b;
    return d < 0 ? -1 : d > 0 ? 1 : 0;
}
/* one row: run the sleep ITERS times, print p50 + min overshoot in us */
static void row(const char *tag, void (*sleep16)(void)) {
    double xs[ITERS];
    for (int i = 0; i < ITERS; i++) {
        double t0 = now_ms();
        sleep16();
        xs[i] = now_ms() - t0 - REQ_MS;
    }
    qsort(xs, ITERS, sizeof *xs, cmp);
    printf("%s p50u=%d minu=%d maxu=%d\\n", tag,
           (int)(xs[ITERS / 2] * 1000), (int)(xs[0] * 1000),
           (int)(xs[ITERS - 1] * 1000));
    fflush(stdout);
}
static void do_usleep(void)    { usleep(REQ_MS * 1000); }
static void do_nanosleep(void) {
    struct timespec ts = { 0, REQ_MS * 1000000L };
    nanosleep(&ts, 0);
}
static void do_delay(void)     { SDL_Delay(REQ_MS); }

int main(void) {
    row("USLEEP", do_usleep);        /* kernel park path */
    row("NANOSLEEP", do_nanosleep);  /* kernel park path */
    row("DELAY0", do_delay);         /* pre-window: blockingSleepMs path */

    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("sleepbox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }
    /* drain the create-steal FOCUS_GAINED (todos/0256) so the ring is quiet */
    SDL_Event ev;
    SDL_WaitEventTimeout(&ev, 2000);
    row("DELAYW", do_delay);         /* windowed: sdlDelay over pumpWait */

    SDL_Quit();
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-overshoot-e2e-'));
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
    if (Date.now() - t0 > (ms || 30000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const field = (tag, key) => {
  const line = out.split('\n').find((l) => l.startsWith(tag + ' ')) || '';
  const m = line.match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — sleep-overshoot e2e did not finish in 120s\noutput so far:\n' + out);
  process.exit(1);
}, 120000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('DONE');

  for (const tag of ['USLEEP', 'NANOSLEEP', 'DELAY0', 'DELAYW']) {
    const p50 = field(tag, 'p50u'), min = field(tag, 'minu');
    // contract instrument: a sleep never returns early (epsilon: the guest
    // CLOCK_MONOTONIC and the host deadline are both performance.now-backed,
    // but ms-quantized printing can shave sub-ms)
    check(tag + ': never returned early (min >= -0.5ms)', min >= -500, 'minu=' + min);
    // quality instrument: leeway stays compensated (uncompensated = ~8000us)
    check(tag + ': p50 overshoot < 4ms (leeway compensated)',
      Number.isFinite(p50) && p50 < 4000, 'p50u=' + p50);
  }

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsleep-overshoot e2e: PASS' : `\nsleep-overshoot e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
