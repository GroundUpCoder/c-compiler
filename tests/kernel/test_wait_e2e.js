#!/usr/bin/env node
// Unified wait end-to-end (todos/0178): a REAL C program compiled by
// compiler.js runs as a worker_thread under the kernel and parks in the
// kernel FS_WAIT RPC via the __wait host import — ONE deferred park over
// {fds} ⊕ the input ring ⊕ a timeout, interruptible by signals. Proves:
//   - an fd wake (tty line typed into a parked WAIT) completes promptly
//   - readiness at RPC ENTRY: data already cooked when __wait is called
//     returns immediately — check-and-park is atomic kernel-side
//   - a pure timeout park sleeps the full timeout and reports why=0
//   - a ring wake (injected key) completes an INFINITE park promptly and
//     the drained event is in the SDL queue at the import's return
//   - a posted signal completes the park promptly as -1 (EINTR) with the
//     C handler already run — signal latency is no longer a chunk
//     boundary (the 25ms-GetMessage / 1s-wm.c era)
//   - re-parking after the EINTR works (clean timeout)
//
// Run: node tests/kernel/test_wait_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const APP_C = `
#include <SDL.h>
#include <stdio.h>
#include <signal.h>
#include <unistd.h>
#include <sys/select.h>

__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

static volatile int usr1 = 0;
static void on_usr1(int sig) { (void)sig; usr1 = 1; printf("USR1\\n"); fflush(stdout); }

static void discard_line(void) { char b[128]; read(0, b, sizeof b); }

