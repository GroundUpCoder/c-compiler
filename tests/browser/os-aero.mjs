// 0063 browser acceptance: the Aero wave on the real WebGPU compositor.
// `winbox alpha` (SDL_WINDOW_TRANSPARENT, title "alphabox") is the app:
// its 50%-alpha blue client must composite src-over against the desktop
// (exact blend, not the opaque fill), the chrome must grow a drop shadow
// and rounded frame corners (the SDF quad path), hovering its taskbar
// button must raise the live Aero Peek thumbnail popup, minimize/restore
// must survive the transient fly-to-taskbar animation, and `wmctl glass`
// must swap the flat title bar for the translucent-over-blur one and back.
// Headless twins of the deterministic pieces live in
// tests/kernel/test_wm_aero.js + test_wm_service_e2e.js; this file is the
// GPU-pixels half.
//
// Usage: node os-aero.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
const PORT = 3220;
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
  // Poll an arbitrary pixel predicate (the glass legs assert ranges, not
  // exact colors — the blurred backdrop isn't a golden).
  const waitPred = async (x, y, pred, what, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (pred(got)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) never ${what}; last ${got}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  const TEAL = [0, 128, 128], NAVY = [0, 0, 128], WHITE = [255, 255, 255],
        FACE = [192, 192, 192],
        // 50%-alpha blue src-over the chrome frame PLATE (FACE 192 — the
        // frame quad spans the whole window, the client blends over it, not
        // over the desktop): 128/255-weighted, matching the e2e golden.
        ABLEND = [96, 96, 224];

  // VT2 + the 0023 settle: derive geometry from the live screen.
  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);

  // ---- per-pixel alpha (SDL_WINDOW_TRANSPARENT -> src-over) ----
  await setVt(1);
  await page.keyboard.type('winbox alpha &\r');
  await setVt(2);
  const WX = 12, WY = 36, WW = 240, WH = 160;    // first-window wm placement
  // The client must be the EXACT src-over blend of 50%-alpha blue over
  // what's behind it — an opaque-blue or gray sample means the alpha path
  // regressed. probe x sits past the two-column icon band (x>184, todos/0184).
  await waitPixel(WX + 200, WY + 80, ABLEND, 60000);
  check('50%-alpha blue client composites src-over (exact blend)', true);
  check('opaque white app border stays opaque',
    near(await sample(WX + 2, WY + 2), WHITE), await sample(WX + 2, WY + 2));
  check('focused title bar flat navy (glass off)',
    near(await sample(WX + 150, WY - 12), NAVY), await sample(WX + 150, WY - 12));

  // ---- drop shadow + rounded corners (todos/0063 SDF chrome) ----
  // Just below the frame (4px border + 3px drop, 1px in) the shadow is
  // near its darkest: teal scaled well down. 30px below it has decayed to
  // clean desktop (SHADOW_EXT 14).
  const shadow = await sample(WX + 100, WY + WH + 8);
  check('drop shadow darkens the desktop below the frame',
    shadow[0] < 30 && shadow[1] > 30 && shadow[1] < 110 && Math.abs(shadow[1] - shadow[2]) <= 8,
    shadow);
  check('shadow decays to desktop within SHADOW_EXT',
    near(await sample(WX + 100, WY + WH + 30), TEAL), await sample(WX + 100, WY + WH + 30));
  // Frame top-left corner pixel: pre-0063 this was square chrome (FACE);
  // the radius-7 SDF clips it, leaving shadowed desktop — teal-family,
  // never gray.
  const corner = await sample(WX - 3, WY - 31);
  check('frame corner rounded off (no square chrome pixel)',
    !near(corner, FACE, 40) && corner[0] < 40, corner);
  check('frame edge chrome intact away from the corners',
    near(await sample(WX - 2, WY + 80), FACE), await sample(WX - 2, WY + 80));

  // ---- Aero Peek: taskbar hover raises the live thumbnail ----
  // One window: button 0 spans x in [86, 246) (START_W 80 + gap, BTN_W
  // 160). The popup (160x120) parks above the bar centered on the button
  // (center ~166), clamped to x=86. Its client center shows the box-filtered
  // alphabox front buffer — pure blue (the thumbnail drops alpha).
  const BARY = SH - 14;
  const PEEKX = 86 + 80, PEEKY = SH - 36 - 4 - 60;   // popup center
  await page.mouse.move(rect.x + 100, rect.y + BARY);
  await waitPixel(PEEKX, PEEKY, [0, 0, 255], 30000);
  check('taskbar hover raised the Aero Peek thumbnail (live blue client)', true);
  check('popup face border around the thumbnail',
    near(await sample(86 + 3, SH - 40 - 117), FACE), await sample(86 + 3, SH - 40 - 117));
  // Motion off the bar (over the desktop) dismisses the popup.
  await page.mouse.move(rect.x + SW - 60, rect.y + Math.floor(SH / 2));
  await waitPixel(PEEKX, PEEKY, TEAL);
  check('hover off the bar dismissed the peek popup', true);

  // ---- minimize/restore ride the transient animation ----
  // The taskbar click minimizes; the compositor flies a fading, chrome-less
  // copy to the bar for 200ms (kernel anim records). End states must
  // settle — a wedge or a render-pass crash here is the regression.
  await clickAt(100, BARY);
  await waitPixel(WX + 200, WY + 80, TEAL);
  check('taskbar click minimized (window + shadow gone after the fly-down)', true);
  await clickAt(100, BARY);
  await waitPixel(WX + 200, WY + 80, ABLEND);
  check('second click restored through the fly-up (alpha client back)', true);

  // ---- the glass tier (wmctl glass; browser-only backdrop blur) ----
  await setVt(1);
  await page.keyboard.type("wmctl glass 1 && echo GLASS-O''N\r");
  await waitOut('GLASS-ON');
  await setVt(2);
  // Glass title = 55% navy over the whitish tint over the blurred teal
  // backdrop: still blue-dominant, but green wakes up — flat navy has g=0.
  const glass = await waitPred(WX + 150, WY - 12,
    (g) => g[1] > 30 && g[2] > g[1] + 20 && !near(g, NAVY), 'went glass');
  check('glass title bar: translucent chrome over the blurred backdrop', true, glass);
  await setVt(1);
  await page.keyboard.type("wmctl glass 0 && echo GLASS-O''FF\r");
  await waitOut('GLASS-OFF');
  await setVt(2);
  await waitPixel(WX + 150, WY - 12, NAVY);
  check('glass off restores the flat navy title', true);
  check('client blend unchanged by the glass round-trip',
    near(await sample(WX + 200, WY + 80), ABLEND), await sample(WX + 200, WY + 80));

  await setVt(1);
  await page.keyboard.type("echo AERO-SHELL-O''K\r");
  await waitOut('AERO-SHELL-OK');
  check('shell alive after the aero run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos aero (browser): PASS' : `\nos aero (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
