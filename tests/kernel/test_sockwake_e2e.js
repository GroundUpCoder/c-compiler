#!/usr/bin/env node
// Kernel-socket→input-ring wake end-to-end (todos/0168 commit 1, IDLE-POWER
// piece W's kernel prerequisite): a WMP subscriber parked on its input ring
// via __sdl_pump_wait (the seam wm.c's event loop and user32's GetMessage
// use) must wake PROMPTLY when the kernel-held peer sends it socket data —
// pumpWait parks on IR_WPOS only, and WMP events arrive on the AF_UNIX
// socket, so without the kick in _kernelPeer.send a subscriber sleeps its
// whole park chunk past every event (taskbar/snap-preview lag).
//
// The app subscribes to /run/wm.sock, drains the snapshot DRY, then parks
// in a single __sdl_pump_wait(4000). The test fires kernel.wmSetScreen to a
// LARGER screen — the emit reaches the subscriber only via the socket (no
// clamp fires, so nothing is pushed onto the app's input ring; a ring push
// would wake the park by itself and mask the thing under test). The wake
// must land in well under the 4000ms park, and the socket must then hold
// the EV_SCREEN frame.
//
// Run: node tests/kernel/test_sockwake_e2e.js
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
#include <sys/select.h>
#include "wm_proto.h"

/* The blocking input park itself (host.js pumpWait) — the seam under test,
   called directly so the veneer's WaitEventTimeout re-park loop can't hide
   an early spurious return. Returns 1 if a ring exists. */
__import int __sdl_pump_wait(int timeoutMs);

/* Drain everything readable off the socket (frames are whole: the kernel
   peer buffers them synchronously). Returns the count drained. */
static int drain_dry(int fd) {
    int n = 0;
    for (;;) {
        fd_set rf;
        struct timeval tv = { 0, 0 };
        FD_ZERO(&rf);
        FD_SET(fd, &rf);
        if (select(fd + 1, &rf, NULL, NULL, &tv) <= 0) return n;
        wmp_hdr h;
        if (wmp_next(fd, &h) != 0) { printf("SOCKGONE\\n"); return -1; }
        if (wmp_skip(fd, h.plen) != 0) { printf("SOCKGONE\\n"); return -1; }
        n++;
    }
}

int main(void) {
    if (!SDL_Init(SDL_INIT_VIDEO)) { printf("NOINIT\\n"); return 3; }
    SDL_Window *w = SDL_CreateWindow("wakebox", 64, 48, 0);
    if (!w) { printf("NOWIN\\n"); return 3; }

    int sock = wmp_connect();
    if (sock < 0) { printf("NOSOCK\\n"); return 3; }
    if (wmp_send(sock, WMP_SUBSCRIBE, NULL, 0) != 0) { printf("NOSUB\\n"); return 3; }
    wmp_hdr h;
    if (wmp_next_reply(sock, &h) != 0 || h.type != WMP_R_OK ||
        wmp_skip(sock, h.plen) != 0) { printf("NOSUB\\n"); return 3; }

    /* Drain the subscribe snapshot (EV_CREATED per surface + EV_FOCUS) and
       any queued SDL events, so the park below starts from DRY queues on
       both channels — a leftover would return the park immediately. */
    drain_dry(sock);
    SDL_Event ev;
    while (SDL_PollEvent(&ev)) {}

    printf("PARKED\\n");
    fflush(stdout);
    Uint64 t0 = SDL_GetTicks();
    __sdl_pump_wait(4000);
    int dt = (int)(SDL_GetTicks() - t0);

    /* What woke us must be waiting on the socket: the EV_SCREEN frame. */
    int type = 0;
    fd_set rf;
    struct timeval tv = { 0, 0 };
    FD_ZERO(&rf);
    FD_SET(sock, &rf);
    if (select(sock + 1, &rf, NULL, NULL, &tv) > 0 && wmp_next(sock, &h) == 0) {
        type = (int)h.type;
        wmp_skip(sock, h.plen);
    }
    printf("WOKE dt=%d type=%d\\n", dt, type);
    fflush(stdout);
    SDL_Quit();
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sockwake-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-I' + path.join(ROOT, 'os'), '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
const store = new BLOCK_FS.MemoryByteStore(1 << 22);
const kfs = BLOCK_FS.createV4(store);
const kernel = new K.Kernel({
  fs: kfs,
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: () => {},
  log: () => {},
});
kernel.wmServe();

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve(Date.now() - t0);
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 10);
  })();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const field = (tag, key) => {
  const m = (out.split('\n').find((l) => l.startsWith(tag + ' ')) || '')
    .match(new RegExp(key + '=(-?\\d+)'));
  return m ? parseInt(m[1], 10) : NaN;
};

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — sockwake e2e did not finish in 60s\noutput so far:\n' + out);
  process.exit(1);
}, 60000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });

  await waitOut('PARKED');
  await sleep(300);                                // ensure the park is entered
  check('no phantom wake before the emit', !out.includes('WOKE '), out);
  kernel.wmSetScreen(1024, 700);                   // larger: EV_SCREEN only, no clamp
  const wakeMs = await waitOut('WOKE ', 6000);
  check('socket data woke the ring park promptly (<1500ms of a 4000ms park)',
    field('WOKE', 'dt') < 1500, field('WOKE', 'dt') + 'ms');
  check('wake observed fast wall-clock too', wakeMs < 1500, wakeMs + 'ms');
  check('the EV_SCREEN frame was on the socket (0x87)',
    field('WOKE', 'type') === 0x87, '0x' + field('WOKE', 'type').toString(16));

  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nsockwake e2e: PASS' : `\nsockwake e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
