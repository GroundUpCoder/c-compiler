// winmine browser acceptance (todos/0068, design todos/WIN32.md): boot the
// reference OS page in headless Chromium, launch the seeded /bin/winmine
// from the shell, and play through the REAL input path — the menu bar
// opens on a page mouse click (popup pixels composited), ESC closes it, a
// board cell reveals on click — plus the agent path from the in-OS shell
// (`wmctl click Advanced` resizes the window: menu item by label -> the
// owner-initiated SURFACE_RESIZE, no pixels anywhere). The headless twin
// is tests/kernel/test_winmine_e2e.js (same geometry constants —
// vendor/winmine/main.h mirror; change together).
//
// Usage: node os-winmine.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3201;
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

  const { setVt, sample, near, waitScreen } = osHelpers(page);
  const waitPixel = async (x, y, want, ms, tol) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (near(got, want, tol)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) never became ${want}; last ${got}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const waitChange = async (x, y, from, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (!near(got, from, 4)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) stayed ${from}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut.includes(n), needle, { timeout: ms || 30000, polling: 200 });

  const TEAL = [0, 128, 128], BTNFACE = [192, 192, 192];

  await setVt(2);
  await waitScreen();

  // Launch from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('winmine &\r');
  await new Promise(r => setTimeout(r, 500));
  await setVt(2);
  await new Promise(r => setTimeout(r, 500));

  // The WM places the first window at (12,36). Beginner surface 154x202:
  // 30px user32 menu bar over a 154x182 board client.
  const WX = 12, WY = 36;
  const at = (x, y) => [WX + x, WY + y];
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (x, y) => page.mouse.click(rect.x + WX + x, rect.y + WY + y);

  // The far top-right corner of the 30px bar is clear of the menu titles
  // (whose 20px text hugs the left) and above the text baseline.
  await waitPixel(...at(148, 4), BTNFACE, 90000);
  check('menu bar composited (BTNFACE strip)', true);

  // The timer LEDs sit under the bar at client (5,5) => surface y 35..58
  // (30px menu bar); their face is dark — the popup covers it with BTNFACE.
  const led = await sample(...at(10, 42));
  check('timer LED area is dark (LoadBitmapW leds.bmp)', led[0] < 90 && led[1] < 90, led);

  // REAL mouse: open the Options popup, pixels appear over the LED area.
  await new Promise(r => setTimeout(r, 400));
  await clickAt(10, 10);
  const overLed = await waitChange(...at(10, 42), led, 30000);
  check('bar click opens the popup (pixels over the LEDs)', near(overLed, BTNFACE, 24), overLed);
  await page.keyboard.press('Escape');
  await waitPixel(...at(10, 42), led, 30000, 24);
  check('ESC closes the popup (LEDs restored)', true);

  // REAL mouse: reveal a board cell — mines rect starts at client (5,33)
  // => surface (5,63); cell (1,1) center (13,71). Diff the WHOLE 16x16
  // cell rect, not one center pixel: a blank reveal (no adjacent mines —
  // roughly a third of random boards) flood-fills FLAT, so the center
  // stays face gray and only the raised border changes. The headless twin
  // asserts the same way (test_winmine_e2e.js cellRect f.equals(r)).
  const rectSig = (x, y, w, h) => page.evaluate(([a, b, c, d]) => {
    const cv = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = cv.width; t.height = cv.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const img = ctx.getImageData(a, b, c, d).data;
    let sig = 2166136261 >>> 0;
    for (let i = 0; i < img.length; i += 4) {
      sig ^= (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      sig = Math.imul(sig, 16777619) >>> 0;
    }
    return sig;
  }, [x, y, w, h]);
  const CELL_RECT = [...at(5, 63), 16, 16];
  const cell = await rectSig(...CELL_RECT);
  await new Promise(r => setTimeout(r, 300));
  await clickAt(13, 71);
  {
    const t0 = Date.now();
    for (;;) {
      if (await rectSig(...CELL_RECT) !== cell) break;
      if (Date.now() - t0 > 30000) throw new Error('cell rect never changed; sig ' + cell);
      await new Promise(r => setTimeout(r, 200));
    }
  }
  check('cell click reveals (board pixels change)', true);

  // Agent path from the in-OS shell: difficulty by menu label — the
  // window RESIZES (SDL_SetWindowSize -> SURFACE_RESIZE end to end).
  await setVt(1);
  await page.keyboard.type('wmctl click Advanced\r');
  await new Promise(r => setTimeout(r, 300));
  await setVt(2);
  // Advanced surface is 266x314: a cell INTERIOR past the beginner width
  // fills in (col 13 center — edges carry the 3D highlight, not BTNFACE).
  await waitPixel(...at(221, 167), BTNFACE, 30000, 24);
  check('wmctl click Advanced resizes the board (266x314 surface)', true);

  // Exit via the menu (agent path); desktop teal restored, shell alive.
  await setVt(1);
  await page.keyboard.type('wmctl click Exit\r');
  await new Promise(r => setTimeout(r, 300));
  await setVt(2);
  await waitPixel(...at(80, 80), TEAL, 30000);
  check('Exit closes winmine; desktop restored', true);

  await setVt(1);
  await page.keyboard.type('echo WINMINE-SHELL-OK\r');
  await waitOut('WINMINE-SHELL-OK', 20000);
  check('shell alive after winmine exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  try {
    const pages = browser.contexts()[0] ? browser.contexts()[0].pages() : [];
    if (pages[0]) {
      const tail = await pages[0].evaluate(() => (window.__osOut || '').slice(-1200));
      console.error('--- __osOut tail ---\n' + tail);
    }
  } catch {}
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos winmine (browser): PASS' : `\nos winmine (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
