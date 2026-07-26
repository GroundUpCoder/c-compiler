// Paint browser acceptance (todos/0107, design todos/WIN32.md): boot the
// reference OS page in headless Chromium, launch the seeded /bin/paint from
// the shell, and drive it with the REAL mouse — pick the Filled Rectangle
// toolbox tool + a red palette swatch, drag a rectangle across the memory-DC
// canvas, and assert the red interior composites through the real WebGPU
// compositor at the exact coordinates os/win32/paint.c draws (the headless
// twin, tests/kernel/test_paint_e2e.js, probes the same geometry off `wmctl
// shot`). Close box -> SDL_EVENT_QUIT -> app exits; the shell survives.
//
// Usage: node os-paint.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3207;
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
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, waitScreen } = osHelpers(page);
  // sample takes PAGE coords (the same space page.mouse uses — scr()/bmp()
  // below include the canvas origin), so subtract the canvas rect here.
  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    const r = c.getBoundingClientRect();
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(Math.round(sx - r.x), Math.round(sy - r.y), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 12));
  const waitPixel = async (x, y, want, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (near(got, want)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) never became ${want}; last ${got}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  const TEAL = [0, 128, 128], WHITE = [255, 255, 255], RED = [255, 0, 0];

  await setVt(2);
  await waitScreen();

  // Launch the seeded Paint from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('paint &\r');
  await setVt(2);

  // The WM places the first window at (12,36). paint.c geometry mirror: menu
  // bar 20px, canvas at client (56,6). Surface pixel (sp) -> screen.
  const WX = 12, WY = 36, BAR = 30, CANVAS_X = 56, CANVAS_Y = 6;
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const scr = (spx, spy) => [rect.x + WX + spx, rect.y + WY + spy];        // surface -> screen
  const bmp = (bx, by) => scr(CANVAS_X + bx, CANVAS_Y + by + BAR);         // canvas bitmap -> screen
  // toolbox cell centre (paint.c hit-tests in CLIENT coords, below the menu
  // bar — so surface y needs +BAR): filled-rect is index 5 (col 1, row 2).
  const tbCell = (i) => scr(4 + (i % 2) * 22 + 10, 4 + Math.floor(i / 2) * 22 + 10 + BAR);
  // palette swatch centre (surface): k = row*8 + col.
  const swatch = (k) => scr(CANVAS_X + (k % 8) * 16 + 8, (6 + 300 + 12) + Math.floor(k / 8) * 16 + 8 + BAR);

  // wait for the first paint: the canvas centre is white.
  await waitPixel(...bmp(120, 100), WHITE, 60000);
  check('canvas composits white', true);

  // Park a click on the dead client strip under the toolbox first (hits no
  // toolbox/palette/canvas region), so any focus-click semantics are spent
  // before the clicks that must reach the app.
  await page.mouse.click(...scr(20, 200 + BAR));
  // Pick Filled Rectangle (toolbox) + a red swatch (palette); paint.c prints
  // `paint: tool=N` / `paint: fg=...` to its tty on each pick — wait on
  // __osOut instead of pacing blind (todos/0083).
  await page.mouse.click(...tbCell(5));
  await page.waitForFunction(() => window.__osOut.includes('paint: tool=5'), { timeout: 20000, polling: 200 });
  check('toolbox click selected Filled Rectangle (tool=5)', true);
  await page.mouse.click(...swatch(10));                 // k=10 -> red
  await page.waitForFunction(() => window.__osOut.includes('paint: fg='), { timeout: 20000, polling: 200 });
  check('palette click set the red foreground', true);
  const [dx0, dy0] = bmp(40, 40), [dx1, dy1] = bmp(200, 160);
  await page.mouse.move(dx0, dy0);
  await page.mouse.down();
  await page.mouse.move((dx0 + dx1) / 2, (dy0 + dy1) / 2);
  await page.mouse.move(dx1, dy1);
  await page.mouse.up();

  await waitPixel(...bmp(120, 100), RED, 30000);
  check('filled rectangle painted red into the canvas', true);
  check('canvas outside the rectangle stays white', near(await sample(...bmp(340, 260)), WHITE),
    await sample(...bmp(340, 260)));

  // Close box -> SDL_EVENT_QUIT -> WM_DESTROY -> exit; desktop restored.
  const surfW = 464;
  await page.mouse.click(rect.x + WX + surfW - 12, rect.y + WY - 12);
  await waitPixel(...bmp(120, 100), TEAL);
  check('close box quit paint; desktop restored', true);

  // The shell survives its windowed child.
  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // PAINT-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo PAINT-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('PAINT-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after paint exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos paint (browser): PASS' : `\nos paint (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
