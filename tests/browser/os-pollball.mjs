// SDL_Renderer-in-OS acceptance (ticket #484; re-cut twice by #551): boot
// the reference OS page in headless Chromium and run
// /usr/local/bin/pollball — since #551 the REFERENCE SDL_MAIN_USE_CALLBACKS
// app, an SDL_Renderer bouncing ball on SDL3's callback main loop, riding
// the restored GPU renderer tier.
//
// History: pollball's original poll-only blocking loop presented a fresh
// GPU ImageBitmap per iteration (~8,000/s measured headless) and killed
// the browser GPU process — #484 clamped the shipping. #551 then measured
// that Chromium budgets a NEVER-YIELDING worker a finite lifetime of
// transferToImageBitmap ships at ANY rate (the recycle tasks can only run
// on the producer's event loop), so even clamped ships died in minutes —
// blocking-loop GPU presents are now REFUSED outright (that acceptance is
// os-loopguard.mjs, which carries the old blocking shapes as fixtures),
// and pollball demonstrates the sanctioned model: main() returns, the
// host paces SDL_AppIterate per composited frame, the worker yields
// between frames, and every shipped bitmap is recyclable. The app must:
//   - composite and visibly ANIMATE through the gpu transport
//   - present continuously as observed BY THE KERNEL: `wmctl seq SID`
//     advances (_wmFrame bumps the same header seq the shm path uses),
//     and the RATE sits in the vsync-clamped band — the #484 ceiling is
//     BACK, because the GPU transport is back: a callback app presents
//     once per composited frame, never free-runs
//   - stay responsive: the title-bar close request (WMEV_QUIT via wmctl
//     close) reaches SDL_AppEvent and the app quits cleanly
//   - leave the OS alive: desktop restored, shell answering
//
// Usage: node os-pollball.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3213;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 12));

  const TEAL = [0, 128, 128];
  const FIELD = [12, 12, 48];                 // pollball render-clear color

  const { setVt } = osHelpers(page);

  // Launch from the real shell; the WM places the first window at (12,36).
  await setVt(1);   // 0070: ready lands on VT2; launch from the tty
  await page.keyboard.type('pollball &\r');
  await setVt(2);
  // 0023: VT2 entry re-modes the screen to the viewport pane; wait for the
  // resized canvas commit so pixel geometry below is stable.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 200 });

  // Client origin lands at (12,36) once the wm's placement MOVE settles; the
  // corner probe doubles as the "really at the slot" gate (the ball sweeps
  // past corners, so a ball-covered corner just retries next poll).
  const WX = 12, WY = 36, CW = 320, CH = 240;
  const t0 = Date.now();
  for (;;) {
    const corner = await sample(WX + 2, WY + 2);
    if (near(corner, FIELD)) break;
    if (Date.now() - t0 > 90000) throw new Error(`pollball field never composited; last ${corner}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('pollball composited (SDL_Renderer frame through the gpu transport)', true);

  // Animation: the ball crosses the middle band at ~140px/s — time-separated
  // probe trios must differ while the field corner stays the clear color.
  const probe = async () => [
    ...(await sample(WX + (CW >> 1), WY + (CH >> 1))),
    ...(await sample(WX + (CW >> 1) - 60, WY + (CH >> 1) - 45)),
    ...(await sample(WX + (CW >> 1) + 60, WY + (CH >> 1) + 45)),
  ];
  const a = await probe();
  let animated = false;
  for (let i = 0; i < 40 && !animated; i++) {
    await new Promise(r => setTimeout(r, 300));
    const b = await probe();
    animated = b.some((v, j) => Math.abs(v - a[j]) > 12);
  }
  check('ball animates (callback loop is live)', animated);

  // ---- presents reach the kernel continuously (gpu transport, #551) ----
  // frameSeq (wmctl seq) counts frames the kernel received (_wmFrame bumps
  // the same header word shm flips do). A callback app presents once per
  // composited frame, so the band is the #484 clamp band again: the floor
  // is load-safe (#444 — load only lowers a frame rate), and the ceiling
  // is physical (the producer clamp holds ships to ~1 per vsync tick /
  // 125/s on the 8ms wall fallback — a free-running rate here means the
  // clamp or the callback pacing regressed).
  await setVt(1);
  await page.keyboard.type('SID=$(wmctl list | grep "pollball$" | sed "s/[^0-9].*//"); wmctl wait seq $SID 60 15000 && echo SEQ""OK\r');
  await page.waitForFunction(() => window.__osOut.includes('SEQOK'), { timeout: 20000, polling: 100 });
  check('kernel saw >= 60 presented frames (wmctl wait seq)', true);

  await page.keyboard.type('echo R1=$(wmctl seq $SID)\r');
  await page.waitForFunction(() => /R1=\d+/.test(window.__osOut), { timeout: 20000, polling: 100 });
  const t1 = Date.now();
  const r1 = parseInt((await page.evaluate(() => window.__osOut)).match(/R1=(\d+)/)[1], 10);
  await new Promise(r => setTimeout(r, 4000));
  await page.keyboard.type('echo R2=$(wmctl seq $SID)\r');
  await page.waitForFunction(() => /R2=\d+/.test(window.__osOut), { timeout: 20000, polling: 100 });
  const t2 = Date.now();
  const r2 = parseInt((await page.evaluate(() => window.__osOut)).match(/R2=(\d+)/)[1], 10);
  const rate = (r2 - r1) * 1000 / (t2 - t1);
  check(`callback loop presents at the vsync-clamped cadence (${rate.toFixed(0)}/s over ${t2 - t1}ms, seq ${r1}->${r2})`,
    rate > 15 && rate < 300, rate.toFixed(1) + '/s');

  // Close box -> WMEV_QUIT -> SDL_AppEvent (the driver polls) -> clean quit.
  await page.keyboard.type('wmctl close $SID\r');
  await page.waitForFunction(() => window.__osOut.includes('pollball: quit'), { timeout: 20000, polling: 200 });
  check('close request quit the callback loop cleanly (pollball: quit)', true);
  await setVt(2);
  const t3 = Date.now();
  for (;;) {
    const got = await sample(WX + (CW >> 1), WY + (CH >> 1));
    if (near(got, TEAL)) break;
    if (Date.now() - t3 > 30000) throw new Error(`window never closed; center ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('desktop restored after quit', true);

  // OS alive after the run: shell still answers.
  await setVt(1);
  // Split needle (the 0089 echo trap): the echo of the TYPED line must not
  // satisfy the wait — assemble the needle in the output only.
  await page.keyboard.type("echo POLLBALL-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('POLLBALL-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after the callback app exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos pollball (browser): PASS' : `\nos pollball (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
