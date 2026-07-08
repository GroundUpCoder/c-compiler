// 0024 browser acceptance: viewport scaling of fixed-size clients. The
// seeded `winbox fixed` (title "fixbox", no SDL_WINDOW_RESIZABLE) is the
// app: dragging its frame corner rubber-bands and, at release, the kernel
// asks /bin/wm (EV_SCALE_REQ) which answers with an aspect-preserving,
// integer-snapped SET_DST — the window scales on screen while the app keeps
// rendering its 240x160 buffer, oblivious. Asserts: the scaled composite
// (fill, borders, chrome track the dst rect), inverse-mapped input (a click
// inside the scaled area paints at the right BUFFER point, composited back
// at the right SCREEN point), keyboard focus, wmctl scale/list from the
// shell, resize-refusal, unscale, and the close box at 1x.
//
// Usage: node os-scale.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3218;
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
        NAVY = [0, 0, 128], WHITE = [255, 255, 255], BLACK = [0, 0, 0],
        FACE = [192, 192, 192];

  // VT2 + the 0023 settle: derive geometry from the live screen (HANDOFF
  // gotcha — never 800x500 constants; the canvas rect shifts as it fills
  // the pane).
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
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);

  // Launch the fixed-size app; the WM places the first window at (12,36).
  await setVt(1);
  await page.keyboard.type('winbox fixed &\r');
  await setVt(2);
  const WX = 12, WY = 36, WW = 240, WH = 160;
  await waitPixel(WX + 120, WY + 80, ORANGE, 60000);
  check('fixbox window composited (orange fill)', true);
  await waitPixel(WX - 7, WY - 7, TEAL);           // wm placement settled
  check('WM placement settled', true);

  // Drag the SE frame corner out to a ~(500,330) box. The wm answers the
  // EV_SCALE_REQ with an aspect fit: min(500/240, 330/160) = 2.0625, which
  // integer-snaps to exactly 2x -> dst 480x320.
  await page.mouse.move(rect.x + WX + WW + 2, rect.y + WY + WH + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + WX + WW + 2 + 260, rect.y + WY + WH + 2 + 170, { steps: 8 });
  await page.mouse.up();
  const DW = 480, DH = 320;                        // the snapped 2x dst
  await waitPixel(WX + 400, WY + 250, ORANGE);
  check('frame drag scaled the window (aspect fit, snapped to 2x)', true);
  check('white app border scaled to the dst edge (4 buffer px -> 8 screen px)',
    near(await sample(WX + DW - 5, WY + 150), WHITE), await sample(WX + DW - 5, WY + 150));
  check('chrome frame tracks the dst rect', near(await sample(WX + DW + 2, WY + 150), FACE),
    await sample(WX + DW + 2, WY + 150));
  check('title bar spans the dst width', near(await sample(WX + 400, WY - 12), NAVY),
    await sample(WX + 400, WY - 12));
  check('right of the scaled window is desktop', near(await sample(WX + DW + 10, WY + 150), TEAL),
    await sample(WX + DW + 10, WY + 150));

  // Input inverse-maps: a click at screen (+100,+100) is buffer (50,50);
  // the black 8x8 buffer mark composites back around the SAME screen point.
  await clickAt(WX + 100, WY + 100);
  await waitPixel(WX + 100, WY + 100, BLACK);
  check('click inside the scaled client painted at the inverse-mapped point', true);
  check('the mark is scaled too (2x: 8 buffer px -> 16 screen px)',
    near(await sample(WX + 106, WY + 106), BLACK) && near(await sample(WX + 120, WY + 100), ORANGE),
    [await sample(WX + 106, WY + 106), await sample(WX + 120, WY + 100)]);

  // Keyboard still routes (focus followed the click).
  await page.keyboard.press('g');
  await waitPixel(WX + 400, WY + 250, GREEN);
  check('key toggled the fill green across the scaled area', true);

  // The agent view from the shell: DST column + refusals + unscale.
  await setVt(1);
  await page.keyboard.type('FSID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")\r');
  await page.keyboard.type("wmctl list | grep fixbox$ && echo LIST-O''K\r");
  await waitOut('LIST-OK');
  const row = await page.evaluate(() => {
    const lines = window.__osOut.split('\n').filter(l => /fixbox\s*$/.test(l));
    return lines[lines.length - 1] || '';
  });
  check('wmctl list: buffer geometry intact + DST 480x320', /240x160\+/.test(row) && /\t480x320\t/.test(row), { row });
  await page.keyboard.type("wmctl resize $FSID 300 200 || echo RESIZE-R''EFUSED\r");
  await waitOut('RESIZE-REFUSED');
  check('wmctl resize refused on the fixed-size window', true);
  await page.keyboard.type("wmctl scale $FSID 240 160 && echo UNSCALE-O''K\r");
  await waitOut('UNSCALE-OK');
  await setVt(2);
  await waitPixel(WX + 400, WY + 250, TEAL);
  check('wmctl scale back to 1x: the scaled area is desktop again', true);
  await waitPixel(WX + 120, WY + 80, GREEN);
  check('window renders at 1x (green fill intact)', true);

  // Maximize (todos/0025) on a FIXED-SIZE window: the title double-click
  // dispatches to the 0024 scale-to-fit — aspect-fit dst into the work
  // area (SW x SH-56), centered, buffer untouched. Mirror wm.c's fit: the
  // 15% integer snap applies only if it does NOT overflow the work area.
  const WORKW = SW, WORKH = SH - 56;
  let fs = Math.min(WORKW / WW, WORKH / WH);
  const fsnap = Math.round(fs);
  if (fsnap >= 1 && fs >= fsnap * 0.85 && fs <= fsnap * 1.15 &&
      WW * fsnap <= WORKW && WH * fsnap <= WORKH) fs = fsnap;
  const FDW = Math.floor(WW * fs + 0.5), FDH = Math.floor(WH * fs + 0.5);
  const FX = Math.floor((WORKW - FDW) / 2), FY = 28 + Math.floor((WORKH - FDH) / 2);
  await page.mouse.dblclick(rect.x + WX + 100, rect.y + WY - 12);
  await waitPixel(Math.round(FX + FDW / 2), Math.round(FY + FDH / 2), GREEN, 30000);
  check('title double-click maximized the fixed window (centered scale-to-fit)', true);
  check('maximized title bar above the dst', near(await sample(FX + 100, FY - 12), NAVY),
    await sample(FX + 100, FY - 12));
  if (FY + FDH + 10 < SH - 30)                     // room for a letterbox stripe?
    check('letterboxed: desktop below the fitted dst',
      near(await sample(Math.round(FX + FDW / 2), FY + FDH + 10), TEAL),
      await sample(Math.round(FX + FDW / 2), FY + FDH + 10));
  // Inverse-mapped input still lands right while maximized: click the dst
  // center -> buffer (120, 80) -> the mark composites back at the center.
  await clickAt(Math.round(FX + FDW / 2), Math.round(FY + FDH / 2));
  await waitPixel(Math.round(FX + FDW / 2), Math.round(FY + FDH / 2), BLACK);
  check('click at the maximized center painted at the inverse-mapped point', true);
  // Double-click again -> restore: pre-max dst (1x) at the saved spot.
  await page.mouse.dblclick(rect.x + FX + 100, rect.y + FY - 12);
  await waitPixel(Math.round(FX + FDW / 2), Math.round(FY + FDH / 2), TEAL, 30000);
  check('second double-click restored: maximized area is desktop again', true);
  check('window back at 1x at the saved spot',
    near(await sample(WX + 60, WY + 40), GREEN), await sample(WX + 60, WY + 40));
  check('frame back at the 1x edge', near(await sample(WX + WW + 2, WY + 80), FACE),
    await sample(WX + WW + 2, WY + 80));

  // Close box at 1x geometry.
  await clickAt(WX + WW - 12, WY - 12);
  await waitPixel(WX + 120, WY + 80, TEAL);
  check('close box quit the app', true);

  await setVt(1);
  await page.keyboard.type("echo SCALE-SHELL-O''K\r");
  await waitOut('SCALE-SHELL-OK');
  check('shell alive after the scale run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos scale (browser): PASS' : `\nos scale (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
