// VT2 desktop zoom browser acceptance — integer downscale + crisp upscale.
//
// The desktop VT2 canvas can be magnified by an INTEGER factor Z (1/2/3):
// the OffscreenCanvas backing store shrinks to floor(pane/Z) (the wm lays
// out on a smaller screen), while the canvas DISPLAY size is pinned to the
// full pane and image-rendering:pixelated upscales it Z× — so everything is
// Z× bigger and razor-sharp (integer scale + nearest-neighbor = zero blur).
// The render/wm path is untouched (still 1 logical px = 1 screen px); the
// ONLY thing zoom taints is the page's pointer seam, which divides incoming
// CSS coords by Z back to logical (backing) px. This test proves the whole
// loop end-to-end: the control + persistence, the shrunken-backing/pinned-
// display geometry, and — the load-bearing part — that a physical click at a
// CSS coordinate lands on the correct LOGICAL target after the /Z divide, and
// that window drag + the taskbar keep working under zoom. It also writes the
// bigger-and-crisp screenshots referenced in the dev log.
//
// Usage: node os-vt2zoom.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../logs/2026-07-18');

const PORT = 3262;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

// Grab the composited desktop as a PNG. `scale`>1 upscales with smoothing OFF
// (nearest-neighbor) — exactly how the browser displays a zoomed canvas, so
// the saved image is an honest "as displayed" artifact of the crisp upscale.
// Source dims come from __osScreen (the true backing size) — the placeholder
// canvas's width/height attributes can be stale after a worker resize.
async function snapshot(page, file, scale = 1) {
  const dataUrl = await page.evaluate((s) => {
    const c = document.getElementById('screen');
    const bw = window.__osScreen.w, bh = window.__osScreen.h;
    const t = document.createElement('canvas');
    t.width = bw * s; t.height = bh * s;
    const ctx = t.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, 0, 0, bw * s, bh * s);
    return t.toDataURL('image/png');
  }, scale);
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(b64, 'base64'));
  return path.join(OUT_DIR, file);
}

