// 0095 browser acceptance: Aero Snap with a real mouse and keyboard. The
// seeded /bin/winbox (resizable, orange fill) is the app: dragging its title
// bar to the top edge raises the translucent snap preview (0063 alpha,
// composited by the WebGPU pass) and maximizes at the drop; dragging a
// snapped window away restores its floating size; the left edge tiles to the
// left half; Win+arrow (Meta in the browser) reproduces the tiling from the
// keyboard — the kernel chord, EV_SNAP_KEY, wm.c policy. Geometry asserts
// ride `wmctl list` typed on VT1; pixels are sampled on VT2 (derive from the
// LIVE canvas rect — never 800x500 constants).
//
// Usage: node os-snap.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3226;
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
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut && window.__osOut.includes(n), needle,
    { timeout: ms || 20000, polling: 200 });

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
        PREV_FILL = [80, 168, 168];              // 0x50 white over teal (0063)

  // VT2 + the 0023 settle; live geometry only.
  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const BAR = 28, TH = 28;                       // wm.c metrics
  const WORKH = SH - BAR - TH;
  const HALFW = Math.floor(SW / 2);

  // Launch the resizable app; the WM places the first window at (12,36).
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);
  const WX = 12, WY = 36, WW = 240, WH = 160;
  await waitPixel(WX + 120, WY + 80, ORANGE, 60000);
  check('winbox composited (orange fill)', true);
  await waitPixel(WX + 100, WY + WH + 30, TEAL);   // placement + shadow settled
  check('WM placement settled', true);

  // ---- drag the title to the TOP edge: preview mid-drag, maximize at drop.
  // Sample the preview clear of the dragged window (parked at the top
  // middle) and of the desktop icon column on the left.
  await page.mouse.move(rect.x + WX + 100, rect.y + WY - 12);
  await page.mouse.down();
  await page.mouse.move(rect.x + Math.floor(SW / 2), rect.y + 2, { steps: 12 });
  const pv = await waitPixel(SW - 100, Math.floor(SH / 2), PREV_FILL, 15000);
  check('translucent snap preview visible mid-drag (exact 0063 src-over)', true, pv);
  await page.mouse.up();
  await waitPixel(SW - 100, Math.floor(SH / 2), ORANGE, 30000);   // maximized fill
  check('top-edge drop maximized (orange fills the work area)', true);
  check('preview gone at the drop; title bar spans the top',
    near(await sample(Math.floor(SW / 2), TH - 12), [0, 0, 128]),
    await sample(Math.floor(SW / 2), TH - 12));

  // ---- drag the maximized window off the edge: floating size restores.
  await page.mouse.move(rect.x + 300, rect.y + TH - 12);
  await page.mouse.down();
  await page.mouse.move(rect.x + 400, rect.y + 300, { steps: 10 });
  await page.mouse.up();
  await waitPixel(SW - 100, Math.floor(SH / 2), TEAL, 30000);
  check('drag-off restored the floating size (work area is desktop again)', true);

  // ---- drag to the LEFT edge: left-half tile.
  // The window dropped at (100, 314-ish): grab its title live via wmctl.
  await setVt(1);
  await page.keyboard.type('WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")\r');
  await page.keyboard.type("wmctl list | grep winbox$ && echo ROW1-O''K\r");
  await waitOut('ROW1-OK');
  const row1 = await page.evaluate(() => {
    const lines = window.__osOut.split('\n').filter(l => /winbox\s*$/.test(l));
    return lines[lines.length - 1] || '';
  });
  const g1 = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(row1.split('\t')[2] || '');
  check('drag-off geometry: floating 240x160 at the drop point', !!g1 &&
    g1[1] === '240' && g1[2] === '160', { row1 });
  const FX = g1 ? parseInt(g1[3]) : 100, FY = g1 ? parseInt(g1[4]) : 300;
  await setVt(2);
  await page.mouse.move(rect.x + FX + 100, rect.y + FY - 12);
  await page.mouse.down();
  await page.mouse.move(rect.x + 2, rect.y + Math.floor(SH / 2), { steps: 12 });
  await page.mouse.up();
  await waitPixel(HALFW - 30, TH + WORKH - 30, ORANGE, 30000);
  check('left-edge drop tiled to the left half (orange at the half\'s bottom-right)', true);
  check('right of the half is desktop (clear of the 0063 shadow)',
    near(await sample(HALFW + 40, Math.floor(SH / 2)), TEAL),
    await sample(HALFW + 40, Math.floor(SH / 2)));

  // ---- Win+arrow from the keyboard (Meta in the browser): right half,
  // then maximize, then restore — the chord path (0090 pacing: explicit
  // down/gap/press/gap/up). The Meta keydown itself is NOT swallowed (only
  // the arrows are, by design — the kernel never eats plain modifiers), and
  // winbox toggles its fill on any keydown: each chord flips orange<->green.
  const chord = async (key) => {
    await page.keyboard.down('Meta');
    await new Promise(r => setTimeout(r, 60));
    await page.keyboard.press(key, { delay: 50 });
    await new Promise(r => setTimeout(r, 60));
    await page.keyboard.up('Meta');
  };
  await chord('ArrowRight');
  await waitPixel(SW - 40, TH + 40, GREEN, 30000);   // toggle 1: green
  check('Win+Right tiles to the right half', true);
  check('left half is desktop again (clear of the shadow)',
    near(await sample(HALFW - 40, Math.floor(SH / 2)), TEAL),
    await sample(HALFW - 40, Math.floor(SH / 2)));
  await chord('ArrowUp');
  await waitPixel(150, Math.floor(SH / 2), ORANGE, 30000);   // toggle 2: orange
  check('Win+Up maximizes', true);
  await chord('ArrowDown');
  await waitPixel(SW - 100, Math.floor(SH / 2), TEAL, 30000);
  check('Win+Down restores the floating window', true);

  // The agent view: geometry from the shell confirms the restore.
  await setVt(1);
  await page.keyboard.type("wmctl list | grep winbox$ && echo ROW2-O''K\r");
  await waitOut('ROW2-OK');
  const row2 = await page.evaluate(() => {
    const lines = window.__osOut.split('\n').filter(l => /winbox\s*$/.test(l));
    return lines[lines.length - 1] || '';
  });
  check('restored geometry is the saved floating rect (240x160)',
    /240x160\+/.test(row2.split('\t')[2] || ''), { row2 });

  await page.keyboard.type("echo SNAP-SHELL-O''K\r");
  await waitOut('SNAP-SHELL-OK');
  check('shell alive after the snap run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos snap (browser): PASS' : `\nos snap (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
