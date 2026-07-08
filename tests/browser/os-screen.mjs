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
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3199;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut && window.__osOut.includes(n), needle,
    { timeout: ms || 20000, polling: 200 });
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
  }, { timeout: 30000, polling: 200 });
  const screenDims = () => page.evaluate(() => window.__osScreen);

  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 8));
  const waitPixel = async (x, y, want, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (near(got, want)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) never became ${want}; last ${got}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const TEAL = [0, 128, 128], FACE = [192, 192, 192], ORANGE = [255, 140, 0];

  // ---- VT1: a viewport resize must NOT touch the screen (xterm-only path).
  let d = await screenDims();
  check('boot screen is the 800x500 canvas default', d.w === 800 && d.h === 500, d);
  await page.setViewportSize({ width: 1000, height: 800 });
  await new Promise(r => setTimeout(r, 600));            // past the debounce
  d = await screenDims();
  check('VT1 viewport resize leaves the screen alone', d.w === 800 && d.h === 500, d);
  await page.keyboard.type("echo VT1-RESIZE-O''K\r");
  await waitOut('VT1-RESIZE-OK');
  check('shell fine after a VT1 resize (xterm re-fit only)', true);

  // ---- VT2 entry: the screen syncs to the pane (full-viewport desktop).
  await setVt(2);
  await settle();
  const d1 = await screenDims();
  check('VT2 entry re-modes the screen to the viewport pane',
    d1.w === 1000 && d1.h > 500 && d1.h < 800, d1);
  await waitPixel(d1.w - 40, d1.h - 14, FACE, 60000);    // taskbar re-laid
  check('wm re-laid the taskbar at the new bottom edge (EV_SCREEN)', true);
  check('desktop fills the new area (teal at the far corner)',
    near(await sample(d1.w - 20, d1.h - 60), TEAL), await sample(d1.w - 20, d1.h - 60));

  // ---- Live resize ON VT2: grow — screen follows, taskbar follows.
  await page.setViewportSize({ width: 1200, height: 900 });
  await settle();
  const d2 = await screenDims();
  check('live viewport grow re-modes the screen', d2.w === 1200 && d2.h > d1.h, d2);
  await waitPixel(d2.w - 40, d2.h - 14, FACE, 60000);
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
  await waitPixel(d3.w - 120, d3.h - 14, FACE, 60000);   // bar at the new bottom
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
    m && +m[3] === d3.w - 40 && +m[4] === d3.h - 36, { row, d3 });

  // ---- VT1 unchanged throughout: the tty still works at the small size.
  await page.keyboard.type("echo END-O''K\r");
  await waitOut('END-OK');
  check('shell alive after the resize storm', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos screen (browser): PASS' : `\nos screen (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
