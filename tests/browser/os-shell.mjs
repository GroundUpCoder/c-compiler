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

  // The clock (todos/0031): right-aligned HH.MM — histogram the black
  // text pixels over the clock cell (exact digits depend on the time).
  const clockBlack = await page.evaluate(([x0, y0, w, h]) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) n++;
    return n;
  }, [SW - 45, SH - 20, 42, 12]);
  check('taskbar clock digits present (black-pixel histogram)', clockBlack >= 15, clockBlack);
  // The Start button face, right of the "START" label glyphs (x 8..38).
  check('Start button face at the taskbar left', near(await sample(44, BARY), FACE),
    await sample(44, BARY));

  // The baked /usr/share/menu entries, sorted (os/image.json — bump the
  // list when it gains an entry; the geometry below derives from it).
  // Rows are 20px + 4px pad, parked above the 28px taskbar (/etc/menu is
  // EMPTY on a virgin boot — todos/0040; the override leg below covers it).
  const MENU_ENTRIES = ['cairodemo', 'calc', 'ctldemo', 'ctlpanel', 'doom', 'fileman', 'gameboy', 'gdidemo',
                        'gpubox', 'notepad', 'quake', 'sameboy', 'snake', 'term', 'winbox', 'winmine'];
  const MENU_H = 2 * 4 + MENU_ENTRIES.length * 20;
  const MENU_Y = SH - 28 - MENU_H;
  const WINBOX_ROW_Y = 4 + MENU_ENTRIES.indexOf('winbox') * 20 + 10;
  check('menu spot is desktop before the click', near(await sample(120, MENU_Y + 74), TEAL),
    await sample(120, MENU_Y + 74));
  // Map-on-placement (todos/0069): burst-capture frames THROUGH the open —
  // the menu must never composite at the kernel cascade default (the
  // top-left band; x<=432, y<=436 covers every sid-cascade placement of a
  // 150x188 menu) before appearing parked above the taskbar. In-page rAF
  // sampling gives per-frame granularity that CDP round trips can't. At
  // this point nothing face-gray is in the band (icons are white/navy,
  // text antialiasing blends toward teal), so any gray blob there IS a
  // teleporting window.
  const CASC_H = Math.min(460, MENU_Y - 10);
  const burst = page.evaluate(([px0, py0, ch]) => new Promise((resolve) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d', { willReadFrequently: true });
    const frames = [];
    let extra = 0;
    const grey = (d, i) => Math.abs(d[i] - 192) <= 8 &&
      Math.abs(d[i + 1] - 192) <= 8 && Math.abs(d[i + 2] - 192) <= 8;
    const step = () => {
      ctx.drawImage(c, 0, 0);
      const p = ctx.getImageData(px0, py0, 1, 1).data;
      const parked = grey(p, 0);
      const d = ctx.getImageData(0, 24, 460, ch - 24).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (grey(d, i)) n++;
      frames.push([parked ? 1 : 0, n]);
      if (parked) extra++;
      if (extra >= 5 || frames.length >= 600) return resolve(frames);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), [120, MENU_Y + 74, CASC_H]);
  await page.waitForTimeout(100);                // capture running first
  await clickAt(25, BARY);                       // Start (x < 50)
  const frames = await burst;
  check('Start click opens the menu (face fill above the taskbar)',
    frames.some(f => f[0] === 1), frames.length);
  const maxCasc = Math.max(...frames.map(f => f[1]));
  check('no first-frame teleport: nothing composited in the cascade band (todos/0069)',
    maxCasc < 300, { maxCasc, frames: frames.length });
  await waitPixel(120, MENU_Y + 74, FACE);       // settle for the hover leg

  // Hover the winbox entry (rows are 20px from MENU_Y+4): the Win95 navy
  // highlight tracks the pointer.
  await page.mouse.move(rect.x + 75, rect.y + MENU_Y + WINBOX_ROW_Y);
  await waitPixel(120, MENU_Y + WINBOX_ROW_Y, NAVY);
  check('entry hover highlights navy', true);

  // Select it: winbox spawns (the WM places its first window at 12,36),
  // the menu closes.
  await clickAt(75, MENU_Y + WINBOX_ROW_Y);
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

  // ---- /etc/menu override wins (todos/0040: first-existing-dir) ----
  // Create /etc/menu with a single entry; the next Start click must read
  // IT (150x28, one row) instead of the baked /usr/share/menu.
  await setVt(1);
  await page.keyboard.type('mkdir /etc/menu && ln -s /usr/bin/winbox /etc/menu/solo && echo MENU-SET\r');
  await page.waitForFunction(() => window.__osOut.includes('MENU-SET'), { timeout: 20000, polling: 200 });
  await setVt(2);
  // VT2 settle (HANDOFF rule): the entry resize re-lays the furniture —
  // wait for the taskbar and let the recreate finish before clicking.
  await waitPixel(400, BARY, FACE);
  await page.waitForTimeout(800);
  const SOLO_Y = SH - 28 - 28;                   // menu_h(1) = 28, above the bar
  await clickAt(25, BARY);
  await waitPixel(75, SOLO_Y + 14, FACE);
  check('override menu opens with ONE entry (/etc/menu wins)', true);
  check('the 7-entry region stays desktop (no union merge)',
    near(await sample(120, MENU_Y + 74), TEAL), await sample(120, MENU_Y + 74));
  await clickAt(25, BARY);                       // toggle closed
  await waitPixel(75, SOLO_Y + 14, TEAL);
  await setVt(1);
  await page.keyboard.type('rm -rf /etc/menu && echo MENU-RESET\r');
  await page.waitForFunction(() => window.__osOut.includes('MENU-RESET'), { timeout: 20000, polling: 200 });
  await setVt(2);
  check('override removed: back to the baked default', true);

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

  // Icons flow down the left edge, sorted (the seeded /root/Desktop —
  // bump the list with image.json, the kernel-e2e rule). The winbox
  // launched above covers rows 0-2; term's row is clear of it: white
  // 24x24 tile, navy center, label below. The label-strip sample at
  // x=45 relies on term's 4-char label starting at x=46 — pick a
  // SHORT-named entry if this ever moves.
  const DESK_ENTRIES = ['doom', 'drmario', 'gameboy', 'mario', 'pokemon',
                        'quake', 'term'];
  const TROW = DESK_ENTRIES.indexOf('term');
  const I3X = 46, I3Y = 16 + TROW * 64 + 6;      // term's icon tile origin
  await waitPixel(I3X + 2, I3Y + 2, WHITE);
  check(`desktop icon tile composited (term, cell ${TROW})`, true);
  check('icon glyph navy center', near(await sample(I3X + 12, I3Y + 12), NAVY),
    await sample(I3X + 12, I3Y + 12));

  // Single click: selection highlight (navy label strip), NO launch.
  await clickAt(58, I3Y + 10);
  await waitPixel(45, 16 + TROW * 64 + 24 + 10 + 3, NAVY);   // label bg, left of text
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
