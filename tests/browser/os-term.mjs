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
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3197;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL);
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
  // The WM places the first window at (12,36); term is 640x486 (80x24 below
  // the 30px menu bar strip, todos/0273c — the grid band starts at TY+30).
  const TX = 12, TY = 36, TW = 640, TH = 486;

  // VTs (todos/0022): shell typing on VT1, canvas pixels/input on VT2 (the
  // compositor may idle while its placeholder canvas is hidden). Deep VT
  // coverage lives in os-vt.mjs.
  const { setVt } = osHelpers(page);

  await setVt(1);   // 0070: ready lands on VT2; launch from the tty
  await page.keyboard.type('term &\r');
  await setVt(2);
  // 0023: VT2 entry re-modes the screen to the viewport pane; wait for the
  // resized canvas commit so rect capture / pixel geometry below is stable.
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 200 });
  await waitPixel(TX + 320, TY + 300, BLACK, 90000);   // client fill composited
  check('term window composited (black client)', true);
  check('focused title bar navy', near(await sample(TX + 300, TY - 12), NAVY), await sample(TX + 300, TY - 12));
  await waitBright(TX, TY + 30, TW, 60, 50, 60000);     // hush banner + prompt (grid band — the bar above is uniformly bright)
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

  // Unicode input through the REAL page key path (gucOS Unicode Phase A —
  // W1/W2/W5). Playwright's keyboard.type sends non-US chars as insertText
  // (no keydown), so dispatch synthetic KeyboardEvents at the screen canvas
  // — the same listener hardware keys hit: os.html capture -> host.js
  // keysym (é as a BMP char, 😀 as a surrogate PAIR exercising the
  // codePointAt fix) -> ring -> term UTF-8-encode -> pty -> hush. The
  // redirected file, catted on VT1 (xterm renders UTF-8 natively), proves
  // the exact bytes end to end.
  const typeVt2 = (s) => page.evaluate((str) => {
    const scr = document.getElementById('screen');
    for (const ch of str) {   // for..of iterates CODE POINTS
      const key = ch === '\r' ? 'Enter' : ch;
      scr.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      scr.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
    }
  }, s);
  const uniBefore = await bright(TX, TY, TW, TH);
  await typeVt2('echo héllo€😀 >/tmp/uni.txt\r');
  const uniAfter = await (async () => {
    const t0 = Date.now();
    for (;;) {
      const n = await bright(TX, TY, TW, TH);
      if (n > uniBefore + 30) return n;
      if (Date.now() - t0 > 30000) return n;
      await new Promise(r => setTimeout(r, 300));
    }
  })();
  check('unicode echo rendered on VT2 (glyph pixels grew)', uniAfter > uniBefore + 30,
    `${uniBefore} -> ${uniAfter}`);
  await setVt(1);
  await page.keyboard.type('cat /tmp/uni.txt\r');
  await page.waitForFunction(() => window.__osOut.includes('héllo€😀'), { timeout: 20000, polling: 200 });
  check('typed é/€/😀 reached the app as correct UTF-8 (VT1 cat round-trip)', true);
  await setVt(2);

  // wmctl from the system shell sees the terminal window.
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => /\tterm/.test(window.__osOut), { timeout: 20000, polling: 200 });
  check('wmctl list sees the term window', true);

  // Menu bar (todos/0273c): the "menubar" strip child composites over the
  // top 30px; a bar click opens an engine dropdown — a REAL anchored child
  // titled "#32768" — and Esc (dispatched at the canvas: page.keyboard
  // focus is unreliable on VT2) dismisses it, both verified over VT1 wmctl.
  await setVt(2);
  check('menu bar strip composited (BTNFACE band over the client)',
    near(await sample(TX + 320, TY + 15), [192, 192, 192]), await sample(TX + 320, TY + 15));
  await page.mouse.click(rect.x + TX + 20, rect.y + TY + 15);   // "Shell"
  await setVt(1);
  await page.keyboard.type('wmctl wait win "#32768" && echo MENUOPEN-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('MENUOPEN-OK'), { timeout: 20000, polling: 200 });
  check('bar click opened the engine dropdown (anchored child "#32768")', true);
  await setVt(2);
  await page.evaluate(() => {
    const scr = document.getElementById('screen');
    scr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    scr.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
  });
  await setVt(1);
  await page.keyboard.type('wmctl wait nowin "#32768" && echo MENUGONE-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('MENUGONE-OK'), { timeout: 20000, polling: 200 });
  check('Esc dismissed the dropdown', true);
  await setVt(2);

  // SE drag-resize: 640x486 -> 500x260 (todos/0019 renegotiation; term
  // reflows the grid + TIOCSWINSZ). Outline preview, one configure at drop.
  await setVt(2);
  await page.mouse.move(rect.x + TX + TW + 2, rect.y + TY + TH + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + TX + 500, rect.y + TY + 260, { steps: 8 });
  await page.mouse.up();
  await waitPixel(TX + 550, TY + 100, TEAL, 30000);     // beyond the new width
  check('drag-resize shrank the window (desktop beyond new edge)', true);
  await waitBright(TX, TY + 30, 500, 230, 30, 30000);
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
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos term (browser): PASS' : `\nos term (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
