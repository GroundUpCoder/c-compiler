// High-density (sub-1×) display mode browser acceptance — hires-display.
//
// The VT2 zoom factor is an OS SETTING now: cfgstore `display` key `zoom`
// (auto | 0.5 | 0.75 | 1 | 2 | 3), whose PRIMARY surface is the Control
// Panel → Display applet (os/win32/ctlpanel.c, os/display.h). The kernel
// worker resolves the three-layer overlay and posts {type:'display-config'}
// to the page at boot and on every settled store write (kernel.watchPath
// riding the FSW choke), so an applet radio click reflows the desktop LIVE.
// The page's −/+ strip is a convenience over the SAME store (display-set →
// worker delta-write → watch → echo). At Z<1 the OffscreenCanvas backing
// store GROWS past the pane (more logical pixels — fixed-pixel icons and
// windows occupy a smaller fraction, more fits on a phone) and the render
// mode flips to smooth downscale; Z>=1 keeps the crisp pixelated upscale.
//
// This test proves, on a phone-shaped viewport:
//   - the DEFAULT is untouched: 1× boot (the v163 flip — auto-2× is gone,
//     2× is one explicit Desktop-site gesture away), no cfg file, nothing
//     stored; Z>=1 keeps the pixelated render mode;
//   - the explicit Desktop-site toggle reaches 2× (persisted) and 2× keeps
//     the crisp pixelated integer upscale;
//   - Control Panel → Display → "Densest (0.5x)" applies LIVE through the
//     full bridge (probe 0.5, label sync, logical screen doubles past the
//     pane, more fixed-116px icon columns fit, smooth render mode);
//   - the pointer seam maps CSS→logical across a sub-1 divide (a physical
//     click opens the Start menu at the right logical target);
//   - the ± strip writes the SAME store (zoom 0.75 lands in
//     ~/.config/display) — one source of truth, applet and strip agree;
//   - the choice persists across a reload; the applet's "Automatic
//     (default)" clears it everywhere (back to the 1× default, page
//     localStorage included);
//   - the VT2_MAX_DIM backing-store ceiling clamps a 4200px pane at 0.5×
//     to exactly 8192 logical px (WebGPU default maxTextureDimension2D),
//     aspect preserved;
//   - before/after screenshots at the pane's display size land in
//     build/test-browser/hires-shots/ (gitignored scratch; each written path
//     is printed so the artifact stays findable). The committed
//     logs/2026-07-25/hires-*.png are frozen July evidence cited by that
//     day's journal — never write there, never regenerate them (#399/#183).
//
// Usage: node os-hires.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../build/test-browser/hires-shots');

const PORT = 3276;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

// Save the desktop AS DISPLAYED: the backing store drawn at the PANE size
// with smoothing matching the live render mode (pixelated => off, auto =>
// on) — an honest artifact of what the phone shows at each zoom.
async function snapshot(page, file) {
  const dataUrl = await page.evaluate(() => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.imageSmoothingEnabled = getComputedStyle(c).imageRendering !== 'pixelated';
    ctx.drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/png');
  });
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, file);
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  console.log('  shot: ' + p);
  return p;
}

