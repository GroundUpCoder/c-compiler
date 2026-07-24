// /bin/deck browser acceptance (todos/0284): the gucOS slide presenter
// through the real compositor.
//
//   - the SEEDED demo deck (/usr/share/deck/gucos.deck) launches, SELF-
//     MAXIMIZES to the (dynamic) work area, and renders: title-slide
//     glyph ink, then the arch diagram's box fill after an arrow-key nav
//   - THE LIVE-RELOAD LEG (the reload-safety contract, design §1.2):
//     overwrite the deck from the shell -> the new content composites
//     (waitPixel is the marker — no sleeps); overwrite with BROKEN JSON
//     -> the red error banner rises over the LAST-GOOD slide (held, not
//     blanked); a good save recovers and the banner drops
//   - q quits; the desktop restores
//
// The headless twin (tests/kernel/test_deck_e2e.js) asserts the same
// contract off `wmctl shot`; this leg proves the compositor path.
//
// Usage: node os-deck.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3274;
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

  const { setVt, sample, near, waitPixel, waitOut, waitScreen } = osHelpers(page);
  const TEAL = [0, 128, 128];

  await setVt(2);
  await waitScreen();
  const scr = await page.evaluate(() => window.__osScreen);

  // deck self-maximizes ASYNCHRONOUSLY after its window appears — reading
  // the geometry without this wait races the WM's MOVE+RESIZE (the kernel
  // e2e waits the same way). Work area = screen - 36 taskbar - 28 title.
  // Split-needle marker so the typed echo can't satisfy its own wait.
  async function waitMaxed(title, tag) {
    await setVt(1);
    await page.keyboard.type(
      `wmctl wait win "${title}" >/dev/null; ` +
      `wmctl wait dim $(wmctl list | grep "${title}" | sed "s/[^0-9].*//") ` +
      `${scr.w}x${scr.h - 64} && echo MAX""ED-${tag}\r`);
    await waitOut(`MAXED-${tag}`, 30000);
    await setVt(2);
  }

  // Window geometry off `wmctl list` via the tty (placement is policy, not
  // a constant) — the os-present.mjs pattern.
  async function windowPos(title) {
    await setVt(1);
    await page.keyboard.type(`wmctl wait win "${title}" >/dev/null; wmctl list | grep "${title}"\r`);
    await page.waitForFunction(
      (t) => new RegExp('\\d+x\\d+\\+\\d+\\+\\d+[^\\n]*' + t).test(window.__osOut),
      title, { timeout: 30000, polling: 200 });
    const out = await page.evaluate(() => window.__osOut);
    const matches = [...out.matchAll(/(\d+)x(\d+)\+(\d+)\+(\d+)/g)];
    const m = matches[matches.length - 1];
    await setVt(2);
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  }
  // Map deck-logical coords into canvas px through the aspect-fit rect.
  const fitMap = (p, dw, dh) => {
    const s = Math.min(p.w / dw, p.h / dh);
    const xoff = (p.w - dw * s) / 2, yoff = (p.h - dh * s) / 2;
    return { s, at: (lx, ly) => [Math.round(p.x + xoff + lx * s),
                                 Math.round(p.y + yoff + ly * s)],
             fitH: dh * s, yoff };
  };

  /* ---- the seeded demo deck ---- */
  await setVt(1);
  await page.keyboard.type('deck /usr/share/deck/gucos.deck &\r');
  await waitMaxed('deck: gucos.deck', 'demo');
  const dp = await windowPos('deck: gucos.deck');

  // self-maximize: the window spans the live work area (dynamic screen —
  // 0023: derive from __osScreen, never constants)
  check('self-maximized to the work area',
    dp.w === scr.w && dp.h === scr.h - 64 && dp.x === 0,
    JSON.stringify({ dp, scr }));

  // title slide: theme background + white title ink
  await waitPixel(dp.x + 24, dp.y + dp.h - 24, [0x10, 0x14, 0x18], 60000,
    'demo title slide background');
  check('title slide background composited', true);
  let ink = null;
  for (let y = dp.y + 100; y < dp.y + dp.h - 100 && !ink; y += 10)
    for (let x = dp.x + 100; x < dp.x + dp.w - 100 && !ink; x += 10) {
      const p = await sample(x, y);
      if (p[0] > 220 && p[1] > 220 && p[2] > 220) ink = p;
    }
  check('title glyph ink composited', ink !== null, ink);

  // Right arrow -> the arch diagram: probe the os.html box fill at
  // deck-logical (110,190) through the fit map.
  const demo = fitMap(dp, 1280, 720);
  await page.keyboard.press('ArrowRight');
  await waitPixel(...demo.at(110, 190), [0x1d, 0x27, 0x33], 30000,
    'arch slide box-page fill after ArrowRight');
  check('ArrowRight navigated to the arch diagram', true);

  await page.keyboard.press('q');
  await waitPixel(dp.x + dp.w / 2, dp.y + dp.h / 2, TEAL, 30000,
    'desktop after q');
  check('q quits the demo; desktop restored', true);

  /* ---- the live-reload leg ---- */
  const mk = (color) =>
    `{"deck":1,"size":{"w":640,"h":360},"theme":{"background":"#204080"},` +
    `"slides":[{"id":"one","elements":[{"id":"bg","type":"rect",` +
    `"x":0,"y":0,"w":640,"h":360,"style":{"fill":"${color}","stroke":"none"}}]}]}`;
  await setVt(1);
  await page.keyboard.type(`echo '${mk('#285028')}' > /root/live.deck\r`);
  await page.keyboard.type('deck /root/live.deck &\r');
  await waitMaxed('deck: live.deck', 'live');
  const lp = await windowPos('deck: live.deck');
  const live = fitMap(lp, 640, 360);
  const center = [Math.round(lp.x + lp.w / 2), Math.round(lp.y + lp.h / 2)];
  const banner = live.at(320, 10);   // inside the top error band when armed

  await waitPixel(...center, [0x28, 0x50, 0x28], 60000, 'live deck v1');
  check('live deck rendered', true);

  // external overwrite -> the watch wakes the park -> new deck composites
  await setVt(1);
  await page.keyboard.type(`echo '${mk('#106040')}' > /root/live.deck\r`);
  await setVt(2);
  await waitPixel(...center, [0x10, 0x60, 0x40], 30000,
    'reloaded deck after external save');
  check('external save live-reloaded', true);

  // broken save -> banner over the HELD last-good slide. The band is
  // alpha-235 src-over, so the probe expects the BLEND with the held
  // slide color underneath.
  const blend = (c, u) => Math.round((c * 235 + u * 20) / 255);
  const BANNER = [blend(178, 0x10), blend(24, 0x60), blend(32, 0x40)];
  await setVt(1);
  await page.keyboard.type("echo '{\"deck\":1, broken' > /root/live.deck\r");
  await setVt(2);
  await waitPixel(...banner, BANNER, 30000, 'red error banner');
  const held = await sample(...center);
  check('broken save: last-good slide HELD under the banner',
    near(held, [0x10, 0x60, 0x40]), held);

  // recovery: a good save drops the banner with the fresh deck
  await setVt(1);
  await page.keyboard.type(`echo '${mk('#603070')}' > /root/live.deck\r`);
  await setVt(2);
  await waitPixel(...center, [0x60, 0x30, 0x70], 30000, 'recovered deck');
  const post = await sample(...banner);
  check('recovery dropped the banner', !near(post, BANNER), post);

  await page.keyboard.press('q');
  await waitPixel(...center, TEAL, 30000, 'desktop after quitting live deck');
  check('q quits the live deck; desktop restored', true);
} catch (e) {
  check('unexpected error: ' + e.message, false);
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos deck (browser): PASS' : `\nos deck (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
