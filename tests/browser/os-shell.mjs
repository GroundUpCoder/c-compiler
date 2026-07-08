// Desktop-shell browser acceptance (todos/0028 start menu, todos/0029
// desktop icons): boot the reference OS page in headless Chromium and
// drive the /bin/wm shell furniture through the real UI-bridge path —
// canvas clicks -> kernel hit-test/rings -> wm.c policy — asserting
// composited pixels. Covers: the Start button, menu open/dismiss, entry
// hover highlight, launching a windowed app from the menu; the desktop
// icon grid (EV_SCREEN-recreated at the live size), single-click select,
// double-click launch of term, minimize revealing the desktop.
//
// Usage: node os-shell.mjs   (manual tier — run the os-*.mjs sweep serially)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3197;
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

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], NAVY = [0, 0, 128],
        FACE = [192, 192, 192];

  await setVt(2);
  // Derive geometry from the LIVE screen (todos/0023 rule).
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);
  const BARY = SH - 14;                          // mid-taskbar sample row

  // ---- the Start menu (todos/0028) ----
  await waitPixel(400, BARY, FACE, 60000);       // taskbar composited
  check('taskbar strip composited', true);
  // The Start button face, right of the "START" label glyphs (x 8..38).
  check('Start button face at the taskbar left', near(await sample(44, BARY), FACE),
    await sample(44, BARY));

  // /etc/menu seeds 7 entries (sorted): doom gameboy gpubox quake snake
  // term winbox -> 150x148, parked above the taskbar.
  const MENU_Y = SH - 28 - 148;
  check('menu spot is desktop before the click', near(await sample(120, MENU_Y + 74), TEAL),
    await sample(120, MENU_Y + 74));
  await clickAt(25, BARY);                       // Start (x < 50)
  await waitPixel(120, MENU_Y + 74, FACE);
  check('Start click opens the menu (face fill above the taskbar)', true);

  // Hover the winbox entry (index 6, rows are 20px from MENU_Y+4): the
  // Win95 navy highlight tracks the pointer.
  await page.mouse.move(rect.x + 75, rect.y + MENU_Y + 134);
  await waitPixel(120, MENU_Y + 134, NAVY);
  check('entry hover highlights navy', true);

  // Select it: winbox spawns (the WM places its first window at 12,36),
  // the menu closes.
  await clickAt(75, MENU_Y + 134);
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000);
  check('menu entry launched winbox (orange fill at the WM placement)', true);
  await waitPixel(120, MENU_Y + 74, TEAL);
  check('selection dismissed the menu', true);

  // Re-open, then click the winbox window: the focus change dismisses.
  await clickAt(25, BARY);
  await waitPixel(120, MENU_Y + 74, FACE);
  check('menu re-opens', true);
  await clickAt(12 + 120, 36 + 80);              // winbox client click
  await waitPixel(120, MENU_Y + 74, TEAL);
  check('focus change dismisses the menu', true);

  // Start toggles: open, then a second Start click closes.
  await clickAt(25, BARY);
  await waitPixel(120, MENU_Y + 74, FACE);
  await clickAt(25, BARY);
  await waitPixel(120, MENU_Y + 74, TEAL);
  check('Start click toggles the menu closed', true);

  // ---- the desktop layer (todos/0029) ----
  const WHITE = [255, 255, 255];
  const waitNotPixel = async (x, y, notWant, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (!near(got, notWant)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) stayed ${notWant}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  // Icons flow down the left edge (sorted: doom gameboy quake term). The
  // winbox launched above covers rows 0-2; icon 3 (term) at cell (16,208)
  // is clear: white 24x24 tile at (46,214), navy center, label below.
  const I3X = 46, I3Y = 16 + 3 * 64 + 6;         // term's icon tile origin
  await waitPixel(I3X + 2, I3Y + 2, WHITE);
  check('desktop icon tile composited (term, cell 3)', true);
  check('icon glyph navy center', near(await sample(I3X + 12, I3Y + 12), NAVY),
    await sample(I3X + 12, I3Y + 12));

  // Single click: selection highlight (navy label strip), NO launch.
  await clickAt(58, I3Y + 10);
  await waitPixel(45, 16 + 3 * 64 + 24 + 10 + 3, NAVY);   // label bg, left of text
  check('single click selects (navy label strip)', true);

  // Double-click launches term (640x432 at the cascade slot). Sample a
  // point inside term but outside winbox; wait for it to leave teal.
  await page.mouse.dblclick(rect.x + 58, rect.y + I3Y + 10);
  await waitNotPixel(500, 300, TEAL, 90000);     // freetype startup is slow
  check('double-click launched term (window composited)', true);

  // wmctl from VT1: the desktop layer tracks the LIVE screen (EV_SCREEN
  // recreate on the VT2-entry resize) and sits at the bottom of z.
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => window.__osOut.split('\n').some(l => l.trim().endsWith('desktop')), { timeout: 20000, polling: 200 });
  const dline = await page.evaluate(() => window.__osOut.split('\n').find(l => l.trim().endsWith('desktop')));
  check('desktop layer recreated at the live screen size (EV_SCREEN)',
    dline.includes(`${SW}x${SH}+0+0`), { dline, SW, SH });
  check('desktop layer at the bottom of z', dline.split('\t')[4] === '0', dline);
  await setVt(2);

  // Minimize term via its taskbar button (button 1, right of winbox's):
  // the desktop shows through where the window was.
  await clickAt(200, BARY);
  await waitPixel(500, 300, TEAL);
  check('minimize reveals the desktop', true);

  // The shell stays healthy behind the desktop (menu spawns are reaped —
  // no zombie pileup would show here, but the VT1 round-trip proves the
  // system is still driveable).
  await setVt(1);
  await page.keyboard.type('echo SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('SHELL-OK'), { timeout: 20000, polling: 200 });
  check('VT1 shell alive after menu driving', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos shell (browser): PASS' : `\nos shell (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
