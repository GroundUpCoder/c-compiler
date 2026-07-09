// user32 browser acceptance (todos/0058, design todos/WIN32.md): boot the
// reference OS page in headless Chromium, launch the seeded /bin/ctldemo
// from the shell, and drive the Win32 controls through the REAL input
// path — page mouse clicks and keyboard — plus the agent tree (`wmctl
// click`, no pixels) from the shell. Asserts the Win95 control rendering
// composits (BTNFACE chrome, white edit/listbox wells) at the exact
// coordinates os/win32/ctldemo.c lays out (the headless twin,
// tests/kernel/test_user32_e2e.js, drives the same layout via wmctl).
//
// Usage: node os-user32.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3199;
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
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut.includes(n), needle, { timeout: ms || 30000, polling: 200 });

  const TEAL = [0, 128, 128], WHITE = [255, 255, 255], BTNFACE = [192, 192, 192];

  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });

  // Launch the seeded user32 demo from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('ctldemo &\r');
  await waitOut('ctldemo: ready', 60000);
  check('classic GetMessage loop reaches ready in-browser', true);
  await setVt(2);

  // The WM places the first window at (12,36); layout coordinates below
  // mirror os/win32/ctldemo.c WM_CREATE — change together.
  const WX = 12, WY = 36;
  const at = (x, y) => [WX + x, WY + y];
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (x, y) => page.mouse.click(rect.x + WX + x, rect.y + WY + y);

  await waitPixel(...at(440, 150), BTNFACE, 60000);
  check('BTNFACE class background composited', true);
  check('single-line EDIT well white', near(await sample(...at(166, 22)), WHITE), await sample(...at(166, 22)));
  check('LISTBOX well white', near(await sample(...at(100, 100)), WHITE), await sample(...at(100, 100)));
  check('multiline EDIT well white', near(await sample(...at(100, 220)), WHITE), await sample(...at(100, 220)));
  // Control text renders: the STATIC "Name:" band carries non-BTNFACE ink.
  let ink = null;
  for (let x = 14; x < 60 && !ink; x += 2) {
    const p = await sample(...at(x, 22));
    if (!near(p, BTNFACE, 12)) ink = p;
  }
  check('STATIC label ink composited', ink !== null, ink);
  // Button raised edge: Add's top-left pixel is BTNHIGHLIGHT white.
  check('button raised 3D edge', near(await sample(...at(268, 10)), WHITE), await sample(...at(268, 10)));

  // REAL input path: type into the edit (page keyboard -> kernel ring ->
  // WM_CHAR), then a real mouse click on Greet. SETTLE around the VT
  // switch and between input gestures (the HANDOFF sweep rule) — the
  // first post-switch gesture raced the bridge once.
  await new Promise(r => setTimeout(r, 500));
  await clickAt(166, 22);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.type('Hi', { delay: 40 });
  await new Promise(r => setTimeout(r, 300));
  await clickAt(336 + 30, 10 + 12);
  await waitOut("ctldemo: WM_COMMAND Greet name='Hi' verbose=0", 60000);
  check('mouse click + typed text reach WM_COMMAND', true);

  // The agent path from the in-OS shell: no pixels anywhere.
  await setVt(1);
  await page.keyboard.type('wmctl click About\r');
  await waitOut('ctldemo: about-opening');
  await setVt(2);
  // The modal MessageBox cascades to (40,60); its face is BTNFACE.
  await waitPixel(40 + 100, 60 + 40, BTNFACE, 30000);
  check('MessageBox modal composited', true);
  await setVt(1);
  await page.keyboard.type('wmctl click OK\r');
  await waitOut('ctldemo: msgbox=1');
  check('wmctl click OK dismisses the modal -> IDOK', true);
  await setVt(2);

  // Quit via a real mouse click; desktop restored, shell alive.
  await clickAt(388 + 38, 284 + 13);
  await waitOut('ctldemo: bye');
  await waitPixel(...at(240, 180), TEAL);
  check('Quit button exits the app; desktop restored', true);

  await setVt(1);
  await page.keyboard.type('echo U32-SHELL-OK\r');
  await waitOut('U32-SHELL-OK', 20000);
  check('shell alive after ctldemo exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  try {
    const pages = browser.contexts()[0] ? browser.contexts()[0].pages() : [];
    if (pages[0]) {
      const tail = await pages[0].evaluate(() => (window.__osOut || '').slice(-1200));
      console.error('--- __osOut tail ---\n' + tail);
    }
  } catch {}
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos user32 (browser): PASS' : `\nos user32 (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
