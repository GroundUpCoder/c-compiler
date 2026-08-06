// #551 browser acceptance: the compositor survives WebGPU device loss, the
// SDL renderer's OS transport ships ZERO GPU bitmaps, and the remaining gpu
// transport (webgpu.h apps) is genuinely vsync-clamped.
//
// The defect class (measured 2026-08-06, ticket #551): a classic SDL game
// loop — RenderPresent + SDL_Delay(1) — shipped one transferToImageBitmap
// per PRESENT (the #484 clamp was void: flushPresent's park-entry flush was
// unconditional; ships == presents, 16.5k bitmaps in 103s of play).
// Chromium gives a worker that never returns to its event loop (every OS
// SDL frame loop parks in Atomics.wait) a ~16.7k lifetime budget of
// ImageBitmap ships at ANY rate; at exhaustion it destroys the KERNEL
// worker's WebGPU device — desktop black, permanently, and the producer's
// canvas ships dead frames ever after. Probes: yielding producers survive
// 60k+; blocked producers die at 16744±3 regardless of rate, close
// discipline, or canvas rotation; there is no sync GPU-pixel export from a
// blocked worker. Fixes under test here:
//   - OS SDL_Render* apps rasterize in software into the shm SAB (zero
//     bitmaps — the wall is unreachable for the gamedev-epic app class);
//   - flushPresent's 'park' mode: webgpu.h apps' ships stay at the vsync
//     cadence even through delay-loop parks;
//   - the compositor RECOVERS from device loss (re-acquire + rebuild) —
//     driven here through the REAL lost path (device.destroy()).
//
// Usage: node os-devloss.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3239;

const SPAM_C = `#include <SDL3/SDL.h>
int main(void){SDL_Init(SDL_INIT_VIDEO);
SDL_Window*w=SDL_CreateWindow("dlspam",320,200,0);
SDL_Renderer*r=SDL_CreateRenderer(w,NULL);
for(;;){SDL_Event e;while(SDL_PollEvent(&e))if(e.type==SDL_EVENT_QUIT)return 0;
SDL_SetRenderDrawColor(r,40,200,120,255);SDL_RenderClear(r);
SDL_RenderPresent(r);SDL_Delay(1);}}
`;

const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitPixel, waitScreen, waitOut } = s;

const readStats = () => page.evaluate(() => window.__osCompositorStats());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function vt1(cmd) {
  await setVt(1);
  await page.keyboard.type(cmd + '\r');
  await setVt(2);
}

