// Full Screen toggle browser acceptance (#398) — the #fsbtn control in
// #vtbar (os/os.html).
//
// The button is page chrome, not OS surface: it drives the BROWSER's element
// fullscreen on document.documentElement. The contract under test:
//   (a) where the API exists the button is visible (data-fs-ok), unlit, and
//       a real click enters fullscreen and lights it (.on)
//   (b) #vtbar stays VISIBLE in fullscreen — it is the only mouse route back
//       out (the one real design decision on the ticket)
//   (c) a second click exits and unlights
//   (d) 🔴 truthfulness: the .on class is owned by the fullscreenchange
//       EVENT, not the click — leaving fullscreen by ANY OTHER route
//       (here: programmatic document.exitFullscreen(), the Esc-key class)
//       must unlight the button with no click involved
//   (e) where the API does NOT exist (iOS Safari's video-only fullscreen,
//       spoofed via an init script) the button must not appear at all
//
// Usage: node os-fsbtn.mjs
import { openOsSession } from './lib/os-harness.mjs';

const PORT = 3313;
const s = await openOsSession({ port: PORT, serverTries: 240, serverInterval: 500 });
const { page, check } = s;

try {
  // (a) supported: gate attribute set, button visible in the bar, unlit.
  const d = await page.evaluate(() => ({
    fsOk: document.body.hasAttribute('data-fs-ok'),
    visible: document.getElementById('fsbtn').offsetParent !== null,
    lit: document.getElementById('fsbtn').classList.contains('on'),
    fsEl: document.fullscreenElement !== null,
  }));
  check('button visible and unlit where element fullscreen exists',
    d.fsOk && d.visible && !d.lit && !d.fsEl, d);

  // (a) a REAL click (user activation — evaluate() has none and the request
  // would be refused) enters fullscreen; the event lights the button.
  await page.click('#fsbtn');
  await page.waitForFunction(() =>
    document.fullscreenElement === document.documentElement &&
    document.getElementById('fsbtn').classList.contains('on'),
    { timeout: 10000, polling: 'raf' });
  check('click enters fullscreen and the fullscreenchange event lights the button', true);

  // (b) the bar is the way back out: it must still be laid out in fullscreen.
  const bar = await page.evaluate(() => {
    const r = document.getElementById('vtbar').getBoundingClientRect();
    return { h: r.height, visible: document.getElementById('vtbar').offsetParent !== null };
  });
  check('#vtbar stays visible in fullscreen (the mouse exit route)',
    bar.visible && bar.h > 0, bar);

  // (c) second click exits and unlights.
  await page.click('#fsbtn');
  await page.waitForFunction(() =>
    document.fullscreenElement === null &&
    !document.getElementById('fsbtn').classList.contains('on'),
    { timeout: 10000, polling: 'raf' });
  check('second click exits fullscreen and unlights the button', true);

  // (d) truthfulness: re-enter by click, leave WITHOUT the button — the
  // programmatic exit stands in for Esc/hold-Esc/browser chrome. A
  // click-driven .on would stay stuck lit here.
  await page.click('#fsbtn');
  await page.waitForFunction(() => document.fullscreenElement !== null,
    { timeout: 10000, polling: 'raf' });
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() =>
    document.fullscreenElement === null &&
    !document.getElementById('fsbtn').classList.contains('on'),
    { timeout: 10000, polling: 'raf' });
  check('non-click exit (Esc class) unlights the button — .on rides the event', true);

  // (e) unsupported host (the iOS Safari shape): spoof the API away before
  // any page script runs; the button must not appear. The gate runs at
  // script parse — no need to wait for a full re-boot to ready.
  await page.addInitScript(() => {
    delete Element.prototype.requestFullscreen;
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
  });
  await page.reload();
  const u = await page.evaluate(() => ({
    fsOk: document.body.hasAttribute('data-fs-ok'),
    visible: document.getElementById('fsbtn').offsetParent !== null,
  }));
  check('button is absent where element fullscreen is unsupported (no dead control)',
    !u.fsOk && !u.visible, u);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os fsbtn (browser)');
