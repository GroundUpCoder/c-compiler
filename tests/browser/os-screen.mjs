// 0023 browser acceptance: dynamic screen resolution — the desktop screen
// stops being a boot-time 800x500 constant. On VT2 the canvas tracks the
// viewport pane (natural size only, 1 CSS px = 1 screen px); a live browser
// window resize re-modes the screen (OffscreenCanvas resize + wmSetScreen ->
// EV_SCREEN), the wm re-lays its taskbar at the new bottom edge, and a
// shrink leaves no window with an unreachable title bar (kernel one-shot
// clamp + the wm's taskbar-aware re-clamp). VT1 stays a pure xterm pane:
// resizes there only re-fit the terminal, never touch the screen.
//
// Usage: node os-screen.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3334;   // unique per member (#546)
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, sample, near, waitPixel, waitOut } = osHelpers(page);
  // The screen is settled when the page's last-sent size matches BOTH the
  // #desktop pane (nothing further to send) and the canvas layout rect (the
  // worker's resized OffscreenCanvas commit arrived).
  const settle = () => page.waitForFunction(() => {
    const pane = document.getElementById('desktop');
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && (document.body.getAttribute('data-vt') !== '2' ||
      (s.w === pane.clientWidth && s.h === pane.clientHeight)) &&
      Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 'raf' });
  const screenDims = () => page.evaluate(() => window.__osScreen);

  const TEAL = [0, 128, 128], FACE = [192, 192, 192], ORANGE = [255, 140, 0];

  // ---- Boot (0070: ready lands on VT2): the auto-switch IS the first VT2
  // entry, so the 800x500 boot default is already re-moded to the pane.
  await settle();
  let d = await screenDims();
  check('boot auto-switch re-modes the screen to the viewport pane (0070)',
    d.w === 1100 && d.h > 500 && d.h < 900, d);

  // ---- VT1: a viewport resize must NOT touch the screen (xterm-only path).
  await setVt(1);
  await page.setViewportSize({ width: 1000, height: 800 });
  await new Promise(r => setTimeout(r, 600));            // past the debounce
  d = await screenDims();
  check('VT1 viewport resize leaves the screen alone', d.w === 1100, d);
  await page.keyboard.type("echo VT1-RESIZE-O''K\r");
  await waitOut('VT1-RESIZE-OK');
  check('shell fine after a VT1 resize (xterm re-fit only)', true);

  // ---- VT2 entry: the screen syncs to the pane (full-viewport desktop).
  await setVt(2);
  await settle();
  const d1 = await screenDims();
  check('VT2 entry re-modes the screen to the viewport pane',
    d1.w === 1000 && d1.h > 500 && d1.h < 800, d1);
  await waitPixel(d1.w - 200, d1.h - 18, FACE, 60000);   // taskbar re-laid (blank strip, left of the clock)
  check('wm re-laid the taskbar at the new bottom edge (EV_SCREEN)', true);
  check('desktop fills the new area (teal at the far corner)',
    near(await sample(d1.w - 20, d1.h - 60), TEAL), await sample(d1.w - 20, d1.h - 60));

  // ---- Live resize ON VT2: grow — screen follows, taskbar follows.
  await page.setViewportSize({ width: 1200, height: 900 });
  await settle();
  const d2 = await screenDims();
  check('live viewport grow re-modes the screen', d2.w === 1200 && d2.h > d1.h, d2);
  await waitPixel(d2.w - 200, d2.h - 18, FACE, 60000);
  check('taskbar re-laid after the grow (full new width)', true);
  check('old bottom strip is desktop again',
    near(await sample(400, d1.h - 14), TEAL), await sample(400, d1.h - 14));

  // ---- Shrink strands no window: park winbox at the bottom-right, shrink,
  // and the clamps (kernel + wm) must bring its title bar back in reach.
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000);     // first slot (12,36)
  check('winbox composited', true);
  await setVt(1);
  const PX = d2.w - 60, PY = d2.h - 50;                  // mostly off the bar
  await page.keyboard.type('WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")\r');
  await page.keyboard.type(`wmctl move $WSID ${PX} ${PY} && echo PARK-O''K\r`);
  await waitOut('PARK-OK');
  await page.setViewportSize({ width: 760, height: 680 });
  await new Promise(r => setTimeout(r, 600));
  d = await screenDims();
  check('shrink on VT1 deferred (screen untouched until VT2)', d.w === d2.w, d);
  await setVt(2);
  await settle();
  const d3 = await screenDims();
  check('VT2 entry applies the shrink', d3.w === 760 && d3.h < d2.h, d3);
  await waitPixel(d3.w - 200, d3.h - 18, FACE, 60000);   // bar at the new bottom (blank strip)
  check('taskbar re-laid after the shrink', true);
  await setVt(1);
  await page.keyboard.type("wmctl list | grep winbox$ && echo LIST-O''K\r");
  await waitOut('LIST-OK');
  const row = await page.evaluate(() => {
    const lines = window.__osOut.split('\n').filter(l => /winbox\s*$/.test(l));
    return lines[lines.length - 1] || '';
  });
  const m = row.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
  check('winbox re-clamped: title bar reachable, clear of the taskbar',
    m && +m[3] === d3.w - 40 && +m[4] === d3.h - 44, { row, d3 });

  // ---- VT1 unchanged throughout: the tty still works at the small size.
  await page.keyboard.type("echo END-O''K\r");
  await waitOut('END-OK');
  check('shell alive after the resize storm', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos screen (browser): PASS' : `\nos screen (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
