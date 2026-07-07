// 0015 browser acceptance: the seeded vendor apps run windowed in the real
// OS page. Boot os.html in headless Chromium (first boot compiles doom,
// gameboy and snake from vendor sources and lands doom1.wad + a ROM via the
// image.json `bin` entries), launch `doom &` from the shell, and assert on
// composited desktop pixels: a real rendered frame, the attract demo
// animating (present loop pumping), keyboard reaching the app (Escape opens
// the DOOM menu while the title screen is otherwise static), and a clean
// quit via the WM close request (wmctl close — the same SDL_EVENT_QUIT the
// clipped-off-screen close box would deliver; the literal close-box click is
// covered by os-wm.mjs). Then the same lifecycle, shorter, for gameboy with
// the seeded ROM.
//
// DOOM's 1280x800 window overflows the 800x500 desktop by design — the
// kernel clips; we only sample the visible region.
//
// Usage: node os-doom.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// The ROMs are gitignored (optional image.json entries) — without one
// locally, gameboy's built-in test ROM keeps the lifecycle test running.
const HAVE_ROM = fs.existsSync(path.join(ROOT, 'vendor/gameboy/roms/PokemonBlue.gb'));
const GB_CMD = HAVE_ROM ? 'gameboy /root/roms/PokemonBlue.gb &' : 'gameboy &';
const PORT = 3194;
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready (doom/gameboy/snake + game data seeded)', true);

  // Region stats over the desktop canvas: FNV hash (order-sensitive) +
  // distinct-color count + non-desktop coverage of a sample grid.
  const region = (x0, y0, x1, y1) => page.evaluate(([a, b, c, d]) => {
    const cv = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = cv.width; t.height = cv.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const img = ctx.getImageData(a, b, c - a, d - b).data;
    let h = 2166136261 >>> 0, nonTeal = 0, n = 0;
    const colors = new Set();
    for (let i = 0; i < img.length; i += 16) {           // every 4th pixel
      const col = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      h ^= col; h = Math.imul(h, 16777619) >>> 0;
      colors.add(col); n++;
      if (col !== 0x008080) nonTeal++;                   // teal desktop
    }
    return { h, colors: colors.size, nonTeal, n };
  }, [x0, y0, x1, y1]);

  // The WM places the first window at (12,36); DOOM's client is 1280x800,
  // clipped to the visible x<800, y<472 (taskbar strip below).
  const DOOM_REGION = [16, 40, 784, 464];
  const waitFrame = async (reg, pred, ms) => {
    const t0 = Date.now();
    for (;;) {
      const s = await region(...reg);
      if (pred(s)) return s;
      if (Date.now() - t0 > ms) throw new Error('no frame: ' + JSON.stringify(s));
      await new Promise(r => setTimeout(r, 300));
    }
  };

  await page.keyboard.type('doom &\r');
  const first = await waitFrame(DOOM_REGION,
    s => s.colors > 50 && s.nonTeal > s.n * 0.9, 90000);
  check('doom composites a real frame (rich colors over the window region)',
    true, { colors: first.colors });

  // Keyboard reaches the app: click into the window (focus follows, and the
  // canvas takes DOM keyboard focus), then Escape. On the static title
  // screen the menu overlay is the only change source; if the attract demo
  // already started the hash changes anyway — either way keys must land.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await page.mouse.click(rect.x + 400, rect.y + 250);
  const before = await region(...DOOM_REGION);
  await page.keyboard.press('Escape');
  await waitFrame(DOOM_REGION, s => s.h !== before.h, 10000);
  check('Escape reached doom (frame changed: menu overlay / demo tick)', true);

  // The attract demo / title sequence animates — the present loop is pumping.
  const sigs = new Set();
  for (let i = 0; i < 5; i++) {
    sigs.add((await region(...DOOM_REGION)).h);
    await new Promise(r => setTimeout(r, 1200));
  }
  check('doom animates (distinct frame signatures over ~6s)', sigs.size >= 2, sigs.size);

  // wmctl from the in-browser shell sees the window; close it — the WM close
  // request delivers SDL_EVENT_QUIT and doom exits cleanly.
  await page.click('#terminal');
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => window.__osOut.includes('DOOM Shareware'), { timeout: 20000, polling: 200 });
  check('wmctl list from the shell shows DOOM Shareware', true);
  await page.keyboard.type('wmctl close $(wmctl list | grep "DOOM Shareware$" | sed "s/[^0-9].*//")\r');
  await waitFrame(DOOM_REGION, s => s.nonTeal === 0, 30000);
  check('wmctl close quit doom; desktop restored', true);
  await page.keyboard.type('echo DOOM-GONE-$?\r');
  await page.waitForFunction(() => window.__osOut.includes('DOOM-GONE-0'), { timeout: 20000, polling: 200 });
  check('shell alive after doom exits', true);

  // Gameboy with the seeded ROM: first-slot placement (12,36), 480x432
  // client — LCD frames in the visible region, then the same clean close.
  const GB_REGION = [16, 40, 488, 464];
  await page.keyboard.type(GB_CMD + '\r');
  const gb = await waitFrame(GB_REGION, s => s.colors >= 2 && s.nonTeal > s.n * 0.9, 60000);
  check('gameboy composites LCD frames' +
    (HAVE_ROM ? ' (ROM from /root/roms)' : ' (built-in test ROM; local ROM absent)'),
    true, { colors: gb.colors });
  await page.keyboard.type('wmctl close $(wmctl list | grep "Peanut-GB$" | sed "s/[^0-9].*//")\r');
  await waitFrame(GB_REGION, s => s.nonTeal === 0, 30000);
  check('wmctl close quit gameboy; desktop restored', true);
  await page.keyboard.type('echo GB-GONE-$?\r');
  await page.waitForFunction(() => window.__osOut.includes('GB-GONE-0'), { timeout: 20000, polling: 200 });
  check('shell alive after gameboy exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos doom (browser): PASS' : `\nos doom (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
