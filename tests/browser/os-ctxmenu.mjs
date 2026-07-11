// 0091 browser acceptance: right-click context menus on the real
// compositor, driven by REAL browser input (page.mouse right-clicks,
// page.keyboard nav) rather than wmctl injection — the headless twin is
// tests/kernel/test_ctxmenu_e2e.js. Covers: right-click on the empty
// desktop raises the wm.c popup (Win95 face + raised edge over the teal),
// keyboard Down/Right/Enter cascades the NEW flyout and creates the
// folder (verified through the VT1 shell), Esc and outside-left-click
// dismiss, right-click on a taskbar button raises the window menu above
// the bar, and right-click in a notepad EDIT raises the user32
// WM_CONTEXTMENU popup in-surface with keyboard-selected Paste landing
// the 0090 clipboard text (verified via wmctl gettext).
//
// Usage: node os-ctxmenu.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
const PORT = 3226;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  // serve.js may re-bake a stale image before listening — allow for it.
  await waitForServer(URL, { tries: 240, interval: 500 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitOut, waitScreen } = osHelpers(page);

  const TEAL = [0, 128, 128], NAVY = [0, 0, 128], WHITE = [255, 255, 255],
        FACE = [192, 192, 192], ORANGE = [255, 140, 0];
  // timing subject: paces genuine no-marker settles — EV_SCREEN quiesce, VT1
  // input pacing, popup keyboard-nav gaps, and the async job-notice trap (each
  // call site is annotated; none has a page-observable signal to wait on).
  const pause = (ms) => page.waitForTimeout(ms);

  // VT2 + the 0023 settle: derive geometry from the live screen.
  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { h: SH } = await page.evaluate(() => window.__osScreen);
  const clickAt = (sx, sy, btn) =>
    page.mouse.click(rect.x + sx, rect.y + sy, btn ? { button: btn } : {});
  // The VT switch can queue one more screen-resize whose EV_SCREEN
  // dismisses popups (screen_changed) — quiesce before the first click.
  await pause(1500);

  // ---- desktop right-click: menu up (wm.c geometry: 120x116 at the click,
  // rows 20px/pad 4). (400,300) clears the icon column; menu interior
  // sampled at +60,+40 (below the row texts of NEW/SORT BY), the raised
  // edge at the exact corner. ----
  const MX = 400, MY = 300;
  await clickAt(MX, MY, 'right');
  await waitPixel(MX + 60, MY + 40, FACE);
  check('right-click on the empty desktop raises the context menu', true);
  check('raised edge at the menu corner',
    near(await sample(MX, MY), WHITE), await sample(MX, MY));

  // ---- keyboard nav: Down highlights NEW, Right cascades the flyout,
  // Enter fires FOLDER -> /root/Desktop/New Folder (VT1-verified). ----
  await page.keyboard.press('ArrowDown');
  await waitPixel(MX + 60, MY + 14, NAVY);       // past the NEW glyphs, before the arrow
  check('ArrowDown highlights row 0 (NEW)', true);
  await page.keyboard.press('ArrowRight');
  // flyout parks at root-right - 3, first row aligned: (517, 300), 120x48;
  // its row 0 (FOLDER) is pre-highlighted by the keyboard cascade —
  // sampled past the FOLDER glyphs (flyout-local x 110).
  await waitPixel(MX + 227, MY + 14, NAVY);
  check('ArrowRight cascades the NEW flyout (FOLDER pre-highlighted)', true);
  await page.keyboard.press('Enter');
  await waitPixel(MX + 60, MY + 40, TEAL);
  check('Enter fires the row and dismisses the popup', true);
  await setVt(1);
  await pause(300);
  await page.keyboard.type('test -d "/root/Desktop/New Folder" && echo FOLDER-O""K\r', { delay: 60 });
  await waitOut('FOLDER-OK');
  check('keyboard-selected New > Folder created the directory', true);
  await setVt(2);

  // ---- Esc and outside-click dismissal ----
  await clickAt(MX, MY, 'right');
  await waitPixel(MX + 60, MY + 40, FACE);
  await page.keyboard.press('Escape');
  await waitPixel(MX + 60, MY + 40, TEAL);
  check('Esc dismisses the desktop menu', true);
  await clickAt(MX, MY, 'right');
  await waitPixel(MX + 60, MY + 40, FACE);
  await clickAt(700, 450);                       // left-click elsewhere
  await waitPixel(MX + 60, MY + 40, TEAL);
  check('outside left-click dismisses it', true);

  // ---- taskbar-button menu: winbox up, right-click its button ----
  await setVt(1);
  await page.keyboard.type('winbox &\r', { delay: 60 });
  await pause(800);                              // the job-notice race
  await setVt(2);
  await waitPixel(132, 116, ORANGE, 60000);      // winbox client at 12,36
  // Button 0 spans x [56,160); the 120x96 menu parks above the 28px bar.
  const BARY = SH - 14, BMX = 56, BMY = SH - 28 - 96;
  await clickAt(100, BARY, 'right');
  await waitPixel(BMX + 60, BMY + 40, FACE);
  check('right-click on a taskbar button raises the window menu above the bar', true);
  await page.keyboard.press('Escape');
  await waitPixel(BMX + 60, BMY + 40, TEAL);
  check('Esc dismisses the taskbar menu', true);

  // ---- EDIT context menu (user32, in-surface): clipboard-backed Paste ----
  await setVt(1);
  await page.keyboard.type('printf BROWSERPASTE | clip && echo CLIP-SE""T\r', { delay: 60 });
  await waitOut('CLIP-SET');
  await page.keyboard.type('notepad &\r', { delay: 60 });
  await pause(800);
  await setVt(2);
  // Second window: the wm cascade parks notepad at 40,60; EDIT client white.
  const NX = 40, NY = 60;
  await waitPixel(NX + 200, NY + 150, WHITE, 60000);
  await clickAt(NX + 200, NY + 120, 'right');    // surface coords (200,120)
  await waitPixel(NX + 208, NY + 128, FACE);
  check('right-click in the EDIT raises the user32 popup in-surface', true);
  // Only Paste is enabled (empty field, loaded clipboard): Down lands on
  // it (nav skips grayed rows), Enter pastes.
  await page.keyboard.press('ArrowDown');
  await pause(200);
  await page.keyboard.press('Enter');
  await waitPixel(NX + 208, NY + 128, WHITE);
  check('Enter closed the popup (EDIT repainted)', true);
  await setVt(1);
  await pause(300);
  // Marker-wrapped so the earlier `printf BROWSERPASTE | clip` echo can't
  // satisfy the wait (the 0089 echo trap).
  await page.keyboard.type('echo "GOT-$(wmctl gettext EDIT:0)-END"\r', { delay: 60 });
  await waitOut('GOT-BROWSERPASTE-END');
  check('keyboard-selected Paste landed the clipboard text in the EDIT', true);

  await page.keyboard.type("echo CTX-SHELL-O''K\r", { delay: 60 });
  await waitOut('CTX-SHELL-OK');
  check('shell alive after the run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos ctxmenu (browser): PASS' : `\nos ctxmenu (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
