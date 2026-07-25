// Mobile zoom defaulting + "Desktop site" toggle (gucOS #69 D6, revised
// v163) — browser acceptance.
//
// The VT2 integer-zoom mechanism (os-vt2zoom.mjs) shipped earlier; this slice
// is the page-side DEFAULTING + TOGGLE policy on top of it. The v163 revision
// DROPPED the phone auto-2x default — 1x is the boot default everywhere, 2x
// is one explicit Desktop-site-toggle gesture away:
//   (a) a phone-shaped viewport (min(innerW, innerH) <= 700) boots the
//       desktop at 1x with nothing persisted — same as desktop — while the
//       mobile controls (zoom ± and the Desktop-site toggle) stay visible;
//   (b) the toggle flips to the 2x mobile zoom, PERSISTS, and the explicit
//       choice OVERRIDES the 1x default across a reload (the "persisted
//       zoom must still win" guarantee); toggling back to 1x persists too;
//   (c) a desktop-shaped viewport is byte-identical to before: 1x, nothing
//       stored, no mobile controls.
// The zoom mechanism itself (backing floor(pane/Z), pinned CSS display,
// pointer /Z seam) is os-vt2zoom.mjs's job — this file only proves which Z
// gets selected when, so it settles geometry but doesn't re-test input.
//
// Usage: node os-mobile2x.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
import fs from 'node:fs';

const PORT = 3264;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL, { tries: 240, interval: 500 });

  // ---- (a) phone-shaped viewport: 1x default, nothing persisted ----
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
  check('phone viewport defaults to 1x (probe + "1×" label), UNPERSISTED (auto, not a choice)',
    autoState.z === 1 && autoState.label === '1×' && autoState.stored === null, autoState);
  let pane = await paneSize();
  const s1a = await settleZoom(1);
  check('1x default really applied: logical screen == full pane',
    s1a.w === pane.w && s1a.h === pane.h, { s1a, pane });
  const ctl = await page.evaluate(() => ({
    desksite: document.getElementById('desksite').offsetParent !== null,
    zoomctl: document.getElementById('zoomctl').offsetParent !== null,
  }));
  check('Desktop-site toggle + zoom control still visible on the mobile VT2 UI',
    ctl.desksite && ctl.zoomctl, ctl);
  // The phone-1x-boot proof shot (v163 default flip).
  fs.mkdirSync('build/mobile1x-shots', { recursive: true });
  const shot = await page.evaluate(() => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    t.getContext('2d').drawImage(c, 0, 0);
    return t.toDataURL('image/png');
  });
  fs.writeFileSync('build/mobile1x-shots/phone-1x-boot.png',
    Buffer.from(shot.split(',')[1], 'base64'));

  // ---- (b) the toggle: -> 2x, persists across reload, -> back to 1x ----
  await page.click('#desksite');
  const dstate = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    stored: localStorage.getItem('gucos.vt2.zoom'),
  }));
  check('Desktop site click at 1x -> the 2x mobile zoom, PERSISTED',
    dstate.z === 2 && dstate.stored === '2', dstate);
  pane = await paneSize();
  const s2 = await settleZoom(2);
  check('2x really applied: logical screen is floor(pane/2)',
    s2.w === Math.floor(pane.w / 2) && s2.h === Math.floor(pane.h / 2), { s2, pane });

  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await setVt(2);
  const reload2 = await page.evaluate(() => ({
    z: window.__osVt2Zoom, stored: localStorage.getItem('gucos.vt2.zoom') }));
  check('persisted explicit 2x OVERRIDES the 1x default after reload (still 2x)',
    reload2.z === 2 && reload2.stored === '2', reload2);
  await settleZoom(2);

  await page.click('#desksite');
  const back1 = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    stored: localStorage.getItem('gucos.vt2.zoom'),
  }));
  check('toggle again -> back to 1x, persisted',
    back1.z === 1 && back1.stored === '1', back1);
  await settleZoom(1);
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('1x choice persists across reload too',
    await page.evaluate(() => window.__osVt2Zoom) === 1, null);
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
