// Mobile 2x default + "Desktop site" toggle (gucOS #69 D6) — browser acceptance.
//
// The VT2 integer-zoom mechanism (os-vt2zoom.mjs) shipped earlier; this slice
// is the page-side DEFAULTING + TOGGLE policy on top of it:
//   (a) a phone-shaped viewport (min(innerW, innerH) <= 700, the same signal
//       as the VT1 26px font default) boots the desktop at 2x with nothing
//       persisted — an auto default, not a stored choice;
//   (b) the "Desktop site" toggle flips to the unzoomed 1x desktop, persists,
//       and OVERRIDES the auto default across a reload; toggling back to 2x
//       persists too;
//   (c) a desktop-shaped viewport is byte-identical to before: 1x, nothing
//       stored, no mobile controls.
// The zoom mechanism itself (backing floor(pane/Z), pinned CSS display,
// pointer /Z seam) is os-vt2zoom.mjs's job — this file only proves which Z
// gets selected when, so it settles geometry but doesn't re-test input.
//
// Usage: node os-mobile2x.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3264;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL, { tries: 240, interval: 500 });

  // ---- (a) phone-shaped viewport: auto-2x default, nothing persisted ----
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await mctx.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('mobile-viewport boot reaches ready', true);

  const { setVt, sample, near, waitPixel } = osHelpers(page);
  const FACE = [192, 192, 192];
  await setVt(2);

  const paneSize = () => page.evaluate(() => {
    const p = document.getElementById('desktop');
    return { w: p.clientWidth, h: p.clientHeight };
  });
  // Settled at zoom Z: last-sent LOGICAL size == floor(pane/Z) and the wm's
  // taskbar has re-laid at the new bottom edge (mid-strip is empty FACE).
  const settleZoom = async (Z) => {
    await page.waitForFunction((z) => {
      const p = document.getElementById('desktop');
      const s = window.__osScreen;
      return s && s.w === Math.floor(p.clientWidth / z) && s.h === Math.floor(p.clientHeight / z);
    }, Z, { timeout: 30000, polling: 150 });
    const s = await page.evaluate(() => window.__osScreen);
    await waitPixel(Math.floor(s.w / 2), s.h - 14, FACE, 60000, 'taskbar re-laid at zoom ' + Z);
    return s;
  };

  const autoState = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    label: document.getElementById('zoomlabel').textContent,
    stored: localStorage.getItem('gucos.vt2.zoom'),
  }));
  check('phone viewport defaults to 2x (probe + "2×" label), UNPERSISTED (auto, not a choice)',
    autoState.z === 2 && autoState.label === '2×' && autoState.stored === null, autoState);
  let pane = await paneSize();
  const s2 = await settleZoom(2);
  check('auto-2x really applied: logical screen is floor(pane/2)',
    s2.w === Math.floor(pane.w / 2) && s2.h === Math.floor(pane.h / 2), { s2, pane });
  const ctl = await page.evaluate(() => ({
    desksite: document.getElementById('desksite').offsetParent !== null,
    on: document.getElementById('desksite').classList.contains('on'),
    zoomctl: document.getElementById('zoomctl').offsetParent !== null,
  }));
  check('Desktop-site toggle + zoom control visible on the mobile VT2 UI, toggle not lit at 2x',
    ctl.desksite && !ctl.on && ctl.zoomctl, ctl);

  // ---- (b) the toggle: -> 1x, persists across reload, -> back to 2x ----
  await page.click('#desksite');
  const dstate = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    stored: localStorage.getItem('gucos.vt2.zoom'),
    on: document.getElementById('desksite').classList.contains('on'),
  }));
  check('Desktop site click -> 1x, PERSISTED, toggle lit',
    dstate.z === 1 && dstate.stored === '1' && dstate.on, dstate);
  pane = await paneSize();
  const s1 = await settleZoom(1);
  check('1x really applied: logical screen == full pane',
    s1.w === pane.w && s1.h === pane.h, { s1, pane });

  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await setVt(2);
  const reload1 = await page.evaluate(() => ({
    z: window.__osVt2Zoom, stored: localStorage.getItem('gucos.vt2.zoom') }));
  check('persisted Desktop-site choice OVERRIDES the mobile auto-default after reload (still 1x)',
    reload1.z === 1 && reload1.stored === '1', reload1);
  pane = await paneSize();
  const s1r = await settleZoom(1);
  check('post-reload screen stays full-pane at 1x',
    s1r.w === pane.w && s1r.h === pane.h, { s1r, pane });

  await page.click('#desksite');
  const back2 = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    stored: localStorage.getItem('gucos.vt2.zoom'),
    on: document.getElementById('desksite').classList.contains('on'),
  }));
  check('toggle again -> back to 2x, persisted, toggle unlit',
    back2.z === 2 && back2.stored === '2' && !back2.on, back2);
  await settleZoom(2);
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('2x choice persists across reload too',
    await page.evaluate(() => window.__osVt2Zoom) === 2, null);
  await mctx.close();

  // ---- (c) desktop-shaped viewport: unchanged — 1x, nothing stored ----
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page2 = await dctx.newPage();
  await page2.goto(URL);
  await page2.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await page2.evaluate(() => window.__osVtSwitch(2));
  const desk = await page2.evaluate(() => ({
    z: window.__osVt2Zoom,
    stored: localStorage.getItem('gucos.vt2.zoom'),
    zoomctl: document.getElementById('zoomctl').offsetParent !== null,
    desksite: document.getElementById('desksite').offsetParent !== null,
  }));
  check('desktop viewport boots unchanged: 1x, unpersisted, mobile controls hidden',
    desk.z === 1 && desk.stored === null && !desk.zoomctl && !desk.desksite, desk);
  await page2.waitForFunction(() => {
    const p = document.getElementById('desktop');
    const s = window.__osScreen;
    return s && s.w === p.clientWidth && s.h === p.clientHeight;
  }, { timeout: 30000, polling: 150 });
  check('desktop viewport screen is full-pane (1 CSS px = 1 screen px)', true);
  await dctx.close();
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  try {
    const pages = browser.contexts().flatMap(c => c.pages());
    if (pages.length) {
      const tail = await pages[0].evaluate(() => window.__osOut.slice(-600));
      console.error('tty tail: ' + JSON.stringify(tail));
    }
  } catch {}
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos mobile2x (browser): PASS' : `\nos mobile2x (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
