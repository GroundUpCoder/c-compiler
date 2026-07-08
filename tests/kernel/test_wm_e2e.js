#!/usr/bin/env node
// WM end-to-end (todos/WM.md): a REAL C SDL program compiled by compiler.js
// runs as a worker_thread under the kernel; its SDL window becomes a kernel
// surface (host.js createSurfaceSDL, shm transport). Proves the full loop:
//   SDL_CreateWindow -> SURFACE_CREATE handshake (SABs over the FIFO channel)
//   SDL_UpdateWindowSurface -> shm mailbox present -> kernel screenshot pixels
//   kernel.wmInjectKey/Pointer -> input ring -> frame-loop drain ->
//     SDL_PollEvent in C (scancode + LOCAL button coords)
//   kernel.wmResize -> SDL_EVENT_WINDOW_RESIZED in C -> surface re-derive ->
//     SURFACE_CONFIGURE ack with the first new-size frame (todos/0019)
//   kernel-chrome close box -> SDL_EVENT_QUIT -> app exit(5) -> halt
//
// Run: node tests/kernel/test_wm_e2e.js
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
#include <stdint.h>
#define W 96
#define H 64
static SDL_Window *win;
static SDL_Surface *surf;
static int state = 0, presented = 0;
static uint32_t rgb(int r, int g, int b) {
    return (uint32_t)r | ((uint32_t)g << 8) | ((uint32_t)b << 16) | 0xFF000000u;
}
static void frame_cb(void) {
    SDL_Event e;
    int newstate = state;
    while (SDL_PollEvent(&e)) {
        if (e.type == SDL_EVENT_KEY_DOWN && e.key.scancode == 4) newstate = 1;  /* 'A' */
        else if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN)
            printf("CLICK %d %d b%d\\n", (int)e.button.x, (int)e.button.y, (int)e.button.button);
        else if (e.type == SDL_EVENT_MOUSE_MOTION)
            printf("MOTION %d %d rel %d %d\\n", (int)e.motion.x, (int)e.motion.y,
                   (int)e.motion.xrel, (int)e.motion.yrel);
        else if (e.type == SDL_EVENT_WINDOW_RESIZED) {
            surf = SDL_GetWindowSurface(win);   /* re-derive (SDL3 contract) */
            printf("RESIZED %d %d\\n", (int)e.window.data1, (int)e.window.data2);
            fflush(stdout);
        }
        else if (e.type == SDL_EVENT_QUIT) { printf("QUIT\\n"); fflush(stdout); exit(5); }
    }
    uint32_t color = newstate ? rgb(230, 40, 40) : rgb(30, 60, 180);
    uint32_t *px = (uint32_t *)surf->pixels;
    for (int i = 0; i < surf->w * surf->h; i++) px[i] = color;
    SDL_UpdateWindowSurface(win);
    if (newstate != state) { state = newstate; printf("GOTKEY\\n"); fflush(stdout); }
    if (!presented) { presented = 1; printf("PRESENTED\\n"); fflush(stdout); }
}
int main(void) {
    SDL_Init(SDL_INIT_VIDEO);
    win = SDL_CreateWindow("e2e win", W, H, SDL_WINDOW_RESIZABLE);  /* resize leg needs it (todos/0021) */
    if (!win) { printf("NOWIN\\n"); return 3; }
    surf = SDL_GetWindowSurface(win);
    /* Relative mouse (todos/0018): request it, read the tracked state back. */
    SDL_SetWindowRelativeMouseMode(win, 1);
    printf("RELMODE %d\\n", SDL_GetWindowRelativeMouseMode(win) ? 1 : 0);
    __setAnimationFrameFunc(frame_cb);
    return 0;
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-e2e-'));
const cfile = path.join(tmp, 'app.c');
const wasm = path.join(tmp, 'app.wasm');
fs.writeFileSync(cfile, APP_C);
cp.execFileSync('node', [path.join(ROOT, 'compiler.js'), cfile, '-o', wasm], { stdio: 'pipe' });
const image = fs.readFileSync(wasm);

let out = '';
let haltResolve;
const haltPromise = new Promise((r) => { haltResolve = r; });
const kernel = new K.Kernel({
  createWorker: K.nodeCreateWorker({ hostPath: path.join(ROOT, 'host.js'), kernelPath: path.join(ROOT, 'kernel.js') }),
  loadImage: (p) => (p === '/bin/app' ? image : null),
  onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
  onHalt: (status) => haltResolve(status),
  log: () => {},
  screen: { w: 400, h: 300 },
});

const waitOut = (needle, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  (function poll() {
    if (out.includes(needle)) return resolve();
    if (Date.now() - t0 > (ms || 20000)) return reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '; out=' + JSON.stringify(out)));
    setTimeout(poll, 20);
  })();
});
const px = (shot, x, y) => Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));

const watchdog = setTimeout(() => {
  console.error('TIMEOUT — wm e2e did not finish in 90s\noutput so far:\n' + out);
  process.exit(1);
}, 90000);

