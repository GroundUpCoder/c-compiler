// 0018 browser acceptance: quake windowed in the real OS page with the
// relative-mouse/pointer-lock surface flag. Boot os.html in headless
// Chromium (first boot compiles quake from vendor sources and lands the
// 18MB pak0.pak via the image.json `bin` entry), launch `quake &`, and
// assert the pointer-lock round trip on the live page:
//   quake's SDL_SetWindowRelativeMouseMode -> SURFACE_SET_FLAGS -> kernel
//   wanted-state -> {type:'pointer-lock'} to the page (__osPtrLockWanted);
//   a real mouse click into the CLIENT area re-offers the lock (the
//   kernel-hit-tested gesture — __osPtrLockOffers ticks) while a title-bar
//   drag does NOT (and still moves the window — absolute routing intact);
//   with the lock granted, locked moves flow as rel deltas and quake keeps
//   presenting; releasing reverts routing; a SE-grip drag is a no-op (quake
//   is fixed-res — no SDL_WINDOW_RESIZABLE, todos/0021); wmctl close quits
//   quake cleanly and withdraws the wanted state.
//
// CAVEAT: Chromium DENIES requestPointerLock under ALL Playwright-driven
// input (headless or headful, CDP clicks aren't OS-level gestures —
// WrongDocumentError; playwright#20956), so the GRANT itself cannot be
// automated. The test simulates it through the page's REAL bridge path
// (the same {kind:'lockchange'} wm-input a pointerlockchange fires), which
// exercises everything downstream of the browser's permission gate. The
// literal lock UX needs a human in a real browser once per change.
// The rel-delta data path itself (ring records -> SDL xrel/yrel -> IN_Move)
// is pinned headless in test_wm_e2e.js and test_os_apps_e2e.js.
//
// Usage: node os-quake.mjs
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready (quake + pak0.pak seeded)', true);
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  // VTs (todos/0022): shell typing on VT1, canvas pixels/input on VT2 (the
  // compositor may idle while its placeholder canvas is hidden). Deep VT
  // coverage lives in os-vt.mjs.
  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);

  // Region stats over the desktop canvas (os-doom.mjs shape).
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
  const waitFrame = async (reg, pred, ms) => {
    const t0 = Date.now();
    for (;;) {
      const s = await region(...reg);
      if (pred(s)) return s;
      if (Date.now() - t0 > ms) throw new Error('no frame: ' + JSON.stringify(s));
      await new Promise(r => setTimeout(r, 300));
    }
  };

  // First WM slot (12,36); quake's client is 320x200 native.
  const Q_REGION = [16, 40, 328, 232];
  await setVt(1);   // 0070: ready lands on VT2; launch from the tty
  await page.keyboard.type('quake &\r');
  await setVt(2);
  // 0023: VT2 entry re-modes the screen to the viewport pane; wait for the
  // resized canvas commit so rect capture / pixel geometry below is stable.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 200 });
  const first = await waitFrame(Q_REGION, s => s.colors > 50 && s.nonTeal > s.n * 0.9, 120000);
  check('quake composites a real frame (rich colors over the window region)',
    true, { colors: first.colors });

  // The flag round trip: quake asked for relative mouse at VID_Init; the
  // kernel told the page it wants the pointer lock.
  await page.waitForFunction(() => window.__osPtrLockWanted === true, { timeout: 20000, polling: 200 });
  check('kernel asked the page for the pointer lock (wanted state)', true);
  check('not locked before any gesture',
    (await page.evaluate(() => !!window.__osPtrLock)) === false);

  // A real mouse click into the CLIENT area: the kernel hit-tests it and
  // re-offers the lock to the page (the gesture path). Chromium denies the
  // actual grant under automation (see the header caveat), so assert the
  // OFFER — the whole kernel->page round trip — not the grant.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const offers0 = await page.evaluate(() => window.__osPtrLockOffers || 0);
  await page.mouse.click(rect.x + 12 + 160, rect.y + 36 + 100);
  await page.waitForFunction(o => (window.__osPtrLockOffers || 0) > o, offers0, { timeout: 10000, polling: 100 });
  check('client click re-offers the lock (kernel-hit-tested gesture)', true);

  // A title-bar drag must NOT re-offer — and must still move the window
  // (absolute routing; the 0018 "draggable when unlocked" acceptance line).
  const offers1 = await page.evaluate(() => window.__osPtrLockOffers || 0);
  await page.mouse.move(rect.x + 12 + 100, rect.y + 36 - 10);
  await page.mouse.down();
  await page.mouse.move(rect.x + 12 + 100 + 60, rect.y + 36 - 10 + 40, { steps: 8 });
  await page.mouse.up();
  check('title drag does not re-offer the lock',
    (await page.evaluate(() => window.__osPtrLockOffers || 0)) === offers1);

  // Grant the lock through the page's real bridge path (what a
  // pointerlockchange fires) and drive locked moves: rel deltas to quake,
  // which must keep presenting (the locked-input path must not wedge it).
  await page.evaluate(() => kernel.postMessage({ type: 'wm-input', ev: { kind: 'lockchange', active: true } }));
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => kernel.postMessage({ type: 'wm-input', ev: { kind: 'move', locked: 1, dx: 6, dy: -2, buttons: 0 } }));
    await new Promise(r => setTimeout(r, 30));
  }
  const sigs = new Set();
  for (let i = 0; i < 4; i++) {
    sigs.add((await region(...Q_REGION)).h);
    await new Promise(r => setTimeout(r, 1200));
  }
  check('quake animates while locked-moves flow (distinct frame signatures)', sigs.size >= 2, sigs.size);

  // Release (the ESC path fires the same lockchange) — absolute routing back.
  await page.evaluate(() => kernel.postMessage({ type: 'wm-input', ev: { kind: 'lockchange', active: false } }));
  check('wanted state persists after unlock (a client click re-locks)',
    (await page.evaluate(() => window.__osPtrLockWanted)) === true);

  // Read the dragged geometry via the shell.
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => {
    const m = window.__osOut.match(/(\d+)x(\d+)\+(\d+)\+(\d+)\t-\t\d+\tf..r-\tQuake/);
    return m && +m[3] === 72 && +m[4] === 76;
  }, { timeout: 20000, polling: 200 }).then(
    () => check('title drag moved the window while unlocked (wmctl list geometry + r flag)', true),
    async () => check('title drag moved the window while unlocked (wmctl list geometry + r flag)',
      false, await page.evaluate(() => window.__osOut.slice(-500))));

  // Fixed-res + viewport scaling (todos/0021 + 0024): quake has no
  // SDL_WINDOW_RESIZABLE (the '-' after 'r' above), so a drag on the SE
  // frame grip SCALES its dst rect instead of configuring — the wm answers
  // the EV_SCALE_REQ with an aspect fit of the (400,260) box: 1.25x ->
  // DST 400x250, buffer geometry untouched at 320x200+72+76 (the app
  // keeps rendering its native software resolution, oblivious).
  await setVt(2);
  await page.mouse.move(rect.x + 72 + 320 + 2, rect.y + 76 + 200 + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + 72 + 320 + 82, rect.y + 76 + 200 + 62, { steps: 6 });
  await page.mouse.up();
  await setVt(1);
  await page.keyboard.type('echo GRIP-DONE && wmctl list\r');
  await page.waitForFunction(() => {
    const i = window.__osOut.indexOf('GRIP-DONE');
    return i >= 0 && /320x200\+72\+76\t400x250\t\d+\tf..r-\tQuake/.test(window.__osOut.slice(i));
  }, { timeout: 20000, polling: 200 }).then(
    () => check('SE grip drag scales fixed-res quake (aspect-fit dst, buffer untouched — todos/0024)', true),
    async () => check('SE grip drag scales fixed-res quake (aspect-fit dst, buffer untouched — todos/0024)',
      false, await page.evaluate(() => window.__osOut.slice(-500))));

  // Clean quit via the WM close request.
  await page.keyboard.type('wmctl close $(wmctl list | grep "Quake$" | sed "s/[^0-9].*//")\r');
  await setVt(2);
  // "Restored" tolerates the 0029 desktop-icon pixels (this region holds
  // three icon cells, ~3% of it) — only the WINDOW must be gone.
  await waitFrame([16, 40, 328, 232], s => s.nonTeal < s.n * 0.05, 30000);
  check('wmctl close quit quake; desktop restored', true);
  check('lock request withdrawn when quake died',
    (await page.evaluate(() => window.__osPtrLockWanted)) === false);
  await setVt(1);
  await page.keyboard.type('echo QUAKE-GONE-$?\r');
  await page.waitForFunction(() => window.__osOut.includes('QUAKE-GONE-0'), { timeout: 20000, polling: 200 });
  check('shell alive after quake exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos quake (browser): PASS' : `\nos quake (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
