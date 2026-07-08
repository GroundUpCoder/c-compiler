// 0022 browser acceptance: VT switching, Linux-console semantics — the xterm
// tty is VT1, the desktop VT2; os.html shows exactly one at a time. Boot must
// land on VT1 with the tty full-page; the Terminal/Desktop TAB BAR is the
// primary affordance, with Ctrl+Alt+F1/F2 (and the Ctrl+Alt+1/2 alias) as
// the hotkey path — both flip between them. VT1 entry refocuses (and
// re-fits) xterm, VT2 entry focuses the canvas. The rationale
// under test is availability under partial failure: VT1's path is kernel
// worker + xterm only, so the shell must stay fully usable mid-app (doom
// running) and after the wm service is killed (kernel-chrome fallback).
// A halt (pid 1 exit) must force VT1 so the notice is visible.
//
// Everyday-driving coverage of the split (shell on VT1, canvas on VT2) rides
// along in os-wm/os-doom/os-quake/os-gpubox/os-term; this test owns the VT
// semantics themselves.
//
// Usage: node os-vt.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3198;
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
  check('boots to ready', true);
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const vtState = () => page.evaluate(() => ({
    vt: window.__osVt,
    termVisible: document.getElementById('terminal').offsetParent !== null,
    termHeight: document.getElementById('terminal').clientHeight,
    desktopVisible: document.getElementById('desktop').offsetParent !== null,
    canvasFocused: document.activeElement === document.getElementById('screen'),
    innerHeight: window.innerHeight,
  }));
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut && window.__osOut.includes(n), needle,
    { timeout: ms || 20000, polling: 200 });

  // ---- Boot lands on VT1: tty full-page, desktop hidden.
  let s = await vtState();
  check('boot lands on VT1', s.vt === 1, s);
  check('VT1: tty visible full-page, desktop hidden',
    s.termVisible && !s.desktopVisible && s.termHeight > 0.8 * s.innerHeight, s);
  // The quote-split keeps the needle out of the command's own tty echo, so
  // the wait proves shell OUTPUT, not just the echo path.
  await page.keyboard.type("echo VT1-O''K\r");
  await waitOut('VT1-OK');
  check('shell usable on VT1', true);

  // ---- Ctrl+Alt+F2 -> VT2: desktop visible, canvas focused.
  await page.keyboard.press('Control+Alt+F2');
  s = await vtState();
  check('Ctrl+Alt+F2 switches to VT2', s.vt === 2, s);
  check('VT2: desktop visible, tty hidden, canvas focused',
    s.desktopVisible && !s.termVisible && s.canvasFocused, s);

  // Desktop is live on VT2: teal wallpaper + the wm's taskbar strip.
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
  const TEAL = [0, 128, 128], FACE = [192, 192, 192];
  await waitPixel(780, 440, TEAL, 60000);
  await waitPixel(400, 486, FACE, 60000);
  check('VT2 desktop composites (teal wallpaper + wm taskbar)', true);

  // ---- Ctrl+Alt+F1 -> back to VT1; the switch refocuses the tty.
  await page.keyboard.press('Control+Alt+F1');
  s = await vtState();
  check('Ctrl+Alt+F1 switches back to VT1', s.vt === 1 && s.termVisible && !s.desktopVisible, s);
  await page.keyboard.type("echo BACK-O''K\r");
  await waitOut('BACK-OK');
  check('shell regains keyboard focus on VT1 entry', true);

  // ---- Mid-app: doom runs on VT2 while VT1 keeps a working shell.
  const region = (x0, y0, x1, y1) => page.evaluate(([a, b, c, d]) => {
    const cv = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = cv.width; t.height = cv.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const img = ctx.getImageData(a, b, c - a, d - b).data;
    let h = 2166136261 >>> 0, nonTeal = 0, n = 0;
    const colors = new Set();
    for (let i = 0; i < img.length; i += 16) {
      const col = (img[i] << 16) | (img[i + 1] << 8) | img[i + 2];
      h ^= col; h = Math.imul(h, 16777619) >>> 0;
      colors.add(col); n++;
      if (col !== 0x008080) nonTeal++;
    }
    return { h, colors: colors.size, nonTeal, n };
  }, [x0, y0, x1, y1]);
  const DOOM_REGION = [16, 40, 784, 464];
  const waitFrame = async (reg, pred, ms) => {
    const t0 = Date.now();
    for (;;) {
      const st = await region(...reg);
      if (pred(st)) return st;
      if (Date.now() - t0 > ms) throw new Error('no frame: ' + JSON.stringify(st));
      await new Promise(r => setTimeout(r, 300));
    }
  };

  await page.keyboard.type('doom &\r');
  // Switch via the tab bar this time (the primary, clickable path).
  await page.click('#vt2tab');
  s = await vtState();
  check('Desktop tab reaches VT2', s.vt === 2 && s.desktopVisible, s);
  const first = await waitFrame(DOOM_REGION, st => st.colors > 50 && st.nonTeal > st.n * 0.9, 90000);
  check('doom composites on VT2', true, { colors: first.colors });

  // Back to the tty MID-APP — the shell must work while doom runs hidden.
  await page.keyboard.press('Control+Alt+F1');
  await page.keyboard.type("echo MID-APP-O''K\r");
  await waitOut('MID-APP-OK');
  check('VT1 shell usable while doom runs on hidden VT2', true);

  // Return (via the Ctrl+Alt+2 alias): desktop intact, doom still animating.
  await page.keyboard.press('Control+Alt+2');
  s = await vtState();
  check('Ctrl+Alt+2 alias reaches VT2', s.vt === 2, s);
  await waitFrame(DOOM_REGION, st => st.colors > 50 && st.nonTeal > st.n * 0.9, 30000);
  const sigA = (await region(...DOOM_REGION)).h;
  const t0 = Date.now();
  let animated = false;
  while (!animated && Date.now() - t0 < 20000) {
    await new Promise(r => setTimeout(r, 1200));
    animated = (await region(...DOOM_REGION)).h !== sigA;
  }
  check('desktop intact on return: doom still animating', animated);

  // ---- The failure-mode rationale: kill the wm service; VT1 still switches
  // and the shell works (the wmctl endpoint is the KERNEL's; kernel-chrome
  // is the fallback policy).
  await page.keyboard.press('Control+Alt+F1');
  await page.keyboard.type('WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")\r');
  await page.keyboard.type("kill $WMPID && sleep 0.5 && echo ==post''kill && wmctl list && echo WMCTL-A''LIVE\r");
  await waitOut('WMCTL-ALIVE', 30000);
  const postKill = await page.evaluate(() => {
    const out = window.__osOut;
    return out.slice(out.lastIndexOf('==postkill'));
  });
  check('wm killed: kernel wmctl endpoint still serves, taskbar gone',
    !/taskbar/.test(postKill), postKill.slice(0, 200));

  await page.keyboard.press('Control+Alt+F2');
  s = await vtState();
  check('VT2 still reachable after wm death', s.vt === 2 && s.desktopVisible, s);
  await waitFrame(DOOM_REGION, st => st.colors > 50 && st.nonTeal > st.n * 0.9, 30000);
  check('doom still composited under kernel-chrome fallback', true);

  await page.click('#vt1tab');   // the Terminal tab (primary affordance)
  s = await vtState();
  check('Terminal tab returns to VT1', s.vt === 1 && s.termVisible, s);
  await page.keyboard.type("echo POST-WM-O''K\r");
  await waitOut('POST-WM-OK');
  check('shell alive after wm death (maintenance mode works)', true);

  // ---- Halt forces VT1 (the notice lives on the tty). Park on VT2 and
  // drive `exit` through the kernel's input channel — the page-side probe
  // path; xterm focus is on the hidden VT1 so typing can't reach it.
  await page.keyboard.press('Control+Alt+F2');
  await page.evaluate(() => kernel.postMessage({ type: 'input', data: 'exit 3\r' }));
  await page.waitForFunction(() => window.__osState === 'halted:3', { timeout: 30000, polling: 250 });
  s = await vtState();
  check('halt forces VT1 (escape hatch surfaces the notice)', s.vt === 1 && s.termVisible, s);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos vt (browser): PASS' : `\nos vt (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
