// Presentation tools browser acceptance (todos/0119): boot the reference OS
// page in headless Chromium, run the two seeded slide tools from the shell,
// and assert their pixels through the real compositor:
//   - /bin/sent (vendor/sent, suckless sent on SDL): demo.sent slide 1 is
//     black-on-white freetype text; q quits and restores the desktop
//   - /bin/mgp (vendor/magicpoint, MagicPoint 1.13a on SDL): demo.mgp page 1
//     is white-on-MidnightBlue; space pages to the green %tab box icons;
//     q quits cleanly
// The headless twin (tests/kernel/test_present_e2e.js) asserts the same
// content off `wmctl shot`; this leg proves the compositor path.
//
// Usage: node os-present.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3221;
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

  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);
  const TEAL = [0, 128, 128];

  await setVt(2);
  await waitScreen();

  // Ask the shell where a window landed (cascade position is placement
  // policy, not a constant): parse `wmctl list` off the tty transcript.
  async function windowPos(title) {
    await setVt(1);
    await page.keyboard.type(`wmctl wait win ${title} >/dev/null; wmctl list | grep "${title}"\r`);
    await page.waitForFunction(
      (t) => new RegExp('\\d+x\\d+\\+\\d+\\+\\d+[^\\n]*' + t).test(window.__osOut),
      title, { timeout: 30000, polling: 200 });
    const out = await page.evaluate(() => window.__osOut);
    const matches = [...out.matchAll(/(\d+)x(\d+)\+(\d+)\+(\d+)/g)];
    const m = matches[matches.length - 1];
    await setVt(2);
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  }

  /* ---- sent ---- */
  await setVt(1);
  await page.keyboard.type('slides &\r');   // the sent package's demo launcher (cd's to its share/)
  const sp = await windowPos('sent');

  // slide 1: white background with the black "sent" title
  await waitPixel(sp.x + 20, sp.y + 20, [255, 255, 255], 60000);
  check('sent slide 1 white background composited', true);
  let ink = null;
  for (let y = sp.y + 100; y < sp.y + sp.h - 40 && !ink; y += 8)
    for (let x = sp.x + 100; x < sp.x + sp.w - 100 && !ink; x += 8) {
      const p = await sample(x, y);
      if (p[0] < 60 && p[1] < 60 && p[2] < 60) ink = p;
    }
  check('sent slide 1 glyph ink composited', ink !== null, ink);

  await page.keyboard.press('q');
  await waitPixel(sp.x + sp.w / 2, sp.y + sp.h / 2, TEAL, 30000);
  check('q quits sent; desktop restored', true);

  /* ---- mgp ---- */
  await setVt(1);
  await page.keyboard.type('mgp /usr/share/mgp/demo.mgp &\r');   // baked mgp (ticket #80): absolute-ref decks launch from any cwd
  const mp = await windowPos('MagicPoint');

  // page 1: the deck's %default MidnightBlue background (25,25,112)
  await waitPixel(mp.x + 20, mp.y + mp.h - 20, [25, 25, 112], 60000);
  check('mgp page 1 MidnightBlue background composited', true);
  let white = null;
  for (let y = mp.y + 40; y < mp.y + mp.h / 2 && !white; y += 6)
    for (let x = mp.x + 100; x < mp.x + mp.w - 100 && !white; x += 8) {
      const p = await sample(x, y);
      if (p[0] > 220 && p[1] > 220 && p[2] > 220) white = p;
    }
  check('mgp page 1 white glyph pixels composited', white !== null, white);

  // space -> page 2: %tab "icon box green" bullets
  await page.keyboard.press(' ');
  let green = null;
  const t0 = Date.now();
  while (!green && Date.now() - t0 < 30000) {
    for (let y = mp.y + 40; y < mp.y + mp.h - 40 && !green; y += 6)
      for (let x = mp.x + 20; x < mp.x + mp.w / 2 && !green; x += 6) {
        const p = await sample(x, y);
        if (p[0] < 80 && p[1] > 200 && p[2] < 80) green = p;
      }
    if (!green) await page.waitForTimeout(500);
  }
  check('mgp page 2 green box icons composited', green !== null, green);

  await page.keyboard.press('q');
  await waitPixel(mp.x + mp.w / 2, mp.y + mp.h / 2, TEAL, 30000);
  check('q quits mgp; desktop restored', true);

  // The shell survives both windowed children.
  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // PRESENT-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo PRESENT-SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('PRESENT-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after sent+mgp exit', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos present (browser): PASS' : `\nos present (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
