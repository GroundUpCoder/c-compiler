// WM browser acceptance (todos/WM.md): boot the reference OS page in headless
// Chromium, launch the seeded /bin/winbox from the shell, and drive its
// WINDOW through the real UI-bridge path — canvas mouse/keyboard -> kernel
// hit-test/rings -> SDL app — asserting composited pixels on the desktop
// canvas at every step (window fill, kernel chrome, click paint, key toggle,
// title-bar drag, close box).
//
// Usage: node os-wm.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3193;
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

  // Sample composited pixels off the (transferred) desktop canvas.
  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
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

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], GREEN = [0, 200, 80],
        NAVY = [0, 0, 128], WHITE = [255, 255, 255], BLACK = [0, 0, 0];

  check('desktop teal before any window', near(await sample(780, 480), TEAL), await sample(780, 480));

  // Launch the seeded windowed app from the shell (real tty path).
  await page.keyboard.type('winbox &\r');

  // First window cascades to client (8,32), 240x160 (kernel placement).
  const WX = 8, WY = 32, WW = 240, WH = 160;
  await waitPixel(WX + 120, WY + 80, ORANGE, 60000);
  check('winbox window composited (orange fill)', true);
  check('white app border', near(await sample(WX + 2, WY + 2), WHITE), await sample(WX + 2, WY + 2));
  // Sample chrome AWAY from the title text and the close-box 'x' glyph.
  check('focused title bar navy', near(await sample(WX + 150, WY - 12), NAVY), await sample(WX + 150, WY - 12));
  // Close box rect: x in [WX+WW-20, WX+WW-4), y in [WY-20, WY-4); sample its
  // top-right corner, clear of the black 'x' glyph.
  check('close box present', near(await sample(WX + WW - 6, WY - 18), [192, 192, 192]), await sample(WX + WW - 6, WY - 18));

  // Click inside the client: kernel hit test -> ring -> SDL -> black paint
  // at the LOCAL point.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);
  await clickAt(WX + 60, WY + 60);
  await waitPixel(WX + 60, WY + 60, BLACK);
  check('client click painted at local coords', true);

  // Keyboard: canvas has focus after the click; any key toggles green.
  await page.keyboard.press('g');
  await waitPixel(WX + 120, WY + 80, GREEN);
  check('key toggled the fill green', true);

  // Title-bar drag: grab (WX+100, WY-12), drop 80 right / 60 down.
  await page.mouse.move(rect.x + WX + 100, rect.y + WY - 12);
  await page.mouse.down();
  await page.mouse.move(rect.x + WX + 180, rect.y + WY + 48, { steps: 8 });
  await page.mouse.up();
  const NX = WX + 80, NY = WY + 60;
  await waitPixel(NX + 120, NY + 80, GREEN);
  check('title drag moved the window', true);
  check('old spot back to desktop', near(await sample(WX + 4, WY + 4), TEAL), await sample(WX + 4, WY + 4));

  // Close box -> SDL_EVENT_QUIT -> app exits -> window gone.
  await clickAt(NX + WW - 12, NY - 12);
  await waitPixel(NX + 120, NY + 80, TEAL);
  check('close box quit the app; desktop restored', true);

  // The shell survives its windowed child (background job reaped). Click the
  // terminal first — the desktop canvas took keyboard focus during the test.
  await page.click('#terminal');
  await page.keyboard.type('echo WM-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('WM-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after windowed app exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos wm (browser): PASS' : `\nos wm (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