int main(void) {
    int fd0 = 0;
    Uint64 t0;
    int why;
    SDL_Event ev;

    /* L1: park on the tty fd (no ring interest, no window yet); the test
       types a line after seeing READY1 — the fd wake completes the park. */
    printf("READY1\\n"); fflush(stdout);
    t0 = SDL_GetTicks();
    why = __wait(&fd0, 1, 0, 5000);
    printf("L1 why=%d fast=%d\\n", why, (int)(SDL_GetTicks() - t0) < 4000 ? 1 : 0);
    fflush(stdout);
    discard_line();

    /* L2: readiness at ENTRY. select() blocks until the test's line is
       cooked WITHOUT consuming it, so __wait is entered with the fd
       already readable — it must return at once. */
    printf("READY2\\n"); fflush(stdout);
    fd_set rf;
    struct timeval tv = { 3, 0 };
    FD_ZERO(&rf);
    FD_SET(0, &rf);
    select(1, &rf, NULL, NULL, &tv);
    t0 = SDL_GetTicks();
    why = __wait(&fd0, 1, 0, 3000);
    printf("L2 why=%d dt=%d\\n", why, (int)(SDL_GetTicks() - t0));
    fflush(stdout);
    discard_line();

    /* L3: nothing readable, no ring interest — sleep the full timeout. */
    t0 = SDL_GetTicks();
    why = __wait(&fd0, 1, 0, 300);
    printf("L3 why=%d dt=%d\\n", why, (int)(SDL_GetTicks() - t0));
    fflush(stdout);

    /* L4: ring wake. Infinite park (no fds); the test injects a key after
       a quiet interval — the wake must be the injection, and the event
       must already be in the SDL queue when __wait returns. */
    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("waitbox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }
    signal(SIGUSR1, on_usr1);
    /* todos/0256: creating the window takes focus and the owner focus pair
       rides the ring — consume the initial FOCUS_GAINED (and pin that it
       arrives) so the park legs below start from a drained queue. */
    why = __wait(NULL, 0, 1, 2000);
    int fgpoll = SDL_PollEvent(&ev);
    printf("FG why=%d isfg=%d\\n", why,
           fgpoll && ev.type == SDL_EVENT_WINDOW_FOCUS_GAINED);
    fflush(stdout);
    printf("PARK4\\n"); fflush(stdout);
    t0 = SDL_GetTicks();
    why = __wait(NULL, 0, 1, -1);
    int polled = SDL_PollEvent(&ev);
    printf("L4 why=%d polled=%d iskey=%d sym=%d dt=%d\\n", why, polled,
           ev.type == SDL_EVENT_KEY_DOWN, (int)ev.key.key,
           (int)(SDL_GetTicks() - t0));
    fflush(stdout);

    /* L5: a posted signal completes the park promptly as EINTR (-1), the
       handler having run at the import's return — well before the 10s
       timeout, and with no chunk boundary to wait out. */
    printf("PARK5\\n"); fflush(stdout);
    t0 = SDL_GetTicks();
    why = __wait(&fd0, 1, 1, 10000);
    printf("L5 why=%d usr1=%d dt=%d\\n", why, usr1, (int)(SDL_GetTicks() - t0));
    fflush(stdout);

    /* L6: re-park after the EINTR — clean timeout. */
    t0 = SDL_GetTicks();
    why = __wait(NULL, 0, 1, 300);
    printf("L6 why=%d dt=%d\\n", why, (int)(SDL_GetTicks() - t0));
    fflush(stdout);

    SDL_Quit();
    printf("DONE\\n");
    fflush(stdout);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

// Brokered boot: FS_WAIT is fd-flavored — it needs the kernel-owned fd
// layer (a no-fs kernel answers ENOSYS and __wait returns -2), which is
// how wm.c and user32 apps always run.
const store = new BLOCK_FS.MemoryByteStore(4 << 20);
const kfs = BLOCK_FS.createV4(store);

let out = '';
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});
const tty = kernel.createTty({ cols: 80, rows: 24, output: () => {} });

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
  console.error('TIMEOUT — wait e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  // L1: fd wake into a parked WAIT.
  await waitOut('READY1');
  await sleep(300);                               // let it really park
  tty.input('go\n');
  const l1Ms = await waitOut('L1 ', 6000);
  check('L1: fd wake reports why=1', field('L1', 'why') === 1, line('L1'));
  check('L1: woke on the typed line, not the timeout', field('L1', 'fast') === 1, line('L1'));
  check('L1: wake was prompt (<500ms after typing)', l1Ms < 500, l1Ms + 'ms');

  // L2: readiness at RPC entry (check-and-park atomicity). The app's
  // select() sees the line without consuming it, then enters __wait.
  await waitOut('READY2');
  tty.input('b\n');
  await waitOut('L2 ', 5000);
  check('L2: entry scan saw the cooked line (why=1)', field('L2', 'why') === 1, line('L2'));
  check('L2: returned immediately (<200ms), no park', field('L2', 'dt') < 200, line('L2'));

  // L3: pure timeout.
  await waitOut('L3 ', 5000);
  check('L3: timeout reports why=0', field('L3', 'why') === 0, line('L3'));
  check('L3: slept the full timeout (>=250ms)', field('L3', 'dt') >= 250, line('L3'));

  // L4: ring wake out of an infinite park.
  await waitOut('PARK4');
  check('create-steal FOCUS_GAINED arrived (todos/0256) and was consumed',
    field('FG', 'why') === 2 && field('FG', 'isfg') === 1, line('FG'));
  const sid = kernel.wmList().find((s) => s.title === 'waitbox').sid;
  await sleep(1200);                              // quiet interval: no phantom wake
  check('L4: still parked after 1.2s of nothing', !out.includes('L4 '), out);
  kernel.wmInjectKey(sid, true, 4, 97, 0);        // 'a' down
  const l4Ms = await waitOut('L4 ', 4000);
  check('L4: ring wake reports why=2', field('L4', 'why') === 2, line('L4'));
  check('L4: wake was prompt (<500ms after inject)', l4Ms < 500, l4Ms + 'ms');
  check('L4: event already in the SDL queue (KEY_DOWN a)',
    field('L4', 'polled') === 1 && field('L4', 'iskey') === 1 && field('L4', 'sym') === 97, line('L4'));
  check('L4: parked across the quiet interval (dt>=1100ms)', field('L4', 'dt') >= 1100, line('L4'));

  // L5: signal completes the park as EINTR, promptly.
  await waitOut('PARK5');
  await sleep(400);
  kernel.kill(1, 10, null);                       // SIGUSR1 to the parked waiter
  const l5Ms = await waitOut('L5 ', 4000);
  check('L5: signal completes the WAIT with -1 (EINTR)', field('L5', 'why') === -1, line('L5'));
  check('L5: handler ran before the return (usr1=1)', field('L5', 'usr1') === 1, line('L5'));
  check('L5: signal wake was prompt (<500ms), not a chunk tick', l5Ms < 500, l5Ms + 'ms');
  check('L5: nowhere near the 10s timeout (dt<2000ms)', field('L5', 'dt') < 2000, line('L5'));

  // L6: re-park after EINTR times out clean.
  await waitOut('L6 ', 5000);
  check('L6: post-EINTR re-park times out clean (why=0)', field('L6', 'why') === 0, line('L6'));
  check('L6: slept the full timeout (>=250ms)', field('L6', 'dt') >= 250, line('L6'));

  await waitOut('DONE');
  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nwait e2e: PASS' : `\nwait e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