try {
  await setVt(2);
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const TEAL = [0, 128, 128], FACE = [192, 192, 192];
  const BARY = SH - 14;
  await waitPixel(SW - 20, SH - 60, TEAL, 60000);
  await waitPixel(400, BARY, FACE, 60000);
  check('desktop composites', true);

  // ---- Compile + launch the delay-loop SDL_Renderer app (the keepup shape).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate((src) => navigator.clipboard.writeText(src), SPAM_C);
  await setVt(1);
  await page.keyboard.type('pbpaste > /root/spam.c && cc /root/spam.c -o /root/spam && echo CC-O""K\r');
  await waitOut('CC-OK', 180000);
  await page.keyboard.type('/root/spam & wmctl wait win dlspam && wmctl list && echo SPAM-U""P\r');
  await waitOut('SPAM-UP', 30000);
  await setVt(2);
  const osOut = await page.evaluate(() => window.__osOut);
  const gm = [...osOut.matchAll(/(\d+)x(\d+)\+(\d+)\+(\d+)[^\n]*dlspam/g)].pop();
  check('dlspam window listed with geometry', !!gm, osOut.slice(-400));
  const WX = gm ? +gm[3] : 100, WY = gm ? +gm[4] : 100;
  await waitPixel(WX + 160, WY + 100, [40, 200, 120], 15000, 'dlspam clear color');
  check('dlspam (SDL_Renderer, software/shm tier) composites', true);

  // ---- #551 soundness invariant: an SDL_Renderer app ships ZERO GPU
  // bitmaps — its presents flip the shm SAB (WMSH_SEQ), never wm-frame.
  // Pre-#551 this app shipped one ImageBitmap per present (~160/s).
  const c0 = await readStats();
  await sleep(3000);
  const c1 = await readStats();
  const dShips = c1.wmFrames - c0.wmFrames;
  console.log('       [window] dlspam 3000ms: gpu ships=' + dShips
    + ' (frames=' + (c1.frames - c0.frames) + ')');
  check('SDL_Renderer app ships zero GPU bitmaps (shm transport)', dShips === 0,
    { dShips });

  // ---- The surviving gpu transport (webgpu.h): gpubox ships bitmaps, and
  // they must track the vsync cadence, not the app's present rate —
  // ships-per-compositor-frame in the SAME window is scale-free (#444).
  // Move gpubox off the cascade slot — its 640x480 would cover dlspam's
  // probe point at (WX+160, WY+100).
  await vt1('gpubox & wmctl wait win gpubox && GSID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//") && wmctl move $GSID 440 330 && echo GPU-U""P');
  await setVt(1); await waitOut('GPU-UP', 30000); await setVt(2);
  await sleep(1500);                       // launch transient drains
  const g0 = await readStats();
  await sleep(3000);
  const g1 = await readStats();
  const gFrames = g1.frames - g0.frames;
  const gShips = g1.wmFrames - g0.wmFrames;
  const ratio = gFrames > 0 ? gShips / gFrames : Infinity;
  console.log('       [window] gpubox 3000ms: frames=' + gFrames + ' ships=' + gShips
    + ' ratio=' + ratio.toFixed(3));
  check('webgpu.h ships are vsync-clamped (ships <= ~1 per composited frame)',
    gFrames > 20 && gShips > 10 && ratio <= 1.3,
    { gFrames, gShips, ratio: +ratio.toFixed(3) });

  // ---- Device-loss recovery (#551): destroy the live device — the REAL
  // lost path — and require the compositor to come back with the desktop,
  // the shm window's content, and the gpu transport still flowing.
  const r0 = await readStats();
  check('no device loss before the kill', r0.deviceLosses === 0 && r0.recoveries === 0, r0);
  await page.evaluate(() => kernel.postMessage({ type: 'compositor-kill' }));
  let rec = null;
  for (let t0 = Date.now(); Date.now() - t0 < 15000; ) {
    rec = await readStats();
    if (rec && rec.recoveries >= 1) break;
    await sleep(250);
  }
  check('compositor recovers from device loss (deviceLosses=1, recoveries=1)',
    rec && rec.deviceLosses === 1 && rec.recoveries === 1, rec);
  // The recovered pass rebuilds every cache: wallpaper + taskbar chrome
  // (label textures re-rasterize), the shm window re-uploads from its SAB.
  await waitPixel(SW - 20, SH - 60, TEAL, 15000, 'wallpaper after recovery');
  // NB not x=400: with two windows open their taskbar BUTTONS cover that
  // band (a button face reads lighter than the bar face). SW-100 is the
  // empty run left of the clock.
  await waitPixel(SW - 100, BARY, FACE, 15000, 'taskbar after recovery');
  await waitPixel(WX + 160, WY + 100, [40, 200, 120], 15000, 'dlspam after recovery');
  check('desktop + shm window repaint after recovery', true);
  const r2 = await readStats();
  await sleep(2000);
  const r3 = await readStats();
  check('frames keep flowing after recovery', r3.frames > r2.frames,
    { before: r2.frames, after: r3.frames });
  check('gpu transport (gpubox ships) keeps flowing after recovery',
    r3.wmFrames > r2.wmFrames, { before: r2.wmFrames, after: r3.wmFrames });

  await vt1('pkill spam; pkill gpubox');
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os device-loss recovery (browser)');
