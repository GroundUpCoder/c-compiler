// #551 browser acceptance: the compositor survives WebGPU device loss, and
// the gpu transport (SDL_Renderer apps on the restored GPU tier + webgpu.h
// apps) is genuinely vsync-clamped on the sanctioned callback loop.
//
// The defect class (measured 2026-08-06, ticket #551): a classic SDL game
// loop — RenderPresent + SDL_Delay(1) — shipped one transferToImageBitmap
// per PRESENT (the #484 clamp was void: flushPresent's park-entry flush was
// unconditional; ships == presents, 16.5k bitmaps in 103s of play).
// Chromium gives a worker that never returns to its event loop a finite
// lifetime budget of ImageBitmap ships at ANY rate; at exhaustion it
// destroys the KERNEL worker's WebGPU device — desktop black, permanently.
// Probes: yielding producers survive 60k+ ships clean; blocked producers
// die at the wall regardless of rate, close discipline, or canvas
// rotation. Fixes under test here:
//   - blocking-loop GPU presents are REFUSED at the first present (the
//     refusal itself is tests/browser/os-loopguard.mjs's subject);
//   - the sanctioned callback loop (SDL_MAIN_USE_CALLBACKS pollball,
//     wgpuSetMainLoopCallback-era gpubox) yields every frame, so its ships
//     track the vsync cadence — bounded, recyclable, sound;
//   - flushPresent's 'park' mode: ships stay at the vsync cadence even
//     through delay-loop parks;
//   - the compositor RECOVERS from device loss (re-acquire + rebuild) —
//     driven here through the REAL lost path (device.destroy()).
//
// Usage: node os-devloss.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3239;

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

  // ---- pollball: SDL_Renderer on the restored GPU tier, callback loop.
  // The wm places the first window at (12,36); field clear is (12,12,48).
  await vt1('pollball & wmctl wait win pollball && echo BALL-U""P');
  await setVt(1); await waitOut('BALL-UP', 30000); await setVt(2);
  const PX = 12, PY = 36;
  await waitPixel(PX + 2, PY + 2, [12, 12, 48], 60000, 'pollball field');
  check('pollball (SDL_Renderer, GPU tier, SDL_MAIN_USE_CALLBACKS) composites', true);

  // ---- #551 soundness invariant, renderer flavor: the callback loop's GPU
  // ships track the COMPOSITOR cadence, not a free-running present rate —
  // ships-per-compositor-frame in the SAME window is scale-free (#444).
  // Pre-#551 the blocking shape shipped one bitmap per present (~160/s
  // under SDL_Delay(1), ~unbounded poll-only); that shape is now refused,
  // and the surviving shape must hold ships <= ~1 per composited frame.
  await sleep(1500);                       // launch transient drains
  const c0 = await readStats();
  await sleep(3000);
  const c1 = await readStats();
  const pFrames = c1.frames - c0.frames;
  const pShips = c1.wmFrames - c0.wmFrames;
  const pRatio = pFrames > 0 ? pShips / pFrames : Infinity;
  console.log('       [window] pollball 3000ms: frames=' + pFrames + ' ships=' + pShips
    + ' ratio=' + pRatio.toFixed(3));
  check('SDL_Renderer callback app ships are vsync-clamped (<= ~1/frame)',
    pFrames > 20 && pShips > 10 && pRatio <= 1.3,
    { pFrames, pShips, pRatio: +pRatio.toFixed(3) });

  // ---- winbox: the shm transport window (orange fill, SDL window surface)
  // — recovery below must re-upload shm surfaces from their SABs, so keep a
  // real app-level shm window on screen beside the two gpu ones.
  await vt1('winbox & wmctl wait win winbox && WSID=$(wmctl list | grep "winbox$" | sed "s/[^0-9].*//") && wmctl move $WSID 620 80 && echo BOX-U""P');
  await setVt(1); await waitOut('BOX-UP', 30000); await setVt(2);
  await waitPixel(620 + 40, 80 + 40, [255, 140, 0], 30000, 'winbox fill');
  check('winbox (shm transport) composites', true);

  // ---- The webgpu.h gpu transport: gpubox ships bitmaps at the vsync
  // cadence too (its frame callback rides the same animation-frame seam).
  // Move gpubox off the cascade slot — its 640x480 would cover pollball's
  // probe point.
  await vt1('gpubox & wmctl wait win gpubox && GSID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//") && wmctl move $GSID 440 330 && echo GPU-U""P');
  await setVt(1); await waitOut('GPU-UP', 30000); await setVt(2);
  await sleep(1500);                       // launch transient drains
  const g0 = await readStats();
  await sleep(3000);
  const g1 = await readStats();
  const gFrames = g1.frames - g0.frames;
  const gShips = g1.wmFrames - g0.wmFrames;
  // Two gpu windows are live now (pollball + gpubox): the ceiling is ~1
  // ship per composited frame EACH.
  const ratio = gFrames > 0 ? gShips / gFrames : Infinity;
  console.log('       [window] pollball+gpubox 3000ms: frames=' + gFrames + ' ships=' + gShips
    + ' ratio=' + ratio.toFixed(3));
  check('webgpu.h + renderer ships stay vsync-clamped (<= ~1/frame each)',
    gFrames > 20 && gShips > 10 && ratio <= 2.3,
    { gFrames, gShips, ratio: +ratio.toFixed(3) });

  // ---- Device-loss recovery (#551 leg B): destroy the live device — the
  // REAL lost path — and require the compositor to come back with the
  // desktop, the shm window's content, and the gpu transport still flowing.
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
  // (label textures re-rasterize), the shm window re-uploads from its SAB,
  // gpu windows re-import / keep presenting (both apps are live).
  await waitPixel(SW - 20, SH - 60, TEAL, 15000, 'wallpaper after recovery');
  // NB not x=400: with windows open their taskbar BUTTONS cover that band
  // (a button face reads lighter than the bar face). SW-100 is the empty
  // run left of the clock.
  await waitPixel(SW - 100, BARY, FACE, 15000, 'taskbar after recovery');
  await waitPixel(620 + 40, 80 + 40, [255, 140, 0], 15000, 'winbox (shm) after recovery');
  await waitPixel(PX + 2, PY + 2, [12, 12, 48], 15000, 'pollball (gpu) after recovery');
  check('desktop + shm + gpu windows repaint after recovery', true);
  const r2 = await readStats();
  await sleep(2000);
  const r3 = await readStats();
  check('frames keep flowing after recovery', r3.frames > r2.frames,
    { before: r2.frames, after: r3.frames });
  check('gpu transport (bitmap ships) keeps flowing after recovery',
    r3.wmFrames > r2.wmFrames, { before: r2.wmFrames, after: r3.wmFrames });

  await vt1('pkill pollball; pkill winbox; pkill gpubox');
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os device-loss recovery (browser)');