(async () => {
  await kernel.boot({ path: '/bin/app', argv: ['app'], envp: [], cwd: '/' });
  await waitOut('PRESENTED');

  // Window registered with the right shape.
  const list = kernel.wmList();
  check('window: title/size/focus', list.length === 1 && list[0].title === 'e2e win' &&
    list[0].w === 96 && list[0].h === 64 && list[0].focused, JSON.stringify(list));
  const sid = list[0].sid;

  // Real pixels through the shm mailbox.
  let shot = kernel.wmScreenshot(sid);
  check('screenshot: initial blue frame', String(px(shot, 48, 32)) === '30,60,180,255', px(shot, 48, 32));
  const screen = kernel.wmScreenshotScreen();
  check('screen composite: window + navy chrome', String(px(screen, list[0].x + 1, list[0].y + 1)) === '30,60,180,255' &&
    String(px(screen, list[0].x + 1, list[0].y - 2)) === '0,0,128,255');

  // Synthetic key -> ring -> drain -> SDL_PollEvent -> C sees scancode 4.
  kernel.wmInjectKey(sid, true, 4, 97, 0);
  await waitOut('GOTKEY');
  shot = kernel.wmScreenshot(sid);
  check('key flipped the frame red', String(px(shot, 1, 1)) === '230,40,40,255', px(shot, 1, 1));

  // Synthetic click with window-LOCAL coords + button number.
  kernel.wmInjectPointer(sid, 'down', 10, 20, { button: 3 });
  await waitOut('CLICK 10 20 b3');
  check('click delivered with local coords + button', true);

  // Raw-bridge pointer path: click through SCREEN coords hits the client.
  const w = kernel.wmList()[0];
  kernel.wmPointer('down', w.x + 5, w.y + 6, { button: 1 });
  kernel.wmPointer('up', w.x + 5, w.y + 6, { button: 1 });
  await waitOut('CLICK 5 6 b1');
  check('screen-coordinate click routed through hit test', true);

  // Relative mouse (todos/0018): the C app requested it at startup
  // (SDL_SetWindowRelativeMouseMode before the frame loop).
  await waitOut('RELMODE 1');
  check('relativeMouse flag round-tripped to the kernel',
    kernel.wmList()[0].relativeMouse === true, JSON.stringify(kernel.wmList()));
  // Injected relative deltas: C sees xrel/yrel with the position FROZEN at
  // the last absolute point (the click above landed at 5,6).
  kernel.wmInjectPointer(sid, 'rel', 12, -7, { buttons: 1 });
  await waitOut('MOTION 5 6 rel 12 -7');
  check('rel deltas reach SDL_PollEvent with frozen x/y', true);
  // Locked-bridge path: pointer-lock reported active -> raw moves become
  // rel records to the focused surface, no hit test.
  kernel.wmPointerLockChanged(true);
  kernel.wmPointer('move', 0, 0, { dx: 3, dy: 4, buttons: 0 });
  await waitOut('MOTION 5 6 rel 3 4');
  check('locked bridge motion arrives as relative', true);
  kernel.wmPointerLockChanged(false);

  // Title drag moves the window (kernel-chrome policy).
  kernel.wmPointer('down', w.x + 30, w.y - 10, {});
  kernel.wmPointer('move', w.x + 80, w.y + 15, {});
  kernel.wmPointer('up', w.x + 80, w.y + 15, {});
  const moved = kernel.wmList()[0];
  check('title drag moved the window', moved.x === w.x + 50 && moved.y === w.y + 25,
    JSON.stringify([w.x, w.y, moved.x, moved.y]));

  // Client resize (todos/0019): configure event -> C re-derives its surface
  // -> host acks with the first new-size frame -> kernel geometry + pixels.
  kernel.wmResize(sid, 140, 90);
  await waitOut('RESIZED 140 90');
  {
    const t0 = Date.now();
    while (kernel.wmList()[0].w !== 140 && Date.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const rsz = kernel.wmList()[0];
  check('geometry follows the SURFACE_CONFIGURE ack',
    rsz.w === 140 && rsz.h === 90 && rsz.configurePending === false, JSON.stringify(rsz));
  shot = kernel.wmScreenshot(sid);
  check('pixels re-render at the new size (still red)',
    shot.w === 140 && shot.h === 90 && String(px(shot, 139, 89)) === '230,40,40,255',
    JSON.stringify([shot.w, shot.h, px(shot, 139, 89)]));

  // Close box -> SDL_EVENT_QUIT -> app exits 5 -> system halts.
  kernel.wmPointer('down', rsz.x + rsz.w - K.WM_CLOSE_PAD - 2,
    rsz.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + 2, {});
  await waitOut('QUIT');
  const status = await haltPromise;
  clearTimeout(watchdog);
  check('app exited 5 via QUIT', ((status >> 8) & 0xff) === 5, String(status));
  check('surfaces reclaimed at exit', kernel.wmList().length === 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nwm e2e: PASS' : `\nwm e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); console.error('out=', out); process.exit(1); });
