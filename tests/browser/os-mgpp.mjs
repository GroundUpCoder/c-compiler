// MagicPointPlus browser acceptance (todos/0272): boot the reference OS page
// in headless Chromium and drive /bin/mgpp — the -DMGPP fork of /bin/mgp — with
// REAL mouse clicks and arrow keys through the compositor, proving the new
// navigation end-to-end:
//   - page 1 of demo.mgp is white-on-MidnightBlue; `space` pages forward to the
//     green %tab box icons (page 2) — unchanged from mgp
//   - a LEFT-half mouse click pages BACK  (green boxes disappear -> page 1)
//   - a RIGHT-half mouse click pages FORWARD (green boxes reappear -> page 2)
//   - Left arrow pages BACK, Right arrow pages FORWARD (same green witness)
//   - `q` quits cleanly; the desktop is restored
// The green %tab boxes exist only on page 2, so their presence/absence is a
// two-sided witness for the page we are on. The headless twin
// (tests/kernel/test_mgpp_e2e.js) proves exact page identity off `wmctl shot`;
// this leg proves the compositor + real-input path and saves a look-confirm PNG.
//
// Usage: node os-mgpp.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(__dirname, '..', '..', 'build', 'test-browser');
fs.mkdirSync(OUTDIR, { recursive: true });

const PORT = 3272;
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, sample, waitPixel, waitScreen } = osHelpers(page);
  const TEAL = [0, 128, 128];

  await setVt(2);
  await waitScreen();

  async function windowPos(title) {
    await setVt(1);
    await page.keyboard.type(`wmctl wait win ${title} >/dev/null; wmctl list | grep "${title}"\r`);
    await page.waitForFunction(
      (t) => new RegExp('\\d+x\\d+\\+\\d+\\+\\d+[^\\n]*' + t).test(window.__osOut),
      title, { timeout: 30000, polling: 'raf' });
    const out = await page.evaluate(() => window.__osOut);
    const matches = [...out.matchAll(/(\d+)x(\d+)\+(\d+)\+(\d+)/g)];
    const m = matches[matches.length - 1];
    await setVt(2);
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  }

  // The #screen canvas offset in the viewport: screen coords (== CSS px on VT2,
  // 0023) + this = page.mouse client coords.
  const canvasOrigin = () => page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { left: r.left, top: r.top };
  });

  // Is a page-2 green %tab box currently composited anywhere in the window's
  // left half? (pure-ish green: low R/B, high G)
  async function hasGreen(mp) {
    for (let y = mp.y + 40; y < mp.y + mp.h - 40; y += 6)
      for (let x = mp.x + 20; x < mp.x + mp.w / 2; x += 6) {
        const p = await sample(x, y);
        if (p[0] < 80 && p[1] > 200 && p[2] < 80) return true;
      }
    return false;
  }
  async function waitGreen(mp, want, ms, what) {
    const t0 = Date.now();
    for (;;) {
      if ((await hasGreen(mp)) === want) return;
      if (Date.now() - t0 > (ms || 30000))
        throw new Error(`green ${want ? 'never appeared' : 'never cleared'} (${what})`);
      await page.waitForTimeout(400);
    }
  }
  // Save the whole composited screen as a PNG (drawImage: the worker WebGPU
  // OffscreenCanvas can't be page.screenshot'd — memory/os_screenshot).
  async function saveShot(name) {
    const dataUrl = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      const t = document.createElement('canvas');
      t.width = Math.round(r.width); t.height = Math.round(r.height);
      t.getContext('2d').drawImage(c, 0, 0);
      return t.toDataURL('image/png');
    });
    const file = path.join(OUTDIR, name);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return file;
  }

  /* ---- launch mgpp ---- */
  await setVt(1);
  await page.keyboard.type('mgpp /usr/share/mgp/demo.mgp &\r');
  const mp = await windowPos('MagicPoint');

  // page 1: MidnightBlue %default background + white title, NO green boxes
  await waitPixel(mp.x + 20, mp.y + mp.h - 20, [25, 25, 112], 60000);
  check('mgpp page 1 MidnightBlue background composited', true);
  await waitGreen(mp, false, 5000, 'page 1 has no green boxes').catch(() => {});
  check('mgpp page 1 has no green %tab boxes', !(await hasGreen(mp)));

  // space -> page 2 (green boxes) — forward is unchanged
  await page.keyboard.press(' ');
  await waitGreen(mp, true, 30000, 'space did not reach page 2');
  check('mgpp space pages FORWARD to page 2 (green boxes)', true);
  const shot2 = await saveShot('mgpp-page2-green.png');

  const clickAt = async (frac) => {
    const o = await canvasOrigin();
    await page.mouse.click(o.left + mp.x + mp.w * frac, o.top + mp.y + mp.h / 2);
  };

  // LEFT-half click -> BACK to page 1 (green clears) — the NEW behavior
  await clickAt(0.25);
  await waitGreen(mp, false, 30000, 'left-half click did not page back');
  check('mgpp LEFT-half click pages BACK (green cleared)', true);
  const shotBack = await saveShot('mgpp-leftclick-back-page1.png');

  // RIGHT-half click -> FORWARD to page 2 (green returns)
  await clickAt(0.75);
  await waitGreen(mp, true, 30000, 'right-half click did not page forward');
  check('mgpp RIGHT-half click pages FORWARD (green returned)', true);

  // Left arrow -> BACK (green clears)
  await page.keyboard.press('ArrowLeft');
  await waitGreen(mp, false, 30000, 'Left arrow did not page back');
  check('mgpp Left arrow pages BACK (green cleared)', true);

  // Right arrow -> FORWARD (green returns)
  await page.keyboard.press('ArrowRight');
  await waitGreen(mp, true, 30000, 'Right arrow did not page forward');
  check('mgpp Right arrow pages FORWARD (green returned)', true);

  // q still quits
  await page.keyboard.press('q');
  await waitPixel(mp.x + mp.w / 2, mp.y + mp.h / 2, TEAL, 30000);
  check('q quits mgpp; desktop restored', true);

  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // MGPP-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo MGPP-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('MGPP-SHELL-OK'), { timeout: 20000, polling: 'raf' });
  check('shell alive after mgpp exit', true);

  console.log('  look-confirm PNGs:\n    ' + shot2 + '\n    ' + shotBack);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos mgpp (browser): PASS' : `\nos mgpp (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
