// NetSurf paint-demo interaction probe (netsurf-bughunt lane, ad hoc).
//
// Boots gucOS in headless Chromium — against the DEPLOYED edge by default,
// or a local serve.js when NS_URL points there — opens the seeded paint demo
// in /bin/netsurf, drives a REAL mouse drag across the pad, and saves
// viewable PNGs of the desktop (drawImage route: the screen canvas is
// transferred to the worker, so page.screenshot cannot see it).
//
// Usage:
//   node nsdemos-paint-probe.mjs                        # deployed edge
//   NS_URL=http://localhost:3212/os/os.html NS_TAG=local node nsdemos-paint-probe.mjs
import fs from 'node:fs';
import { launchBrowser, osHelpers, makeCheck, startServer, waitForServer, osUrl } from './lib/os-harness.mjs';

const PORT = 3212;
const LOCAL = process.env.NS_LOCAL === '1';   // spawn serve.js and test the local bake
const URL = LOCAL ? osUrl(PORT) : (process.env.NS_URL || 'https://groundupcoder.com/os/os.html?hostkeys=off');
const TAG = process.env.NS_TAG || (LOCAL ? 'local' : 'prod');
const MEDIA = process.env.NS_MEDIA || '/Users/jku/git/meta/meta/media/netsurf-bughunt';
const DEMO = '/root/Desktop/Presentations/samples/Web Demos';

const server = LOCAL ? startServer(PORT) : null;
if (LOCAL) await waitForServer(URL, { tries: 3000, interval: 200 });  // first bake can be slow
const browser = await launchBrowser();
const { check, state } = makeCheck();
try {
  const TOUCH = process.env.NS_TOUCH === '1';
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, hasTouch: TOUCH });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
  page.on('pageerror', e => process.stderr.write('[pageerror] ' + e.message + '\n'));

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 300000, polling: 250 });
  check(TAG + ': boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 60000, polling: 200 });

  const { setVt, sample, waitOut, waitScreen } = osHelpers(page);
  const type = async (cmd) => { await page.keyboard.type(cmd + '\r'); };

  // A healthy boot auto-switches to VT2 (the desktop); shell typing is VT1.
  await setVt(1);

  // VT1: make sure the demo seed is present (minimal deploys carry it as the
  // netsurf-demos package).
  await type(`ls "${DEMO}/paint" >/dev/null 2>&1 && echo SEED-O''K || echo SEED-MIS''SING`);
  await page.waitForFunction(() => /SEED-OK|SEED-MISSING/.test(window.__osOut), null, { timeout: 20000, polling: 200 });
  if ((await page.evaluate(() => window.__osOut)).includes('SEED-MISSING')) {
    console.log('  (seed missing — installing netsurf-demos via gucman)');
    await type(`gucman install netsurf-demos && echo INST-O''K || echo INST-FAI''LED`);
    await page.waitForFunction(() => /INST-OK|INST-FAILED/.test(window.__osOut), null, { timeout: 180000, polling: 300 });
    check(TAG + ': gucman install netsurf-demos', (await page.evaluate(() => window.__osOut)).includes('INST-OK'));
  } else {
    console.log('  (demo seed already present in the image)');
  }

  await type(`netsurf "${DEMO}/paint/index.html" &`);
  await type(`wmctl wait win Paint 60000 && echo WIN-U''P || echo WIN-FAI''LED`);
  await page.waitForFunction(() => /WIN-UP|WIN-FAILED/.test(window.__osOut), null, { timeout: 90000, polling: 200 });
  check(TAG + ': netsurf window "Paint" came up',
        (await page.evaluate(() => window.__osOut)).includes('WIN-UP'));

  // Window geometry off wmctl list (SID PID WxH+X+Y DST Z FLAGS TITLE).
  await type(`echo ==LI''ST; wmctl list; echo ==EN''D`);
  await waitOut('==END', 20000);
  const seg = (await page.evaluate(() => window.__osOut)).split('==LIST').pop().split('==END')[0];
  const row = seg.split('\n').map(l => l.trim().split('\t')).find(c => c[6] === 'Paint');
  if (!row) throw new Error('no Paint row in wmctl list:\n' + seg);
  const gm = row[2].match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
  const [, , , WXs, WYs] = gm;
  const WX = +WXs, WY = +WYs;
  console.log('  Paint window geometry: ' + row[2]);

  await setVt(2);
  await waitScreen();
  await new Promise(r => setTimeout(r, 1500));   // late EV_SCREEN settle (os-ctxmenu gotcha)

  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const pad = (px, py) => [rect.x + WX + px, rect.y + WY + py];  // paint.css pins pad at page origin

  const shot = async (name) => {
    const data = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      const s = window.__osScreen || { w: 0, h: 0 };
      const t = document.createElement('canvas');
      t.width = Math.max(Math.round(r.width), s.w);
      t.height = Math.max(Math.round(r.height), s.h);
      t.getContext('2d').drawImage(c, 0, 0);
      return t.toDataURL('image/png');
    });
    fs.mkdirSync(MEDIA, { recursive: true });
    fs.writeFileSync(`${MEDIA}/${name}`, Buffer.from(data.split(',')[1], 'base64'));
    console.log('  saved ' + name);
  };

  await shot(`paint-${TAG}-before-drag.png`);
  const before = await sample(WX + 120, WY + 60);
  check(TAG + ': pad starts white', before.every(v => v > 240), before);

  // The drag: down inside the pad, a diagonal of moves, up. Touch mode uses
  // CDP touch injection (the os-touch.mjs pattern) — one-finger drag, which
  // os.html synthesizes into the same wm-input records as a left-button drag.
  if (TOUCH) {
    const cdp = await context.newCDPSession(page);
    const pt = (x, y) => ({ x: Math.round(x), y: Math.round(y), id: 0 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(...pad(30, 30))] });
    for (let i = 1; i <= 9; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(...pad(30 + i * 20, 30 + i * 10))] });
      await new Promise(r => setTimeout(r, 40));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(...pad(30, 30));
    await page.mouse.down();
    for (let i = 1; i <= 9; i++) await page.mouse.move(...pad(30 + i * 20, 30 + i * 10));
    await page.mouse.up();
  }

  // Informational only: the gucos frontend has no console_log window-table
  // entry, so page console.log output reaches no tty (a DX gap, not a paint
  // failure). Report whether anything showed up, without failing on it.
  let strokeSeen = true;
  try { await waitOut('paint stroke 1 done', 5000); }
  catch { strokeSeen = false; }
  console.log('  (console.log stroke line visible on tty: ' + strokeSeen + ')');

  await shot(`paint-${TAG}-after-drag.png`);
  const painted = await sample(WX + 110, WY + 70);   // on the diagonal: (30+80,30+40)
  check(TAG + ': ink appeared on the pad (pixel on the stroke is dark)',
        painted.every(v => v < 100), painted);
  const off = await sample(WX + 200, WY + 20);       // far off the stroke
  check(TAG + ': off-stroke pad pixel stays white', off.every(v => v > 240), off);

  // Dump the tail of the tty mirror for the record.
  const tail = await page.evaluate(() => window.__osOut.slice(-2000));
  console.log('---- tty tail ----\n' + tail + '\n---- end tail ----');
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  if (server) server.kill();
}
console.log(state.failures === 0 ? `\npaint probe (${TAG}): PASS` : `\npaint probe (${TAG}): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
