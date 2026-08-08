// 0212 browser acceptance: the page-side touch layer — os.html synthesizes
// the SAME wm-input records the mouse handlers send, so touch gestures drive
// the un-modified kernel/WM. Driven by REAL touch emulation (CDP
// Input.dispatchTouchEvent on a hasTouch context; page.mouse never used for
// the gestures under test). Covers: long-press on the empty desktop raises
// the wm.c context menu (deferred down -> right down+up on the timer), a tap
// elsewhere dismisses it (tap = left click), long-press on a desktop icon
// raises the icon menu, double-tap launches (notepad via the icon), a
// two-finger vertical pan wheels the notepad EDIT (0210's 3-lines-per-notch
// scroll), a touch title-drag moves winbox by the exact delta, and
// long-press on its taskbar button raises the window menu above the bar.
//
// Feature 1's boundary — mouse-desktop behavior unchanged — is covered by
// the untouched os-wm/os-ctxmenu mouse legs in the same sweep.
//
// Usage: node os-touch.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl,
         deskEntries, deskCell } from './lib/os-harness.mjs';
const PORT = 3240;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  // serve.js may re-bake a stale image before listening — allow for it.
  await waitForServer(URL, { tries: 240, interval: 500 });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, sample, near, waitPixel, waitOut, waitScreen } = osHelpers(page);
  const TEAL = [0, 128, 128], WHITE = [255, 255, 255],
        FACE = [192, 192, 192], ORANGE = [255, 140, 0];
  // timing subject: gesture pacing (tap/long-press durations ARE the input
  // under test), VT1 input pacing, and the EV_SCREEN quiesce — annotated at
  // each site; none has a page-observable marker.
  const pause = (ms) => page.waitForTimeout(ms);

  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { h: SH } = await page.evaluate(() => window.__osScreen);

  // ---- CDP touch injection: the only Playwright path that does long-press
  // and multi-finger (page.touchscreen is tap-only). Coordinates are
  // viewport CSS px -> offset by the canvas rect.
  const cdp = await context.newCDPSession(page);
  const pt = (x, y, id) => ({ x: Math.round(rect.x + x), y: Math.round(rect.y + y), id: id || 0 });
  const tStart = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts });
  const tMove = (pts) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts });
  const tEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const tap = async (x, y) => {
    await tStart([pt(x, y)]);
    await pause(60);            // gesture timing: a real tap has finger dwell
    await tEnd();
  };
  const longPress = async (x, y) => {
    await tStart([pt(x, y)]);
    await pause(750);           // gesture timing: past the 500ms long-press timer
    await tEnd();
  };
  const doubleTap = async (x, y) => {
    await tap(x, y);
    await pause(90);            // gesture timing: inside the 400ms dblclick gap
    await tap(x, y);
  };
  const touchDrag = async (x0, y0, x1, y1) => {
    await tStart([pt(x0, y0)]);
    for (let i = 1; i <= 8; i++) {
      await tMove([pt(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8)]);
      await pause(30);          // gesture timing: move cadence under the timer
    }
    await tEnd();
  };
  // Type on VT1 and return the tty output between split-needle markers.
  let listSeq = 0;
  const shellList = async () => {
    const tag = 'LIST' + (listSeq++);
    await setVt(1);
    await pause(300);           // VT1 input pacing (the ctxmenu-test settle)
    await page.keyboard.type(`echo ${tag}-B""EGIN; wmctl list; echo ${tag}-E""ND\r`, { delay: 40 });
    await waitOut(`${tag}-END`);
    const out = await page.evaluate(() => window.__osOut);
    const txt = out.slice(out.lastIndexOf(`${tag}-BEGIN`), out.lastIndexOf(`${tag}-END`));
    await setVt(2);
    return txt;
  };
  const shellRun = async (cmd, marker, ms) => {
    await setVt(1);
    await pause(300);           // VT1 input pacing
    await page.keyboard.type(`${cmd} && echo ${marker.slice(0, 2)}""${marker.slice(2)}\r`, { delay: 40 });
    await waitOut(marker, ms || 30000);
    await setVt(2);
  };
  const geomOf = (list, title) => {
    const line = list.split('\n').find(l => l.includes(title));
    const m = line && line.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    if (!m) throw new Error(`no geometry for "${title}" in:\n${list}`);
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  };

  // The VT switch can queue one more screen-resize whose EV_SCREEN dismisses
  // popups (screen_changed) — quiesce before the first gesture.
  await pause(1500);

  // ---- long-press on the empty desktop -> wm.c context menu (the exact
  // pixel geometry the mouse test os-ctxmenu proves: FACE at the row-2
  // left gutter +5,+40 — engine rows since 0259 — raised WHITE edge at
  // the corner) ----
  const MX = 400, MY = 300;
  await longPress(MX, MY);
  await waitPixel(MX + 5, MY + 40, FACE);
  check('long-press on the empty desktop raises the context menu', true);
  check('raised edge at the menu corner',
    near(await sample(MX, MY), WHITE), await sample(MX, MY));

  // ---- tap elsewhere = left click: dismisses the popup ----
  await tap(700, 450);
  await waitPixel(MX + 5, MY + 40, TEAL);
  check('tap outside dismisses it (tap = left click)', true);

  // ---- long-press on a desktop icon -> the icon menu ----
  const cell = deskCell(deskEntries(), 'notepad', SH);
  await longPress(cell.cx, cell.cy);
  let list = await shellList();
  check('long-press on the notepad icon raises the icon menu',
    list.includes('ctxmenu'), list);
  await page.keyboard.press('Escape');
  list = await shellList();
  check('Esc dismisses the icon menu', !list.includes('ctxmenu'), list);

  // ---- double-tap the icon -> launches (activate() -> /bin/notepad) ----
  await doubleTap(cell.cx, cell.cy);
  await shellRun('wmctl wait win "Untitled - Notepad" 60000', 'NOTE-UP', 90000);
  check('double-tap on the icon launched notepad', true);
  list = await shellList();
  const np = geomOf(list, 'Untitled - Notepad');

  // ---- two-finger pan wheels the notepad EDIT (0210): 3 dense M lines
  // FIRST, then 40 filler lines. WM_SETTEXT resets caret AND view to the
  // START (real-EDIT contract since the 0222 audit), so the dense lines
  // are visible right after settext; panning the fingers UP (natural
  // scroll toward the tail) moves them out of view. ----
  await shellRun(
    `wmctl settext EDIT:0 "$(printf 'MMMMMMMMMMMMMMMM\\n%.0s' 1 2 3; printf '.\\n%.0s' $(seq 1 40))"`,
    'TEXT-SET');
  // Dark-glyph census over the EDIT's TOP text rows in ONE evaluate: x past
  // the '.' filler glyphs (they hug the left pad), y below the 20px user32
  // menu bar and bounded to the M block's own three 27px rows — only the M
  // blocks can put dark pixels there, and the band stays clear of the
  // WS_HSCROLL strip and the status bar however tall the font-derived bar
  // is (0229: the old np.h-26 bottom cropped the strip's dark edge only
  // under a 20px bar and sampled it once the bar grew).
  const darkCount = () => page.evaluate(([a, b, c, d]) => {
    const cv = document.getElementById('screen');
    const r = cv.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const img = ctx.getImageData(a, b, c - a, d - b).data;
    let n = 0;
    for (let i = 0; i < img.length; i += 4)
      if (img[i] < 100 && img[i + 1] < 100 && img[i + 2] < 100) n++;
    return n;
  }, [np.x + 40, np.y + 34, np.x + 130, np.y + 34 + 3 * 27 + 5]);
  const t0 = Date.now();
  let before = 0;
  while ((before = await darkCount()) === 0 && Date.now() - t0 < 20000)
    await pause(300);          // waiting on the settext repaint (pixel marker)
  check('EDIT shows the dense head lines after settext (view at start)', before > 0, before);
  // Two strokes, fingers moving UP, midpoint inside the EDIT the whole
  // way (wheel routes by hover position): ~2 notches each = 12 lines down.
  const panUp = async () => {
    const px = np.x + Math.floor(np.w / 2);
    await tStart([pt(px - 30, np.y + np.h - 40, 1)]);
    await tStart([pt(px - 30, np.y + np.h - 40, 1), pt(px + 30, np.y + np.h - 40, 2)]);
    for (let i = 1; i <= 10; i++) {
      const yy = np.y + np.h - 40 - (np.h - 80) * i / 10;
      await tMove([pt(px - 30, yy, 1), pt(px + 30, yy, 2)]);
      await pause(20);         // gesture timing: pan cadence
    }
    await tEnd();
  };
  await panUp();
  await panUp();
  const t1 = Date.now();
  let after = -1;
  while ((after = await darkCount()) !== 0 && Date.now() - t1 < 20000)
    await pause(300);          // waiting on the scroll repaint (pixel marker)
  check('two-finger pan scrolled the dense lines out (wheel -> EDIT)',
    after === 0, { before, after });
  await shellRun('pkill notepad && wmctl wait nowin "Untitled - Notepad" 10000', 'NOTE-GONE');

  // ---- touch title-drag moves winbox by the exact delta ----
  await shellRun('winbox >/dev/null 2>&1 & wmctl wait win winbox 30000', 'WB-UP', 60000);
  list = await shellList();
  const wb = geomOf(list, 'winbox');
  await waitPixel(wb.x + 120, wb.y + 80, ORANGE);   // first frame presented
  await touchDrag(wb.x + 100, wb.y - 12, wb.x + 200, wb.y + 68);
  await waitPixel(wb.x + 220, wb.y + 160, ORANGE);  // client at the new spot
  list = await shellList();
  const wb2 = geomOf(list, 'winbox');
  check('touch title-drag moved winbox by the exact delta (+100,+80)',
    wb2.x === wb.x + 100 && wb2.y === wb.y + 80, { wb, wb2 });
  check('old spot back to desktop',
    near(await sample(wb.x + 4, wb.y + 4), TEAL), await sample(wb.x + 4, wb.y + 4));

  // ---- long-press on its taskbar button -> window menu above the bar ----
  // Button 0 sits at x~112 — past the Start strip AND the Task-View/overview
  // button (todos/EXPOSE shifted the app strip by TASKVIEW_W = 26px); the menu
  // parks above the 36px bar at the button's left edge. Coordinates mirror the
  // (green) mouse leg in os-ctxmenu.mjs: press at x=150 (inside [112,272)),
  // sample the FACE gutter at BMX+4 with BMX = the menu's left edge (114).
  const BMX = 114, BMY = SH - 36 - 134;   // h-134 menu (30px rows, engine since 0259)
  await longPress(150, SH - 14);
  await waitPixel(BMX + 4, BMY + 46, FACE);
  check('long-press on the taskbar button raises the window menu', true);
  await page.keyboard.press('Escape');
  await waitPixel(BMX + 4, BMY + 46, TEAL);
  check('Esc dismisses the taskbar menu', true);

  await setVt(1);
  await pause(300);            // VT1 input pacing
  await page.keyboard.type("echo TOUCH-SHELL-O''K\r", { delay: 60 });
  await waitOut('TOUCH-SHELL-OK');
  check('shell alive after the run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos touch (browser): PASS' : `\nos touch (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
