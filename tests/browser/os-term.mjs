// 0020 browser acceptance: the wasm terminal (/bin/term) in the real page —
// launch from the xterm shell, hush-on-a-pty renders through freetype into
// an shm surface composited on the desktop canvas. Asserts: window + chrome
// pixels, rendered text (bright-pixel counts over the client), typing into
// the FOCUSED terminal window through the real key path (canvas -> kernel
// ring -> SDL -> pty -> hush echo -> re-render), wmctl sees it, SE drag-
// resize reflows (todos/0019 renegotiation + TIOCSWINSZ), close box ends
// the session, shell survives.
//
// Usage: node os-term.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3197;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch();
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

  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  // Rendered-text metric: bright pixels (glyph cores) in a canvas region.
  const bright = (x, y, w, h) => page.evaluate(([rx, ry, rw, rh]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) n++;
    return n;
  }, [x, y, w, h]);
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
  const waitBright = async (x, y, w, h, min, ms) => {
    const t0 = Date.now();
    for (;;) {
      const n = await bright(x, y, w, h);
      if (n >= min) return n;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`region (${x},${y},${w},${h}) never reached ${min} bright px; last ${n}`);
      await new Promise(r => setTimeout(r, 300));
    }
  };

  const TEAL = [0, 128, 128], NAVY = [0, 0, 128], BLACK = [0, 0, 0];
  // The WM places the first window at (12,36); term is 640x432 (80x24).
  const TX = 12, TY = 36, TW = 640, TH = 432;

  // VTs (todos/0022): shell typing on VT1, canvas pixels/input on VT2 (the
  // compositor may idle while its placeholder canvas is hidden). Deep VT
  // coverage lives in os-vt.mjs.
  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);

  await page.keyboard.type('term &\r');
  await setVt(2);
  await waitPixel(TX + 320, TY + 300, BLACK, 90000);   // client fill composited
  check('term window composited (black client)', true);
  check('focused title bar navy', near(await sample(TX + 300, TY - 12), NAVY), await sample(TX + 300, TY - 12));
  await waitBright(TX, TY, TW, 60, 50, 60000);          // hush banner + prompt
  check('freetype text rendered (banner region has glyph pixels)', true);

  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // Type INTO the terminal window: client click focuses it (kernel hit
  // test), then keys ride canvas -> ring -> SDL -> pty -> hush echo.
  await page.mouse.click(rect.x + TX + 320, rect.y + TY + 300);
  const before = await bright(TX, TY, TW, TH);
  await page.keyboard.type('echo BROWSER-TERM-OK\r');
  const after = await (async () => {
    const t0 = Date.now();
    for (;;) {
      const n = await bright(TX, TY, TW, TH);
      if (n > before + 100) return n;
      if (Date.now() - t0 > 30000) return n;
      await new Promise(r => setTimeout(r, 300));
    }
  })();
  check('typed command echoed + rendered (bright pixels grew)', after > before + 100, `${before} -> ${after}`);

  // wmctl from the system shell sees the terminal window.
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => /\tterm/.test(window.__osOut), { timeout: 20000, polling: 200 });
  check('wmctl list sees the term window', true);

  // SE drag-resize: 640x432 -> 500x260 (todos/0019 renegotiation; term
  // reflows the grid + TIOCSWINSZ). Outline preview, one configure at drop.
  await setVt(2);
  await page.mouse.move(rect.x + TX + TW + 2, rect.y + TY + TH + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + TX + 500, rect.y + TY + 260, { steps: 8 });
  await page.mouse.up();
  await waitPixel(TX + 550, TY + 100, TEAL, 30000);     // beyond the new width
  check('drag-resize shrank the window (desktop beyond new edge)', true);
  await waitBright(TX, TY, 500, 260, 30, 30000);
  check('reflowed terminal still renders text', true);

  // Close box -> SDL_EVENT_QUIT -> master close HUPs hush -> window gone.
  await page.mouse.click(rect.x + TX + 500 - 12, rect.y + TY - 12);
  await waitPixel(TX + 250, TY + 130, TEAL, 30000);
  check('close box ended the session; desktop restored', true);

  // The system shell survives.
  await setVt(1);
  await page.keyboard.type('echo TERM-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('TERM-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after the terminal session', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos term (browser): PASS' : `\nos term (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
