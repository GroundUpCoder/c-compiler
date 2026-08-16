// SDL gamepad browser acceptance (#607): boot the reference OS page in
// headless Chromium and drive /usr/bin/padbox through the REAL page-side
// chain — os.html's Gamepad API poller (rAF, page-side diff, W3C->SDL
// mapping) -> wm-input postMessage -> kernel pad registry -> input ring ->
// veneer events — using a synthetic Gamepad API double installed by
// addInitScript at the substrate boundary (navigator.getGamepads + the
// gamepadconnected trigger event).
//
// ⚠ HONESTY BOUNDARY (the ticket's acceptance note): this double is a TEST
// DOUBLE of the browser API, not a physical controller. Everything from
// os.html inward is really exercised; the browser's own pad enumeration and
// user-gesture gating are NOT — that leg needs a human with a real pad on
// /bin/padbox. Do not read a green here as the real-pad acceptance.
//
// Proves:
//   - gamepadconnected arms the poller (window.__osPadPolling probe) and a
//     standard-mapping pad reaches padbox as GAMEPAD_ADDED
//   - button press/release round-trips (stdout lines + the lit button
//     square in padbox's rendered frame — the full visual path)
//   - stick and analog-trigger (W3C button 6 value -> SDL axis 4) motion
//     deliver with page-side i16 quantization
//   - hot-unplug delivers REMOVED and the poller disarms (rAF loop stops
//     when the browser reports no pads — the IDLE-POWER discipline)
//
// Usage: node os-gamepad.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl, near } from './lib/os-harness.mjs';

const PORT = 3241;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  // The substrate double, installed before any page script runs.
  await page.addInitScript(() => {
    const pads = [null];
    const mk = (idx, id) => ({
      index: idx, id, mapping: 'standard', connected: true,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      axes: [0, 0, 0, 0],
      timestamp: 0,
    });
    window.__padDouble = {
      connect(idx, id) {
        pads[idx] = mk(idx, id);
        const e = new Event('gamepadconnected');
        e.gamepad = pads[idx];
        window.dispatchEvent(e);
      },
      disconnect(idx) {
        const gp = pads[idx];
        pads[idx] = null;
        const e = new Event('gamepaddisconnected');
        e.gamepad = gp;
        window.dispatchEvent(e);
      },
      setButton(idx, b, pressed, value) {
        const gp = pads[idx];
        gp.buttons[b] = { pressed, touched: pressed, value: value != null ? value : (pressed ? 1 : 0) };
        gp.timestamp++;
      },
      setAxis(idx, a, v) { pads[idx].axes[a] = v; pads[idx].timestamp++; },
    };
    Object.defineProperty(Navigator.prototype, 'getGamepads', {
      configurable: true,
      value: () => pads.slice(),
    });
  });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt } = osHelpers(page);
  await setVt(1);
  await page.keyboard.type('padbox &\r');
  // padbox's own ready line is the launch marker (tty output probe).
  await page.waitForFunction(() => window.__osOut.includes('padbox: ready'), { timeout: 60000, polling: 'raf' });
  check('padbox launched', true);
  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    const s = window.__osScreen;
    return s && Math.abs(r.width - s.w) < 2 && Math.abs(r.height - s.h) < 2;
  }, { timeout: 30000, polling: 'raf' });

  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);

  // Wait for padbox's field (render-clear 24,24,32) at the WM's first slot
  // (client origin (12,36), the pollball geometry) before pixel legs.
  const WX = 12, WY = 36;
  {
    const t0 = Date.now();
    for (;;) {
      const c = await sample(WX + 340, WY + 200);   // clear-color corner, no widgets
      if (near(c, [24, 24, 32], 10)) break;
      if (Date.now() - t0 > 90000) throw new Error(`padbox field never composited; last ${c}`);
      await new Promise(r => setTimeout(r, 250));
    }
  }
  check('padbox composited', true);

  // ---- connect: poller arms, ADDED reaches the app ----
  await page.evaluate(() => window.__padDouble.connect(0, 'Playwright Test Pad'));
  await page.waitForFunction(() => window.__osPadPolling === true, { timeout: 10000, polling: 'raf' });
  check('gamepadconnected armed the page poller', true);
  await page.waitForFunction(() => window.__osOut.includes('padbox: added id=1'), { timeout: 15000, polling: 'raf' });
  check('ADDED reached padbox through the full chain', true);

  // ---- button: stdout line + the lit SOUTH square (visual path) ----
  await page.evaluate(() => window.__padDouble.setButton(0, 0, true));
  await page.waitForFunction(() => window.__osOut.includes('padbox: button a 1 id=1'), { timeout: 15000, polling: 'raf' });
  check('button press delivered (W3C 0 -> SDL SOUTH)', true);
  {
    const t0 = Date.now();
    let c;
    for (;;) {
      c = await sample(WX + 18, WY + 18);           // SOUTH square center
      if (near(c, [80, 220, 80], 16)) break;
      if (Date.now() - t0 > 20000) throw new Error(`SOUTH square never lit; last ${c}`);
      await new Promise(r => setTimeout(r, 200));
    }
    check('pressed button lights in the rendered frame', true);
  }
  await page.evaluate(() => window.__padDouble.setButton(0, 0, false));
  await page.waitForFunction(() => window.__osOut.includes('padbox: button a 0 id=1'), { timeout: 15000, polling: 'raf' });
  check('button release delivered', true);

  // ---- stick + analog trigger (page-side i16 quantization) ----
  await page.evaluate(() => window.__padDouble.setAxis(0, 0, 0.5));
  await page.waitForFunction(() => window.__osOut.includes('padbox: axis leftx 16384 id=1'), { timeout: 15000, polling: 'raf' });
  check('stick axis delivered (0.5 -> 16384)', true);
  await page.evaluate(() => window.__padDouble.setButton(0, 6, true, 0.75));
  await page.waitForFunction(() => window.__osOut.includes('padbox: axis lefttrigger 24575 id=1'), { timeout: 15000, polling: 'raf' });
  check('analog trigger delivered (W3C button 6 -> SDL axis 4, 0.75 -> 24575)', true);

  // ---- hot-unplug: REMOVED + poller disarm ----
  await page.evaluate(() => window.__padDouble.disconnect(0));
  await page.waitForFunction(() => window.__osOut.includes('padbox: removed id=1'), { timeout: 15000, polling: 'raf' });
  check('hot-unplug delivered REMOVED', true);
  await page.waitForFunction(() => window.__osPadPolling === false, { timeout: 10000, polling: 'raf' });
  check('poller disarmed with no pads left (IDLE-POWER)', true);

  // ---- OS still alive ----
  await setVt(1);
  await page.keyboard.type('echo PAD""OK\r');
  await page.waitForFunction(() => window.__osOut.includes('PADOK'), { timeout: 15000, polling: 'raf' });
  check('shell still answers', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
console.log(state.failures === 0 ? '\nos gamepad (browser): PASS' : `\nos gamepad (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
