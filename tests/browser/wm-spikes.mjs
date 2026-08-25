// Runner for WM spikes S1/S2/S4 (todos/0012) — drives www/wm-spikes.html in
// headless Chromium and prints verdicts. See WM.md spike appendix.
// Run: node wm-spikes.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3191;
const URL = `http://localhost:${PORT}/wm-spikes.html`;

const server = spawn('node', [path.join(__dirname, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
// Forward server logs so a "port in use" death is visible instead of a bare
// downstream ERR_CONNECTION_REFUSED (#725; the quake-renders.mjs pattern).
server.stdout.on('data', d => process.stderr.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server] ' + d));
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const page = await (await browser.newContext()).newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__spikes !== null, { timeout: 60000, polling: 250 });
  const r = await page.evaluate(() => window.__spikes);

  check('no errors', r.errors.length === 0, r.errors);

  // S1: bitmap handoff — pixels intact and cheap (GPU-backed, no hidden sync
  // readback: p50 well under a ms for a 640x480 frame if it stays on GPU).
  check('S1 pixels: kern readback of imported frame is green',
    r.s1 && String(r.s1.screenMidPixel) === '0,255,0,255', r.s1 && r.s1.screenMidPixel);
  check('S1 all frames arrived', r.s1 && r.s1.frames === 120, r.s1 && r.s1.frames);
  check('S1 import cost p50 < 2ms (GPU-backed)', r.s1 && r.s1.importMs.p50 < 2, r.s1 && r.s1.importMs);
  check('S1 render+present p50 < 5ms', r.s1 && r.s1.renderPresentMs.p50 < 5, r.s1 && r.s1.renderPresentMs);
  console.log('  info S1 timings: present=' + JSON.stringify(r.s1 && r.s1.renderPresentMs) +
              ' import=' + JSON.stringify(r.s1 && r.s1.importMs));

  // S2: rAF exists in the worker and holds a sane cadence under busy-work.
  check('S2 worker rAF cadence p50 in [4,40]ms',
    r.s2 && r.s2.rafIntervalMs.p50 >= 4 && r.s2.rafIntervalMs.p50 <= 40, r.s2 && r.s2.rafIntervalMs);
  console.log('  info S2 rAF intervals: ' + JSON.stringify(r.s2 && r.s2.rafIntervalMs));

  // S4: two-hop transferred DOM canvas renders from the proc worker; sample
  // the displayed pixels via drawImage into a 2D canvas.
  check('S4 render call completed', r.s4 && r.s4.rendered === true, r.s4);
  const px = await page.evaluate(() => {
    const c = document.getElementById('direct');
    const s = document.createElement('canvas');
    s.width = 128; s.height = 128;
    const ctx = s.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(64, 64, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  });
  check('S4 direct canvas shows magenta', px[0] > 200 && px[1] < 50 && px[2] > 200, px);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nwm spikes: PASS' : `\nwm spikes: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
