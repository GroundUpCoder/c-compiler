// #551 browser acceptance: the compositor survives WebGPU device loss, and
// the gpu-transport producer clamp really clamps delay-loop games.
//
// The defect class (measured 2026-08-06, ticket #551): a classic SDL game
// loop — RenderPresent + SDL_Delay(1) — shipped one transferToImageBitmap
// per PRESENT, not per vsync tick: flushPresent's park-entry flush was
// unconditional, so the #484 clamp was void for exactly the loop shape real
// games use (ships == presents; 16.5k bitmaps in 103s of play). Chromium
// gives a worker that never returns to its event loop (every OS SDL frame
// loop: Atomics.wait parks) a ~16.7k lifetime budget of ImageBitmap ships;
// at exhaustion it destroys the KERNEL worker's WebGPU device — the whole
// desktop went black, permanently, while the game kept running. Probes:
// yielding producers survive 60k+ ships; blocked producers die at 16744±3
// regardless of rate, canvas rotation, or close discipline; a re-acquired
// device works and the wall is one-shot (25k+ ships past it, clean).
//
// What this proves against the LIVE compositor:
//   - clamp: a compiled-in-OS SDL_Delay(1) present-spam app ships bitmaps
//     at the vsync cadence, not its present rate — kernel wmFrames vs
//     compositor frames in the SAME window (scale-free per #444's load
//     discipline; the pre-fix ratio measured ~2.7, the clamped ratio <=~1);
//   - recovery: compositor-kill destroys the live device (the REAL lost
//     path); the compositor re-acquires, rebuilds its caches, and the
//     desktop — including the still-running gpu app's window — repaints.
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

  // ---- Compile + launch the delay-loop present spammer (the keepup shape).
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
  check('dlspam (gpu 2D renderer) composites', true);

  // ---- Producer clamp (#551/#484): ships-per-compositor-frame in the same
  // window. A clamped producer ships at most one bitmap per tick, so the
  // ratio sits at <= ~1 (+ slack for the taskbar-clock tick alignment);
  // the pre-fix bug shipped per present — measured ratio ~2.7 at 160
  // presents/s. Scale-free (#444): both counters are frame-clock-driven and
  // sampled in the same window; the floors keep a stalled clock from
  // passing vacuously.
  await sleep(1500);                       // launch transient drains
  const c0 = await readStats();
  await sleep(3000);
  const c1 = await readStats();
  const dFrames = c1.frames - c0.frames;
  const dShips = c1.wmFrames - c0.wmFrames;
  const ratio = dFrames > 0 ? dShips / dFrames : Infinity;
  console.log('       [window] dlspam 3000ms: frames=' + dFrames + ' ships=' + dShips
    + ' ratio=' + ratio.toFixed(3));
  check('delay-loop ships are vsync-clamped (ships <= ~1 per composited frame)',
    dFrames > 20 && dShips > 10 && ratio <= 1.3,
    { dFrames, dShips, ratio: +ratio.toFixed(3) });

  // ---- Device-loss recovery (#551): kill the live device — the REAL lost
  // path — and require the compositor to come back with the desktop AND the
  // still-running gpu app's window content.
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
  // The recovered pass rebuilds every cache: wallpaper, taskbar chrome, and
  // the gpu window (re-imported from the app's next shipped bitmap).
  await waitPixel(SW - 20, SH - 60, TEAL, 15000, 'wallpaper after recovery');
  await waitPixel(400, BARY, FACE, 15000, 'taskbar after recovery');
  await waitPixel(WX + 160, WY + 100, [40, 200, 120], 15000, 'dlspam after recovery');
  check('desktop + gpu window repaint after recovery', true);
  const r2 = await readStats();
  await sleep(1500);
  const r3 = await readStats();
  check('frames keep flowing after recovery', r3.frames > r2.frames,
    { before: r2.frames, after: r3.frames });

  await vt1('pkill spam');
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os device-loss recovery (browser)');
