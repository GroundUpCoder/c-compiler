// 0015 browser acceptance: the seeded vendor apps run windowed in the real
// OS page. Boot os.html in headless Chromium (first boot compiles doom,
// gameboy and snake from vendor sources and lands doom1.wad + a ROM via the
// image.json `bin` entries), launch `doom &` from the shell, and assert on
// composited desktop pixels: a real rendered frame, the attract demo
// animating (present loop pumping), keyboard reaching the app (Escape opens
// the DOOM menu while the title screen is otherwise static), and a clean
// quit via the WM close request (wmctl close — the same SDL_EVENT_QUIT the
// close box would deliver; the literal close-box click is covered by
// os-wm.mjs). Then the same lifecycle, shorter, for gameboy with the
// seeded ROM.
//
// DOOM presents at native 640x400 (no CPU pre-scale since todos/0024 made
// fixed-size windows compositor-scalable); the window fits the desktop.
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
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  // The audio mixer (todos/0017): the kernel handed the page its output
  // ring at boot; playback is gated on the first user gesture.
  check('audio output ring reached the page',
    (await page.evaluate(() => window.__osAudio)) === 'ready');

  // VTs (todos/0022): shell typing on VT1, canvas pixels/input on VT2 (the
  // compositor may idle while its placeholder canvas is hidden). Deep VT
  // coverage lives in os-vt.mjs.
  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);

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

  // The WM places the first window at (12,36); DOOM's client is 640x400
  // (native res, unscaled dst) — sample inside it with a small margin.
  const DOOM_REGION = [16, 40, 648, 432];
  const GB_REGION = [16, 40, 488, 464];
  const waitFrame = async (reg, pred, ms) => {
    const t0 = Date.now();
    for (;;) {
      const s = await region(...reg);
      if (pred(s)) return s;
      if (Date.now() - t0 > ms) throw new Error('no frame: ' + JSON.stringify(s));
      await new Promise(r => setTimeout(r, 300));
    }
  };

  // Baseline the idle desktop FIRST (icon grid included): "desktop restored"
  // after each app close asserts the region hash returns to this signature,
  // so the assert derives from the live icon grid instead of hardcoding an
  // icon-pixel allowance that breaks whenever /root/Desktop gains an entry
  // (the 758dd6e ROM launchers pushed the old 2% tolerance over the line).
  await setVt(2);
  // 0023: VT2 entry re-modes the screen to the viewport pane; wait for the
  // resized canvas commit so rect capture / pixel geometry below is stable.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 200 });
  // Settle: the re-mode re-lays the desktop (0023) — wait for icons to be
  // painted and two consecutive identical snapshots before baselining.
  const stableRegion = async (reg) => {
    for (let last = null, t0 = Date.now();;) {
      const s = await region(...reg);
      if (last && s.h === last.h && s.colors >= 2) return s;
      if (Date.now() - t0 > 30000) throw new Error('no stable baseline: ' + JSON.stringify(s));
      last = s;
      await new Promise(r => setTimeout(r, 400));
    }
  };
  const baseDoom = await stableRegion(DOOM_REGION);
  const baseGb = await stableRegion(GB_REGION);
  await setVt(1);

  await page.keyboard.type('doom &\r');
  await setVt(2);
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

  // Sound (todos/0017): the click above was the resume gesture; with the
  // receiver draining, the mixer's output writePos advances while doom's
  // music plays (kernel-side mix -> page-owned ring, end to end).
  check('audio resumed on the gesture',
    (await page.evaluate(() => window.__osAudio)) === 'playing');
  const wposAt = () => page.evaluate(() =>
    new Int32Array(window.__osAudioSab, 0, 4)[0]);
  const w0 = await wposAt();
  await new Promise(r => setTimeout(r, 1500));
  const w1 = await wposAt();
  check('mixer output advances while doom plays (music mixed + consumed)',
    w1 !== w0, { w0, w1 });

  // wmctl from the in-browser shell sees the window; close it — the WM close
  // request delivers SDL_EVENT_QUIT and doom exits cleanly.
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => window.__osOut.includes('DOOM Shareware'), { timeout: 20000, polling: 200 });
  check('wmctl list from the shell shows DOOM Shareware', true);
  await page.keyboard.type('wmctl close $(wmctl list | grep "DOOM Shareware$" | sed "s/[^0-9].*//")\r');
  await setVt(2);
  // "Restored" = the region returns to the pre-launch baseline signature
  // (icon grid and all) — only the WINDOW must be gone, not the icons.
  await waitFrame(DOOM_REGION, s => s.h === baseDoom.h, 30000);
  check('wmctl close quit doom; desktop restored', true);
  await setVt(1);
  await page.keyboard.type('echo DOOM-GONE-$?\r');
  await page.waitForFunction(() => window.__osOut.includes('DOOM-GONE-0'), { timeout: 20000, polling: 200 });
  check('shell alive after doom exits', true);

  // Gameboy with the seeded ROM: cascade slot 2 (doom took slot 1), 480x432
  // client — LCD frames in the visible region, then the same clean close.
  await page.keyboard.type(GB_CMD + '\r');
  await setVt(2);
  const gb = await waitFrame(GB_REGION, s => s.colors >= 2 && s.nonTeal > s.n * 0.9, 60000);
  check('gameboy composites LCD frames' +
    (HAVE_ROM ? ' (ROM from /root/roms)' : ' (built-in test ROM; local ROM absent)'),
    true, { colors: gb.colors });
  await setVt(1);
  await page.keyboard.type('wmctl close $(wmctl list | grep "Peanut-GB$" | sed "s/[^0-9].*//")\r');
  await setVt(2);
  await waitFrame(GB_REGION, s => s.h === baseGb.h, 30000);   // icons stay (0029)
  check('wmctl close quit gameboy; desktop restored', true);
  await setVt(1);
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
