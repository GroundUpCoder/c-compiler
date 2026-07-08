// WM browser acceptance (todos/WM.md + todos/0014): boot the reference OS
// page in headless Chromium, launch the seeded /bin/winbox from the shell,
// and drive its WINDOW through the real UI-bridge path — canvas mouse/
// keyboard -> kernel hit-test/rings -> SDL app — asserting composited
// pixels on the desktop canvas at every step (window fill, kernel chrome,
// click paint, key toggle, title-bar drag, border drag-resize with the
// SURFACE_CONFIGURE renegotiation (todos/0019), close box). With 0014 the
// autostarted /bin/wm is part of the scene: the borderless taskbar strip,
// WM (not kernel) placement, taskbar-button minimize/restore, and wmctl
// from the shell.
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
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  // VTs (todos/0022): boot lands on VT1 (tty); the desktop is VT2 and only
  // one is visible. Shell typing happens on VT1, canvas pixels/input on VT2
  // (the compositor may idle while its placeholder canvas is hidden, so
  // pixel waits on VT1 could stall on stale frames). Deep VT coverage lives
  // in os-vt.mjs.
  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);

  // Sample composited pixels off the (transferred) desktop canvas. Size the
  // temp canvas from the LAYOUT rect: with 0023 the screen tracks the
  // viewport, and the placeholder's intrinsic size follows the worker's
  // OffscreenCanvas commits (don't trust the stale width/height attributes).
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

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], GREEN = [0, 200, 80],
        NAVY = [0, 0, 128], WHITE = [255, 255, 255], BLACK = [0, 0, 0],
        FACE = [192, 192, 192], FACE_DOWN = [222, 222, 222];

  await setVt(2);
  // Dynamic screen resolution (todos/0023): VT2 entry resizes the screen to
  // the viewport pane. Wait for the worker's canvas commit to catch up, then
  // derive all screen-edge geometry from the LIVE size.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  check('VT2 screen tracks the viewport pane (todos/0023)', SW > 800 && SH > 500, { SW, SH });
  check('desktop teal before any window', near(await sample(SW - 20, SH - 60), TEAL), await sample(SW - 20, SH - 60));

  // 0014: the autostarted /bin/wm parks its borderless taskbar at the
  // bottom edge (strip y in [SH-28, SH)) — with 0023 it RE-LAYS there on
  // the VT2-entry resize (EV_SCREEN -> destroy + recreate at the new width).
  const BARY = SH - 14;                          // mid-strip sample row
  await waitPixel(400, BARY, FACE, 60000);
  check('taskbar strip composited (wm autostart)', true);
  await waitPixel(SW - 40, BARY, FACE, 30000);
  check('taskbar spans the RESIZED screen width (EV_SCREEN re-lay)', true);
  check('taskbar is borderless (no chrome band above it)',
    near(await sample(400, SH - 32), TEAL), await sample(400, SH - 32));

  // Launch the seeded windowed app from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);

  // The WM (not the kernel cascade) places the first window at (12,36).
  const WX = 12, WY = 36, WW = 240, WH = 160;
  await waitPixel(WX + 120, WY + 80, ORANGE, 60000);
  check('winbox window composited (orange fill)', true);
  await waitPixel(WX - 7, WY - 7, TEAL);         // clear of the resize frame (0019)
  check('WM placement settled (kernel cascade spot vacated)', true);
  check('white app border', near(await sample(WX + 2, WY + 2), WHITE), await sample(WX + 2, WY + 2));
  // Sample chrome AWAY from the title text and the close-box 'x' glyph.
  check('focused title bar navy', near(await sample(WX + 150, WY - 12), NAVY), await sample(WX + 150, WY - 12));
  // Close box rect: x in [WX+WW-20, WX+WW-4), y in [WY-20, WY-4); sample its
  // top-right corner, clear of the black 'x' glyph.
  check('close box present', near(await sample(WX + WW - 6, WY - 18), [192, 192, 192]), await sample(WX + WW - 6, WY - 18));

  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);

  // 0014: winbox has a taskbar button (button 0, sunken while focused);
  // clicking it minimizes, clicking again restores — the wm's policy loop
  // driven through its OWN surface's input ring. Button 0 sits right of
  // the Start button since todos/0028 (x in [56, 160)).
  await waitPixel(100, BARY, FACE_DOWN);
  check('taskbar button sunken while winbox focused', true);
  await clickAt(100, BARY);                      // minimize
  await waitPixel(WX + 120, WY + 80, TEAL);
  check('taskbar click minimized winbox (window off screen)', true);
  await clickAt(100, BARY);                      // restore
  await waitPixel(WX + 120, WY + 80, ORANGE);
  check('taskbar click restored winbox', true);

  // Click inside the client: kernel hit test -> ring -> SDL -> black paint
  // at the LOCAL point.
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

  // Drag-resize (todos/0019): grab the SE frame corner (the WM_BORDER band
  // just outside the client), drag +60/+40 — Win95 outline preview during
  // the drag, ONE configure at release; winbox re-derives its surface and
  // redraws, the ack swaps the kernel buffer. 240x160 -> 300x200.
  await page.mouse.move(rect.x + NX + WW + 2, rect.y + NY + WH + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + NX + WW + 62, rect.y + NY + WH + 42, { steps: 8 });
  await page.mouse.up();
  const RW = WW + 60, RH = WH + 40;
  await waitPixel(NX + RW - 20, NY + RH - 20, GREEN);
  check('drag-resize: client re-rendered at 300x200', true);
  check('new white border at the new right edge',
    near(await sample(NX + RW - 2, NY + 100), WHITE), await sample(NX + RW - 2, NY + 100));
  check('area beyond the old width is client now',
    near(await sample(NX + WW + 20, NY + 80), GREEN), await sample(NX + WW + 20, NY + 80));
  check('frame border flanks the resized client',
    near(await sample(NX + RW + 2, NY + 100), FACE), await sample(NX + RW + 2, NY + 100));

  // Maximize (todos/0025): double-click the title bar — kernel detects the
  // gesture (EV_TITLE_ACTIVATE), /bin/wm answers with MOVE + RESIZE to the
  // work area (screen minus taskbar, client top below the kernel title
  // bar): winbox re-renders at SW x (SH - 56), position (0, 28).
  await page.mouse.dblclick(rect.x + NX + 100, rect.y + NY - 12);
  const MW = SW, MH = SH - 56;                   // wm.c work area (BAR_H + TITLE_H)
  await waitPixel(MW - 30, 28 + MH - 30, GREEN, 30000);
  check('title double-click maximized winbox to the work area', true);
  check('maximized fill reaches the left edge (client at x=0)',
    near(await sample(10, 200), GREEN), await sample(10, 200));
  check('maximized title bar spans the top', near(await sample(300, 16), NAVY), await sample(300, 16));
  check('taskbar still visible below the maximized window',
    near(await sample(400, BARY), FACE) || near(await sample(400, BARY), FACE_DOWN),
    await sample(400, BARY));
  // Double-click again -> restore to the EXACT pre-maximize geometry
  // (NX, NY, 300x200). The maximized title bar sits at y in [4, 28).
  await page.mouse.dblclick(rect.x + 300, rect.y + 16);
  await waitPixel(NX + RW - 20, NY + RH - 20, GREEN, 30000);
  check('second double-click restored the saved geometry', true);
  await waitPixel(MW - 30, 28 + MH - 30, TEAL);
  check('the maximized area is desktop again', true);
  check('restored frame at the restored edge',
    near(await sample(NX + RW + 2, NY + 100), FACE), await sample(NX + RW + 2, NY + 100));

  // Close box -> SDL_EVENT_QUIT -> app exits -> window gone.
  await clickAt(NX + RW - 12, NY - 12);
  await waitPixel(NX + 120, NY + 80, TEAL);
  check('close box quit the app; desktop restored', true);

  // ... and its taskbar button is gone (EV_DESTROYED -> wm model -> redraw).
  await waitPixel(100, BARY, FACE);
  check('taskbar button removed after close', true);

  // The shell survives its windowed child (background job reaped). Back to
  // VT1 — the switch refocuses the terminal.
  await setVt(1);
  await page.keyboard.type('echo WM-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('WM-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after windowed app exits', true);

  // 0014: wmctl from the shell, in the browser — one op set, everywhere.
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => window.__osOut.includes('taskbar'), { timeout: 20000, polling: 200 });
  check('wmctl list from the in-browser shell sees the taskbar', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos wm (browser): PASS' : `\nos wm (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