try {
  await waitForServer(URL, { tries: 240, interval: 500 });
  // hasTouch => the zoom control shows (touch half of the touchUiSync
  // predicate); a portrait, roomy viewport so the Start menu (192x274 above a
  // 28px bar) still fits at Z=2 (logical H ~ pane/2).
  const context = await browser.newContext({
    viewport: { width: 820, height: 1040 }, hasTouch: true });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitOut } = osHelpers(page);
  const TEAL = [0, 128, 128], FACE = [192, 192, 192], ORANGE = [255, 140, 0];

  // ---- boot lands on VT2 (0070). Settle at Z=1 and capture the baseline.
  await setVt(2);
  const paneSize = () => page.evaluate(() => {
    const p = document.getElementById('desktop');
    return { w: p.clientWidth, h: p.clientHeight };
  });
  // The screen is settled at zoom Z when the page's last-sent LOGICAL size
  // equals floor(pane/Z) AND the taskbar has re-laid at the new bottom edge.
  const settleZoom = async (Z) => {
    await page.waitForFunction((z) => {
      const p = document.getElementById('desktop');
      const s = window.__osScreen;
      return s && s.w === Math.floor(p.clientWidth / z) && s.h === Math.floor(p.clientHeight / z);
    }, Z, { timeout: 30000, polling: 150 });
    const s = await page.evaluate(() => window.__osScreen);
    // Sample the empty strip just LEFT of the clock (s.w - 108): reliably bar
    // face, clear of the app-button strip — which since todos/EXPOSE starts
    // further right (past the Start strip AND the Task-View button), so the
    // old 0.62*w point now lands on a focused button (sunken 222) at Z=2.
    await waitPixel(Math.floor(s.w - 108), s.h - 8, FACE, 60000, 'taskbar re-laid at zoom');
    return s;
  };

  let pane = await paneSize();
  let s1 = await settleZoom(1);
  check('Z=1 default: __osVt2Zoom is 1',
    await page.evaluate(() => window.__osVt2Zoom) === 1, null);
  check('Z=1 screen == full pane (1 CSS px = 1 screen px)',
    s1.w === pane.w && s1.h === pane.h, { s1, pane });
  check('zoom control is visible on the VT2 touch UI',
    await page.evaluate(() => document.getElementById('zoomctl').offsetParent !== null), true);
  await snapshot(page, 'vt2-zoom-1x.png', 1);

  // A window to prove the taskbar + window drag survive a zoom change.
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000, 'winbox composited (Z=1)');
  check('winbox composited before zoom', true);

  // ---- click A+ (the control) -> Z=2. Probe, label and persistence.
  await page.click('#zoomplus');
  const z2ui = await page.evaluate(() => ({
    z: window.__osVt2Zoom,
    label: document.getElementById('zoomlabel').textContent,
    stored: localStorage.getItem('gucos.vt2.zoom'),
  }));
  check('A+ steps zoom to 2 (probe + "2×" label + persisted)',
    z2ui.z === 2 && z2ui.label === '2×' && z2ui.stored === '2', z2ui);

  // ---- geometry: backing store halves, DISPLAY stays pinned to the pane.
  let s2 = await settleZoom(2);
  const disp = await page.evaluate(() => {
    const c = document.getElementById('screen'), p = document.getElementById('desktop');
    const r = c.getBoundingClientRect();
    return { cssW: Math.round(r.width), cssH: Math.round(r.height),
             paneW: p.clientWidth, paneH: p.clientHeight,
             ir: getComputedStyle(c).imageRendering };
  });
  pane = await paneSize();
  check('Z=2 logical screen is floor(pane/2)',
    s2.w === Math.floor(pane.w / 2) && s2.h === Math.floor(pane.h / 2), { s2, pane });
  check('canvas DISPLAY size pinned to the full pane (upscales into it)',
    Math.abs(disp.cssW - disp.paneW) < 2 && Math.abs(disp.cssH - disp.paneH) < 2, disp);
  check('image-rendering:pixelated => crisp integer upscale (no blur)',
    disp.ir === 'pixelated', disp.ir);
  // Display (full pane) is ~2x the logical/backing screen => everything is
  // rendered at half-res then upscaled 2x: visibly bigger UI.
  check('display is ~2x the backing (everything visibly bigger)',
    Math.abs(disp.cssW / s2.w - 2) < 0.05, { cssW: disp.cssW, logicalW: s2.w });
  await snapshot(page, 'vt2-zoom-2x.png', 2);

  // winbox survived the re-mode: still composited at its logical (12,36).
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000, 'winbox composited (Z=2)');
  check('winbox + taskbar survive the zoom change', true);

  // ---- THE coordinate seam: a physical click at a CSS coord must land on the
  // right LOGICAL target after the /Z divide. Click the Start button, which
  // lives at logical ~(25, SH-14): the CSS click at (25*2, (SH-14)*2) divides
  // back to it. Without the divide the wm would see y=(SH-14)*2 ~ pane-28,
  // far below the SH-tall logical screen -> no hit, so a menu opening IS the
  // proof the seam maps CSS->logical correctly.
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const Z = 2;
  const clickLogical = (lx, ly, opts) =>
    page.mouse.click(rect.x + lx * Z, rect.y + ly * Z, opts);
  const SM_H = 274, SM_Y = s2.h - 28 - SM_H;      // menu panel top (logical)
  const menuPx = 120, menuPy = SM_Y + 74;         // inside the pinned column
  const before = await sample(menuPx, menuPy);
  check('menu spot is not menu-face before the click', !near(before, FACE), before);
  await clickLogical(25, s2.h - 14);              // Start
  await waitPixel(menuPx, menuPy, FACE, 30000, 'Start menu opened via the /Z coord divide');
  check('click at CSS (Start*Z) opened the Start menu at the right logical coord', true);
  await clickLogical(s2.w - 20, 20);              // dismiss (empty desktop, top-right)
  await page.waitForTimeout(300);                 // menu dismiss settle (no marker)

  // ---- window drag under zoom: dragging the winbox title by a CSS delta of
  // (+200,+100) must move it by the LOGICAL delta (+100,+50). Absolute down/
  // move/up all divide by Z, so this exercises the full pointer path.
  await setVt(1);
  await page.keyboard.type('WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//"); wmctl list; echo WB-SI""D\r');
  await waitOut('WB-SID');
  const geomBefore = await page.evaluate(() => {
    const l = window.__osOut.split('\n').filter(x => /winbox\s*$/.test(x));
    const m = (l[l.length - 1] || '').match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  });
  check('winbox geometry parsed (pre-drag)', geomBefore && geomBefore.x === 12 && geomBefore.y === 36, geomBefore);
  await setVt(2);
  // The kernel title bar sits 12px ABOVE the reported client origin (os-wm's
  // WY-12 rule); grab it at logical (x+100, y-12) — CSS = rect + logical*Z.
  const tlx = geomBefore.x + 100, tly = geomBefore.y - 12;
  const tx = rect.x + tlx * Z, ty = rect.y + tly * Z;
  await page.mouse.move(tx, ty);
  await page.mouse.down();
  await page.mouse.move(tx + 200, ty + 100, { steps: 8 });   // CSS +200,+100
  await page.mouse.up();
  await page.waitForTimeout(200);                 // drop settle (no page marker)
  await setVt(1);
  await page.keyboard.type('wmctl list | grep winbox$; echo WB-MO""VED\r');
  await waitOut('WB-MOVED');
  const geomAfter = await page.evaluate(() => {
    const l = window.__osOut.split('\n').filter(x => /winbox\s*$/.test(x));
    const m = (l[l.length - 1] || '').match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    return m ? { x: +m[3], y: +m[4] } : null;
  });
  // logical delta = CSS delta / Z = (100, 50); allow a couple px of rounding.
  check('title drag under zoom moved by CSS-delta/Z (logical +100,+50)',
    geomAfter && Math.abs(geomAfter.x - (geomBefore.x + 100)) <= 3 &&
    Math.abs(geomAfter.y - (geomBefore.y + 50)) <= 3, { geomBefore, geomAfter });

  // ---- taskbar still works under zoom: its strip is FACE at the bottom edge.
  await setVt(2);
  check('taskbar strip renders under zoom (FACE at the logical bottom)',
    near(await sample(Math.floor(s2.w * 0.72), s2.h - 8), FACE),
    await sample(Math.floor(s2.w * 0.72), s2.h - 8));

  // ---- persistence across a reload: Z=2 restored, backing re-halved.
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  await setVt(2);
  const s2r = await settleZoom(2);
  const paneR = await paneSize();
  const reZ = await page.evaluate(() => window.__osVt2Zoom);
  check('zoom choice persists across a reload (Z=2, backing re-halved)',
    reZ === 2 && s2r.w === Math.floor(paneR.w / 2) && s2r.h === Math.floor(paneR.h / 2),
    { reZ, s2r, paneR });
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
console.log(state.failures === 0 ? '\nos vt2zoom (browser): PASS' : `\nos vt2zoom (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
