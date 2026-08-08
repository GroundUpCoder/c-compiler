// user32 browser acceptance (todos/0058, design todos/WIN32.md): boot the
// reference OS page in headless Chromium, launch the seeded /bin/ctldemo
// from the shell, and drive the Win32 controls through the REAL input
// path — page mouse clicks and keyboard — plus the agent tree (`wmctl
// click`, no pixels) from the shell. Asserts the Win95 control rendering
// composits (BTNFACE chrome, white edit/listbox wells) at the exact
// coordinates os/win32/ctldemo.c lays out (the headless twin,
// tests/kernel/test_user32_e2e.js, drives the same layout via wmctl).
//
// Usage: node os-user32.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3335;   // unique per member (#546)
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

  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut.includes(n), needle, { timeout: ms || 30000, polling: 'raf' });

  const TEAL = [0, 128, 128], WHITE = [255, 255, 255], BTNFACE = [192, 192, 192];

  // Modal dialogs (MessageBox, the Options template) are kernel-cascaded
  // windows — each open lands one cascade slot further, so a hardcoded
  // screen point drifts into a later dialog's navy title bar. Derive the
  // ACTUAL geometry from wmctl (VT1) and wait for BTNFACE at a client-
  // interior point (+40y clears the ~20px chrome title bar for any slot).
  const dialogGeom = async (title, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      await setVt(1);
      await page.evaluate(() => { window.__osOut = ''; });
      await page.keyboard.type('wmctl list\r');
      await new Promise(r => setTimeout(r, 400));
      const out = await page.evaluate(() => window.__osOut);
      await setVt(2);
      const row = out.split('\n').find(l => l.split('\t').slice(6).join('\t').trim() === title);
      const m = row && row.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
      if (m) return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
      if (Date.now() - t0 > ms) throw new Error(`dialog "${title}" never appeared in wmctl list`);
      await new Promise(r => setTimeout(r, 300));
    }
  };
  const waitDialogFace = async (title, ms) => {
    const g = await dialogGeom(title, ms);
    // Probe the BOTTOM-LEFT corner interior: dialog-face by construction
    // (controls cluster top/right), and stable when the stock font's
    // metrics rescale the template layout — the old center/+40y probe
    // landed on the Options EDIT after the Phase D Noto swap grew the
    // dialog units.
    await waitPixel(g.x + 12, g.y + g.h - 12, BTNFACE, 30000);
    return g;
  };

  await setVt(2);
  await waitScreen();

  // Launch the seeded user32 demo from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('ctldemo &\r');
  await waitOut('ctldemo: ready', 60000);
  check('classic GetMessage loop reaches ready in-browser', true);
  await setVt(2);

  // The WM places the first window at (12,36); layout coordinates below
  // mirror os/win32/ctldemo.c WM_CREATE — change together.
  const WX = 12, WY = 36;
  const at = (x, y) => [WX + x, WY + y];
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (x, y) => page.mouse.click(rect.x + WX + x, rect.y + WY + y);

  await waitPixel(...at(440, 150), BTNFACE, 60000);
  check('BTNFACE class background composited', true);
  check('single-line EDIT well white', near(await sample(...at(166, 22)), WHITE), await sample(...at(166, 22)));
  check('LISTBOX well white', near(await sample(...at(100, 100)), WHITE), await sample(...at(100, 100)));
  check('multiline EDIT well white', near(await sample(...at(200, 255)), WHITE), await sample(...at(200, 255)));
  // Control text renders: the STATIC "Name:" band carries non-BTNFACE ink.
  let ink = null;
  for (let x = 14; x < 60 && !ink; x += 2) {
    const p = await sample(...at(x, 22));
    if (!near(p, BTNFACE, 12)) ink = p;
  }
  check('STATIC label ink composited', ink !== null, ink);
  // Button raised edge: Add's top-left pixel is BTNHIGHLIGHT white.
  check('button raised 3D edge', near(await sample(...at(268, 10)), WHITE), await sample(...at(268, 10)));

  // Cursor shapes (todos/0105): user32's EDIT claims the I-beam on hover, so a
  // real mouse move over the Name EDIT flips canvas.style.cursor to 'text';
  // over the Add button it falls back to 'default'. The kernel per-surface
  // cursor rides the SetCursor -> SDL -> RPC path; a short settle lets the app
  // pump the motion. (The agent tree carries no pixels, so this is the page.)
  // The per-surface cursor rides SetCursor -> SDL -> RPC -> the page's
  // canvas.style.cursor; the style updates only when the motion's RPC lands,
  // so a fixed sleep races it (the value read is one gesture stale). Poll:
  // jiggle inside the target and wait for the style to settle to `want`.
  const cursorSettle = async (cx, cy, want, ms = 8000) => {
    const t0 = Date.now();
    let last = '';
    for (;;) {
      await page.mouse.move(rect.x + WX + cx, rect.y + WY + cy);
      await page.mouse.move(rect.x + WX + cx + 1, rect.y + WY + cy + 1);
      last = await page.evaluate(() => document.getElementById('screen').style.cursor);
      if (want.includes(last)) return last;
      if (Date.now() - t0 > ms) return last;
      await new Promise(r => setTimeout(r, 150));
    }
  };
  {
    const overEdit = await cursorSettle(166, 22, ['text']);
    check('EDIT hover -> text I-beam cursor', overEdit === 'text', overEdit);
    const overBtn = await cursorSettle(268, 12, ['default', '']);
    check('button hover -> default arrow', overBtn === 'default' || overBtn === '', overBtn);
  }

  // REAL input path: type into the edit (page keyboard -> kernel ring ->
  // WM_CHAR), then a real mouse click on Greet. SETTLE around the VT
  // switch and between input gestures (the HANDOFF sweep rule) — the
  // first post-switch gesture raced the bridge once.
  await new Promise(r => setTimeout(r, 500));
  await clickAt(166, 22);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.type('Hi', { delay: 40 });
  await new Promise(r => setTimeout(r, 300));
  await clickAt(336 + 30, 10 + 12);
  await waitOut("ctldemo: WM_COMMAND Greet name='Hi' verbose=0", 60000);
  check('mouse click + typed text reach WM_COMMAND', true);

  // The agent path from the in-OS shell: no pixels anywhere.
  await setVt(1);
  await page.keyboard.type('wmctl click About\r');
  await waitOut('ctldemo: about-opening');
  await setVt(2);
  await waitDialogFace('About ctldemo');
  check('MessageBox modal composited', true);
  await setVt(1);
  await page.keyboard.type('wmctl click OK\r');
  await waitOut('ctldemo: msgbox=1');
  check('wmctl click OK dismisses the modal -> IDOK', true);
  await setVt(2);

  // 0104 dialog keyboard: open the Options template dialog (mouse), then
  // drive it purely with the REAL page keyboard — typing into the
  // first-tabstop edit, Alt+V toggling the Verbose checkbox mnemonic, and
  // Enter firing the DEFPUSHBUTTON. The shell marker carries the result.
  await new Promise(r => setTimeout(r, 400));
  await clickAt(140 + 38, 284 + 13);             // Options button
  await waitDialogFace('Options');
  check('Options dialog composited', true);
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.type('hi', { delay: 50 }); // into the focused edit
  await new Promise(r => setTimeout(r, 200));
  await page.keyboard.down('Alt');               // Alt+V: mnemonic toggle
  await new Promise(r => setTimeout(r, 60));
  await page.keyboard.press('KeyV');
  await new Promise(r => setTimeout(r, 60));
  await page.keyboard.up('Alt');
  await new Promise(r => setTimeout(r, 200));
  await page.keyboard.press('Enter');            // default OK
  await waitOut("ctldemo: opt-ok name='hi' verbose=1", 30000);
  check('template dialog fully keyboard-driven (type + mnemonic + default)', true);
  // Reopen and dismiss with Esc -> IDCANCEL. The reopen cascades to a
  // fresh slot (each dialog CREATE bumps the kernel cascade), so derive
  // its geometry instead of assuming the first open's position.
  await new Promise(r => setTimeout(r, 400));
  await clickAt(140 + 38, 284 + 13);
  await waitDialogFace('Options');
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.press('Escape');
  await waitOut('ctldemo: opt-cancel', 30000);
  check('Esc cancels the dialog -> IDCANCEL', true);

  // Quit via a real mouse click; desktop restored, shell alive.
  await clickAt(388 + 38, 284 + 13);
  await waitOut('ctldemo: bye');
  await waitPixel(...at(240, 180), TEAL);
  check('Quit button exits the app; desktop restored', true);

  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // U32-SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo U32-SHELL-O''K\r");
  await waitOut('U32-SHELL-OK', 20000);
  check('shell alive after ctldemo exits', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  try {
    const pages = browser.contexts()[0] ? browser.contexts()[0].pages() : [];
    if (pages[0]) {
      const tail = await pages[0].evaluate(() => (window.__osOut || '').slice(-1200));
      console.error('--- __osOut tail ---\n' + tail);
    }
  } catch {}
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos user32 (browser): PASS' : `\nos user32 (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
