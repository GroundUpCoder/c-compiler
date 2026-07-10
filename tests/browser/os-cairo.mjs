// cairo browser acceptance (todos/0061): boot the reference OS page in
// headless Chromium, launch the seeded /bin/cairodemo from the shell, and
// assert the vector scene (radial gradient disc, translucent star, bezier
// ribbon, cairo-ft label) composits correctly on the desktop canvas at the
// coordinates vendor/cairo/demo/main.c draws (the headless twin,
// tests/kernel/test_cairo_e2e.js, probes the same anchors off `wmctl shot`;
// this leg proves the same pixels through the real compositor). A keypress
// toggles the dark theme (an shm repaint); close box -> SDL_EVENT_QUIT.
//
// Usage: node os-cairo.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3219;
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);
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

  const TEAL = [0, 128, 128], NAVY = [0, 0, 128];

  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });

  // Launch the seeded cairo demo from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('cairodemo &\r');
  await setVt(2);

  // The WM places the first window at (12,36); the scene is 480x360 and
  // every coordinate below mirrors vendor/cairo/demo/main.c draw_scene.
  const WX = 12, WY = 36;
  const at = (x, y) => [WX + x, WY + y];

  await waitPixel(...at(120, 120), [255, 220, 79], 60000);
  check('radial disc center composited', true);
  check('bg gradient top', near(await sample(...at(240, 2)), [239, 239, 244]), await sample(...at(240, 2)));
  check('bg gradient bottom', near(await sample(...at(240, 358)), [200, 200, 219]), await sample(...at(240, 358)));
  check('translucent star over gradient', near(await sample(...at(340, 120)), [68, 175, 93]), await sample(...at(340, 120)));
  check('bezier ribbon mid', near(await sample(...at(240, 295)), [38, 89, 229], 12), await sample(...at(240, 295)));

  // cairo-ft label: scan the label band for dark ink.
  let ink = null;
  for (let x = 210; x < 460 && !ink; x += 4) {
    const p = await sample(...at(x, 318));
    if (p[0] < 0x50) ink = p;
  }
  check('cairo-ft label ink composited', ink !== null, ink);

  check('focused title bar navy', near(await sample(...at(150, -12)), NAVY), await sample(...at(150, -12)));

  // KEYDOWN (focused window) toggles the dark theme — an shm repaint.
  await page.keyboard.press('d');
  await waitPixel(...at(240, 2), [33, 33, 41]);
  check('dark theme repaint composited', true);
  check('disc center unchanged in dark theme', near(await sample(...at(120, 120)), [255, 220, 79]), await sample(...at(120, 120)));
  await page.keyboard.press('d');
  await waitPixel(...at(240, 2), [239, 239, 244]);
  check('light theme restored', true);

  // Close box -> SDL_EVENT_QUIT -> exit; desktop restored.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + WX + 480 - 12, rect.y + WY - 12);
  await waitPixel(...at(240, 180), TEAL);
  check('close box quit cairodemo; desktop restored', true);

  // The shell survives its windowed child.
  await setVt(1);
  await page.keyboard.type('echo CAIRO-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('CAIRO-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after cairodemo exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos cairo (browser): PASS' : `\nos cairo (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
