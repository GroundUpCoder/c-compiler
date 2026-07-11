// 0096 browser acceptance: the screensaver with a real mouse and keyboard.
// A short ~/.config/screensaver timeout is written on VT1; on VT2, leaving
// the mouse alone for the interval raises the marquee saver — the desktop
// goes black and the banner animates (successive pixel-row samples differ)
// — and one mouse move dismisses it back to the teal desktop with the idle
// clock reset (no immediate re-raise). `wmctl saver` (the Control Panel
// Preview event) raises it on demand, and a KEY dismisses that one.
//
// Gotchas honored: geometry from the LIVE canvas rect (never 800x500
// constants); typed-echo markers use the split-quote trick; VT1 typing is
// tty input, NOT wm input — the config write itself doesn't feed the idle
// clock, so the post-switch mouse jiggle is what arms a known-fresh idle
// interval.
//
// Usage: node os-saver.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3234;
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
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitOut, waitScreen } = osHelpers(page);
  // One horizontal row of pixels, decimated — the marquee animation probe.
  const sampleRow = (y) => page.evaluate((sy) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, sy, t.width, 1).data;
    const out = [];
    for (let x = 0; x < t.width; x += 4) out.push(d[x * 4]);
    return out.join(',');
  }, y);
  const waitPixel = async (x, y, want, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (near(got, want)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) never became ${want}; last ${got}`);
      await new Promise(r => setTimeout(r, 250));
    }
  };

  const TEAL = [0, 128, 128], BLACK = [0, 0, 0];

  // ---- a short-timeout marquee config, typed on VT1 (the desktop tab is
  // the default after ready, todos/0070 — switch first; the settle keeps
  // the ready auto-switch from racing this one) ----
  await setVt(1);
  await new Promise(r => setTimeout(r, 800));
  await setVt(1);
  await page.keyboard.type('mkdir -p /root/.config\r', { delay: 20 });
  await new Promise(r => setTimeout(r, 800));    // let the prompt return
  await page.keyboard.type("printf 'saver marquee\\ntimeout 4\\ntext HELLO\\n' > /root/.config/screensaver && echo CFG-O''K\r", { delay: 20 });
  await waitOut('CFG-OK');
  check('config written (marquee, 4s timeout)', true);

  // ---- VT2 + the 0023 settle ----
  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const BAR = 28;
  const DX = SW - 120, DY = SH - BAR - 150;      // bare desktop, right side,
                                                 // clear of the icon column
  // VT1 typing is tty input, invisible to the wm's idle clock: jiggle the
  // mouse ONCE to stamp it, then leave it alone for the 4s interval. The
  // jiggle also dismisses a saver that raised during the settle.
  await page.mouse.move(rect.x + DX, rect.y + DY);
  await page.mouse.move(rect.x + DX + 10, rect.y + DY);
  await waitPixel(DX, DY, TEAL, 15000);
  check('desktop teal before the idle interval', true);

  // ---- idle: the marquee raises (black screen, banner animating) ----
  await waitPixel(DX, DY, BLACK, 20000);
  check('idle past the timeout covers the desktop black', true);
  check('the taskbar is covered too (top-layer over the +1 bar)',
    near(await sample(Math.floor(SW / 2), SH - BAR / 2), BLACK),
    await sample(Math.floor(SW / 2), SH - BAR / 2));
  {
    const midY = Math.floor(SH / 2) + 14;        // inside the banner band
    const t0 = Date.now();
    let moved = false, a = await sampleRow(midY);
    while (Date.now() - t0 < 8000) {
      await new Promise(r => setTimeout(r, 400));
      const b = await sampleRow(midY);
      if (b !== a) { moved = true; break; }
      a = b;
    }
    check('the marquee animates (center row changes between samples)', moved);
  }

  // ---- one mouse move dismisses; the desktop returns; no re-raise ----
  await page.mouse.move(rect.x + DX - 30, rect.y + DY);
  await waitPixel(DX, DY, TEAL, 15000);
  check('mouse motion dismisses the saver back to the desktop', true);
  await new Promise(r => setTimeout(r, 2000));   // < timeout: must stay teal
  check('no immediate re-raise (the waking input reset the idle clock)',
    near(await sample(DX, DY), TEAL), await sample(DX, DY));

  // ---- the gesture path: wmctl saver raises it now; a KEY dismisses ----
  await setVt(1);
  await page.keyboard.type("wmctl saver && echo SVR-O''K\r", { delay: 20 });
  await waitOut('SVR-OK');
  await setVt(2);
  await waitPixel(DX, DY, BLACK, 15000);
  check('wmctl saver (the ctlpanel Preview event) raises it on demand', true);
  await page.keyboard.press('Space', { delay: 60 });
  await waitPixel(DX, DY, TEAL, 15000);
  check('a key press dismisses it (the saver holds focus)', true);

  // ---- the shell stayed healthy ----
  await setVt(1);
  await page.keyboard.type("echo SAVER-SHELL-O''K\r", { delay: 20 });
  await waitOut('SAVER-SHELL-OK');
  check('shell alive after the saver run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  if (state.failures) {
    try {
      const pages = browser.contexts().flatMap(c => c.pages());
      if (pages[0]) console.error('[__osOut tail] ' +
        JSON.stringify(await pages[0].evaluate(() => window.__osOut.slice(-800))));
    } catch {}
  }
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos saver (browser): PASS' : `\nos saver (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
