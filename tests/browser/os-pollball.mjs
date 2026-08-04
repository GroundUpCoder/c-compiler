// GPU present-transport backpressure acceptance (ticket #484): boot the
// reference OS page in headless Chromium and run /usr/local/bin/pollball —
// the GAMEDEV-EPIC repro, a poll-only SDL_Renderer bouncing-ball loop with
// NO SDL_Delay and NO SDL_WaitEvent anywhere (the most common naive game
// main loop). Unclamped, that loop presents a fresh ~300KB GPU ImageBitmap
// per iteration (~8,000/s measured headless on this app) into an unbounded
// fire-and-forget postMessage queue and kills the browser GPU process — the
// tab-crash class #484 closes. With the producer-side clamp the app must:
//   - composite and visibly ANIMATE (the clamp drops/coalesces, never wedges)
//   - present at ~vsync as observed BY THE KERNEL: `wmctl seq SID` (the
//     surface frame counter _wmFrame bumps at consume) read twice a known
//     interval apart must show a clamped rate, not thousands/s
//   - stay responsive: the title-bar close request (WMEV_QUIT via wmctl
//     close) reaches SDL_PollEvent (#485's pump) and the app quits cleanly
//   - leave the OS alive: desktop restored, shell answering
//
// Red control (documented for the record): with host.js's presentTo clamp
// reverted, the measured kernel rate blows far past the upper bound (and
// the tab may die outright) — the rate leg is the loud failure.
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
  check('ball animates (poll-only loop is live under the clamp)', animated);

  // ---- the #484 clamp, measured at the KERNEL ----
  // frameSeq (wmctl seq) counts frames the kernel CONSUMED; a poll-only
  // flood used to push thousands/s at it. Two reads a known wall-clock
  // interval apart bound the rate: comfortably above zero (alive) and
  // comfortably below the flood (clamped to ~compositor rate; 60Hz rAF
  // typical, generous headroom for fast displays and timing slop — the
  // unclamped loop measures in the thousands, an order of magnitude past
  // the bound in either direction).
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
  check(`present rate clamped to ~vsync (${rate.toFixed(0)}/s over ${t2 - t1}ms, seq ${r1}->${r2})`,
    rate > 15 && rate < 300, rate.toFixed(1) + '/s');

  // Close box -> WMEV_QUIT -> SDL_PollEvent (#485's pump) -> clean quit.
  await page.keyboard.type('wmctl close $SID\r');
  await page.waitForFunction(() => window.__osOut.includes('pollball: quit'), { timeout: 20000, polling: 200 });
  check('close request quit the poll-only loop cleanly (pollball: quit)', true);
  await setVt(2);
  const t3 = Date.now();
  for (;;) {
    const got = await sample(WX + (CW >> 1), WY + (CH >> 1));
    if (near(got, TEAL)) break;
    if (Date.now() - t3 > 30000) throw new Error(`window never closed; center ${got}`);
    await new Promise(r => setTimeout(r, 250));
  }
  check('desktop restored after quit', true);

  // OS alive after minutes-scale flooding pressure: shell still answers.
  await setVt(1);
  // Split needle (the 0089 echo trap): the echo of the TYPED line must not
  // satisfy the wait — assemble the needle in the output only.
  await page.keyboard.type("echo POLLBALL-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('POLLBALL-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after the poll-only app exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos pollball (browser): PASS' : `\nos pollball (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