try {
  await waitForServer(URL, { tries: 240, interval: 500 });

  // ---- phone-shaped viewport: boots at the 1× default (v163) ----
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await mctx.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  check('boots to ready (phone viewport)', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitOut } = osHelpers(page);
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

  // ---- DEFAULT UNCHANGED (v163): 1×, no cfg file, nothing persisted ----
  await settleZoom(1);
  const defState = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    label: document.getElementById('zoomlabel').textContent,
    stored: localStorage.getItem('gucos.vt2.zoom'),
    ir: getComputedStyle(document.getElementById('screen')).imageRendering,
  }));
  check('phone default untouched: 1× (probe + "1×" label), UNPERSISTED',
    defState.z === 1 && defState.label === '1×' && defState.stored === null, defState);
  check('1× render mode is pixelated (Z>=1 keeps the crisp upscale path)',
    defState.ir === 'pixelated', defState.ir);
  await setVt(1);
  await page.keyboard.type('cat /root/.config/display; echo CFG0-D""ONE\r');
  await waitOut('CFG0-DONE');
  check('no display cfg exists before any choice (default = absent key)',
    await page.evaluate(() => /can't open|No such file/.test(
      window.__osOut.split('CFG0-DONE')[0].split('\n').slice(-3).join('\n'))), null);
  await setVt(2);
  await snapshot(page, 'hires-before-1x.png');

  // ---- EXPLICIT 2×: the Desktop-site toggle is the post-v163 route ----
  // (os-mobile2x.mjs owns the toggle policy; here it's just the way to
  // reach an integer upscale so the render-mode contract can be asserted.)
  await page.click('#desksite');
  const exp2 = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    label: document.getElementById('zoomlabel').textContent,
    stored: localStorage.getItem('gucos.vt2.zoom'),
    ir: getComputedStyle(document.getElementById('screen')).imageRendering,
  }));
  check('Desktop-site toggle reaches 2× explicitly ("2×" label, PERSISTED)',
    exp2.z === 2 && exp2.label === '2×' && exp2.stored === '2', exp2);
  check('2× render mode is pixelated (crisp integer upscale unchanged)',
    exp2.ir === 'pixelated', exp2.ir);
  const s2 = await settleZoom(2);

  // ---- THE APPLET: Control Panel → Display → Densest (0.5x), LIVE ----
  await setVt(1);
  await page.keyboard.type('ctlpanel Display &\r');
  await page.keyboard.type('wmctl wait win "Display Properties" 15000 && echo DPW""IN\r');
  await waitOut('DPWIN', 30000);
  check('Control Panel Display applet opens', true);
  await page.keyboard.type('wmctl click "Densest (0.5x)"\r');
  // The full bridge: dp_set → ~/.config/display → kernel.watchPath →
  // display-config → the page applies 0.5 with NO page-side gesture.
  await page.waitForFunction(() => window.__osVt2Zoom === 0.5, { timeout: 15000, polling: 150 });
  check('applet radio applies LIVE through the store→watch→page bridge (0.5)', true);
  const z50 = await page.evaluate(() => ({
    label: document.getElementById('zoomlabel').textContent,
    ir: getComputedStyle(document.getElementById('screen')).imageRendering,
  }));
  check('the −/+ strip label synced to the applet\'s choice ("0.5×")',
    z50.label === '0.5×', z50);
  check('sub-1× flips image-rendering to smooth (auto)', z50.ir === 'auto', z50.ir);
  await page.keyboard.type('pkill ctlpanel; wmctl wait nowin "Control Panel" 8000; echo CPG""ONE\r');
  await waitOut('CPGONE', 20000);

  // ---- density really happened: logical screen DOUBLED past the pane ----
  await setVt(2);
  const pane = await paneSize();
  const s05 = await settleZoom(0.5);
  check('0.5× logical screen is floor(pane/0.5) = 2× the pane per axis',
    s05.w === pane.w * 2 && s05.h === pane.h * 2, { s05, pane });
  check('0.5× has 4× the logical width of the explicit 2× (denser: more fits)',
    s05.w >= s2.w * 3.9, { s05, s2 });
  // Fixed-pixel desktop icon cells (wm.c CELL_W 116): more COLUMNS fit now.
  check('more fixed-116px icon columns fit at 0.5× than at 2×',
    Math.floor(s05.w / 116) > Math.floor(s2.w / 116),
    { at05: Math.floor(s05.w / 116), at2: Math.floor(s2.w / 116) });
  const disp = await page.evaluate(() => {
    const c = document.getElementById('screen'), p = document.getElementById('desktop');
    const r = c.getBoundingClientRect();
    return { cssW: Math.round(r.width), cssH: Math.round(r.height),
             paneW: p.clientWidth, paneH: p.clientHeight };
  });
  check('canvas DISPLAY size stays pinned to the pane (downscales into it)',
    Math.abs(disp.cssW - disp.paneW) < 2 && Math.abs(disp.cssH - disp.paneH) < 2, disp);
  await snapshot(page, 'hires-after-05x.png');

  // ---- pointer seam under a sub-1 divide: CSS c → logical c/0.5 = 2c.
  // Click the Start button (logical ~(25, SH-14)) at CSS (12.5, (SH-14)/2);
  // the menu opening at its logical spot proves the seam maps correctly
  // when it MULTIPLIES.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const SM_H = 274, SM_Y = s05.h - 28 - SM_H;   // menu panel top (logical)
  const menuPx = 120, menuPy = SM_Y + 74;       // inside the pinned column
  const before = await sample(menuPx, menuPy);
  check('menu spot is not menu-face before the click', !near(before, FACE), before);
  await page.mouse.click(rect.x + 25 * 0.5, rect.y + (s05.h - 14) * 0.5);
  await waitPixel(menuPx, menuPy, FACE, 30000, 'Start menu opened via the ×2 coord map');
  check('click at CSS (Start*0.5) opened the Start menu at the right logical coord', true);
  await page.mouse.click(rect.x + (s05.w - 40) * 0.5, rect.y + 20 * 0.5);   // dismiss
  await page.waitForTimeout(300);               // menu dismiss settle (no marker)

  // ---- the strip writes the SAME store: + steps 0.5 → 0.75, on disk ----
  await page.click('#zoomplus');
  check('zoomplus walks the sub-1 steps (0.5 → 0.75, label + localStorage)',
    await page.evaluate(() =>
      window.__osVt2Zoom === 0.75 &&
      document.getElementById('zoomlabel').textContent === '0.75×' &&
      localStorage.getItem('gucos.vt2.zoom') === '0.75'), null);
  await settleZoom(0.75);
  await setVt(1);
  await page.keyboard.type('for i in $(seq 1 100); do grep -q "zoom.0.75" /root/.config/display 2>/dev/null && break; sleep 0.05; done; cat /root/.config/display; echo CFG1-D""ONE\r');
  await waitOut('CFG1-DONE', 20000);
  check('the strip persisted zoom 0.75 into ~/.config/display (one store)',
    await page.evaluate(() =>
      /zoom\t0\.75/.test(window.__osOut.split('CFG1-DONE')[0].slice(-400))), null);
  await setVt(2);

  // ---- persistence: back to 0.5×, reload — the choice sticks ----
  await page.evaluate(() => window.__osVt2SetZoom(0.5));
  await settleZoom(0.5);
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });
  await setVt(2);
  check('0.5× choice persists across a reload',
    await page.evaluate(() => window.__osVt2Zoom) === 0.5, null);
  await page.waitForFunction(() => {
    const p = document.getElementById('desktop');
    const s = window.__osScreen;
    return s && s.w === p.clientWidth * 2 && s.h === p.clientHeight * 2;
  }, { timeout: 30000, polling: 150 });
  check('post-reload backing re-doubled (density restored)', true);

  // ---- the applet's Automatic clears the choice EVERYWHERE ----
  await setVt(1);
  await page.keyboard.type('ctlpanel Display &\r');
  await page.keyboard.type('wmctl wait win "Display Properties" 15000 && echo DPW2-""OK\r');
  await waitOut('DPW2-OK', 30000);
  await page.keyboard.type('wmctl click "Automatic (default)"\r');
  await page.waitForFunction(() =>
    window.__osVt2Zoom === 1 && localStorage.getItem('gucos.vt2.zoom') === null,
    { timeout: 15000, polling: 150 });
  check('applet "Automatic (default)" returns to the 1× default (v163) and clears localStorage', true);
  await mctx.close();

  // ---- the VT2_MAX_DIM ceiling: a 4200px pane at 0.5 would want 8400 ----
  // logical px > 8192 (WebGPU default maxTextureDimension2D) — the effective
  // zoom rises to pane/8192 so the width clamps to EXACTLY 8192 and the
  // height scales by the same divisor (aspect preserved, pointer map
  // consistent). Fresh context: its own OPFS + boot lock.
  const dctx = await browser.newContext({ viewport: { width: 4200, height: 900 } });
  const page2 = await dctx.newPage();
  await page2.goto(URL);
  await page2.waitForFunction(() => window.__osState === 'ready', { timeout: 240000, polling: 250 });
  await page2.evaluate(() => window.__osVtSwitch(2));
  await page2.waitForFunction(() => {
    const p = document.getElementById('desktop');
    const s = window.__osScreen;
    return s && s.w === p.clientWidth && s.h === p.clientHeight;
  }, { timeout: 30000, polling: 150 });
  await page2.evaluate(() => window.__osVt2SetZoom(0.5));
  await page2.waitForFunction(() => window.__osScreen && window.__osScreen.w === 8192,
    { timeout: 30000, polling: 150 });
  const cap = await page2.evaluate(() => {
    const p = document.getElementById('desktop');
    const eff = Math.max(0.5, p.clientWidth / 8192, p.clientHeight / 8192);
    return { s: window.__osScreen, expH: Math.floor(p.clientHeight / eff) };
  });
  check('backing-store ceiling: width clamps to exactly 8192 at 0.5× on a 4200px pane',
    cap.s.w === 8192, cap);
  check('ceiling preserves aspect (height scaled by the same effective divisor)',
    cap.s.h === cap.expH, cap);
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
console.log(state.failures === 0 ? '\nos hires (browser): PASS' : `\nos hires (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
