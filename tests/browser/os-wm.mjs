// WM browser acceptance (todos/WM.md + todos/0014): boot the reference OS
// page in headless Chromium, launch the seeded /bin/winbox from the shell,
// and drive its WINDOW through the real UI-bridge path — canvas mouse/
// keyboard -> kernel hit-test/rings -> SDL app — asserting composited
// pixels on the desktop canvas at every step (window fill, kernel chrome,
// click paint, key toggle, title-bar drag, border drag-resize with the
// SURFACE_CONFIGURE renegotiation (todos/0019), close box). With 0014 the
// autostarted /bin/wm is part of the scene: the borderless taskbar strip,
// WM (not kernel) placement, taskbar-button minimize/restore, and wmctl
// from the shell.
//
// Usage: node os-wm.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3193;
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
  // Don't race hush's banner: typed input before the first prompt is eaten.
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  // VTs (todos/0022; 0070: a healthy boot lands on VT2): the tty is VT1 and
  // only one is visible. Shell typing happens on VT1, canvas pixels/input on VT2
  // (the compositor may idle while its placeholder canvas is hidden, so
  // pixel waits on VT1 could stall on stale frames). Deep VT coverage lives
  // in os-vt.mjs.
  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], GREEN = [0, 200, 80],
        NAVY = [0, 0, 128], WHITE = [255, 255, 255], BLACK = [0, 0, 0],
        FACE = [192, 192, 192], FACE_DOWN = [222, 222, 222];

  await setVt(2);
  // Dynamic screen resolution (todos/0023): VT2 entry resizes the screen to
  // the viewport pane. Wait for the worker's canvas commit to catch up, then
  // derive all screen-edge geometry from the LIVE size.
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  check('VT2 screen tracks the viewport pane (todos/0023)', SW > 800 && SH > 500, { SW, SH });
  // Marker WAIT, not an instant sample (todos/0199, the 0238/0171 rule):
  // waitScreen() settles the canvas GEOMETRY but not the desktop-layer teal
  // COMPOSITE at this pixel, so under load a bare near(sample(...)) raced the
  // first painted frame and failed while the diagnostic re-sample already
  // read teal (a 10%-under-load flake). Wait for teal to actually composite.
  await waitPixel(SW - 20, SH - 60, TEAL, 30000, 'desktop teal before any window');
  check('desktop teal before any window', true);

  // 0014: the autostarted /bin/wm parks its borderless taskbar at the
  // bottom edge (strip y in [SH-28, SH)) — with 0023 it RE-LAYS there on
  // the VT2-entry resize (EV_SCREEN -> destroy + recreate at the new width).
  const BARY = SH - 14;                          // mid-strip sample row
  await waitPixel(400, BARY, FACE, 60000);
  check('taskbar strip composited (wm autostart)', true);
  await waitPixel(SW - 200, BARY, FACE, 30000);
  check('taskbar spans the RESIZED screen width (EV_SCREEN re-lay)', true);
  check('taskbar is borderless (no chrome band above it)',
    near(await sample(400, SH - 40), TEAL), await sample(400, SH - 40));

  // Launch the seeded windowed app from the shell (real tty path).
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);

  // The WM (not the kernel cascade) places the first window at (12,36).
  const WX = 12, WY = 36, WW = 240, WH = 160;
  await waitPixel(WX + 120, WY + 80, ORANGE, 60000);
  check('winbox window composited (orange fill)', true);
  // Sample BELOW the window, clear of the frame AND the 0063 drop shadow
  // (SHADOW_EXT 14 + 3px drop below the 4px frame).
  await waitPixel(WX + 100, WY + WH + 30, TEAL);
  check('WM placement settled (kernel cascade spot vacated)', true);
  check('white app border', near(await sample(WX + 2, WY + 2), WHITE), await sample(WX + 2, WY + 2));
  // Sample chrome AWAY from the title text and the close-box 'x' glyph.
  check('focused title bar navy', near(await sample(WX + 150, WY - 12), NAVY), await sample(WX + 150, WY - 12));
  // Close box rect: x in [WX+WW-20, WX+WW-4), y in [WY-20, WY-4); sample its
  // top-right corner, clear of the black 'x' glyph.
  check('close box present', near(await sample(WX + WW - 6, WY - 18), [192, 192, 192]), await sample(WX + WW - 6, WY - 18));

  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);

  // 0014: winbox has a taskbar button (button 0, sunken while focused);
  // clicking it minimizes, clicking again restores — the wm's policy loop
  // driven through its OWN surface's input ring. Button 0 sits right of
  // the Start button since todos/0028 (x in [56, 160)).
  await waitPixel(230, BARY, FACE_DOWN);
  check('taskbar button sunken while winbox focused', true);
  await clickAt(100, BARY);                      // minimize
  await waitPixel(WX + 120, WY + 80, TEAL);
  check('taskbar click minimized winbox (window off screen)', true);
  await clickAt(100, BARY);                      // restore
  await waitPixel(WX + 120, WY + 80, ORANGE);
  check('taskbar click restored winbox', true);

  // Click inside the client: kernel hit test -> ring -> SDL -> black paint
  // at the LOCAL point.
  await clickAt(WX + 60, WY + 60);
  await waitPixel(WX + 60, WY + 60, BLACK);
  check('client click painted at local coords', true);

  // Keyboard: canvas has focus after the click; any key toggles green.
  await page.keyboard.press('g');
  await waitPixel(WX + 120, WY + 80, GREEN);
  check('key toggled the fill green', true);

  // Title-bar drag: grab (WX+100, WY-12), drop 80 right / 60 down.
  await page.mouse.move(rect.x + WX + 100, rect.y + WY - 12);
  await page.mouse.down();
  await page.mouse.move(rect.x + WX + 180, rect.y + WY + 48, { steps: 8 });
  await page.mouse.up();
  const NX = WX + 80, NY = WY + 60;
  await waitPixel(NX + 120, NY + 80, GREEN);
  check('title drag moved the window', true);
  check('old spot back to desktop', near(await sample(WX + 4, WY + 4), TEAL), await sample(WX + 4, WY + 4));

  // Drag-resize (todos/0019): grab the SE frame corner (the WM_BORDER band
  // just outside the client), drag +60/+40 — Win95 outline preview during
  // the drag, ONE configure at release; winbox re-derives its surface and
  // redraws, the ack swaps the kernel buffer. 240x160 -> 300x200.
  await page.mouse.move(rect.x + NX + WW + 2, rect.y + NY + WH + 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + NX + WW + 62, rect.y + NY + WH + 42, { steps: 8 });
  await page.mouse.up();
  const RW = WW + 60, RH = WH + 40;
  await waitPixel(NX + RW - 20, NY + RH - 20, GREEN);
  check('drag-resize: client re-rendered at 300x200', true);
  check('new white border at the new right edge',
    near(await sample(NX + RW - 2, NY + 100), WHITE), await sample(NX + RW - 2, NY + 100));
  check('area beyond the old width is client now',
    near(await sample(NX + WW + 20, NY + 80), GREEN), await sample(NX + WW + 20, NY + 80));
  check('frame border flanks the resized client',
    near(await sample(NX + RW + 2, NY + 100), FACE), await sample(NX + RW + 2, NY + 100));

  // Cursor shapes (todos/0105): the kernel derives the effective cursor per
  // pointer move and the page maps it to canvas.style.cursor. Over a RESIZABLE
  // frame it reads a resize cursor (ew-resize side / nwse-resize corner); over
  // the client and the desktop it's the plain arrow (winbox sets no app
  // cursor). Read the live CSS value on the desktop canvas.
  const cursorAt = async (sx, sy) => {
    await page.mouse.move(rect.x + sx, rect.y + sy);
    await new Promise(r => setTimeout(r, 150));
    return page.evaluate(() => document.getElementById('screen').style.cursor);
  };
  {
    const east = await cursorAt(NX + RW + 2, NY + 100);
    check('resizable right frame edge -> ew-resize', east === 'ew-resize', east);
    const se = await cursorAt(NX + RW + 2, NY + RH + 2);
    check('resizable SE corner -> nwse-resize', se === 'nwse-resize', se);
    const client = await cursorAt(NX + 100, NY + 80);
    check('client area -> default arrow', client === 'default' || client === '', client);
    const desk = await cursorAt(WX + 4, WY + 4);
    check('desktop -> default arrow', desk === 'default' || desk === '', desk);
  }

  // Maximize (todos/0025): double-click the title bar — kernel detects the
  // gesture (EV_TITLE_ACTIVATE), /bin/wm answers with MOVE + RESIZE to the
  // work area (screen minus taskbar, client top below the kernel title
  // bar): winbox re-renders at SW x (SH - 56), position (0, 28).
  await page.mouse.dblclick(rect.x + NX + 100, rect.y + NY - 14);
  const MW = SW, MH = SH - 56;                   // wm.c work area (BAR_H + TITLE_H)
  await waitPixel(MW - 30, 28 + MH - 30, GREEN, 30000);
  check('title double-click maximized winbox to the work area', true);
  check('maximized fill reaches the left edge (client at x=0)',
    near(await sample(10, 200), GREEN), await sample(10, 200));
  check('maximized title bar spans the top', near(await sample(300, 16), NAVY), await sample(300, 16));
  check('taskbar still visible below the maximized window',
    near(await sample(400, BARY), FACE) || near(await sample(400, BARY), FACE_DOWN),
    await sample(400, BARY));
  // Double-click again -> restore to the EXACT pre-maximize geometry
  // (NX, NY, 300x200). The maximized title bar sits at y in [4, 28).
  await page.mouse.dblclick(rect.x + 300, rect.y + 16);
  await waitPixel(NX + RW - 20, NY + RH - 20, GREEN, 30000);
  check('second double-click restored the saved geometry', true);
  await waitPixel(MW - 30, 28 + MH - 30, TEAL);
  check('the maximized area is desktop again', true);
  check('restored frame at the restored edge',
    near(await sample(NX + RW + 2, NY + 100), FACE), await sample(NX + RW + 2, NY + 100));

  // Title-bar boxes (todos/0030), [min][max][close] right-aligned, 16px
  // metrics + 2px gaps: centers at RW-48 / RW-30 / RW-12 from the left
  // edge, mid-title. Min box -> kernel wmMinimize directly; max box ->
  // EV_TITLE_ACTIVATE -> the same wm.c toggle as the double-click.
  check('min/max box faces composited', near(await sample(NX + RW - 58, NY - 14), FACE)
    && near(await sample(NX + RW - 36, NY - 14), FACE),   // hollow-box interior
    [await sample(NX + RW - 58, NY - 14), await sample(NX + RW - 36, NY - 14)]);
  await clickAt(NX + RW - 58, NY - 14);          // min box
  await waitPixel(NX + 120, NY + 80, TEAL);
  check('min box minimized the window', true);
  await waitPixel(230, BARY, FACE);              // its button un-sunken
  await clickAt(100, BARY);                      // restore via the taskbar
  await waitPixel(NX + 120, NY + 80, GREEN);
  check('taskbar restored after the min box', true);
  await clickAt(NX + RW - 36, NY - 14);          // max box
  await waitPixel(MW - 30, 28 + MH - 30, GREEN, 30000);
  check('max box maximized to the work area (same policy as the double-click)', true);
  await clickAt(MW - 36, 16);                    // max box at the maximized spot
  await waitPixel(NX + RW - 20, NY + RH - 20, GREEN, 30000);
  await waitPixel(MW - 30, 28 + MH - 30, TEAL);
  check('max box again restored the saved geometry', true);

  // Close box -> SDL_EVENT_QUIT -> app exits -> window gone.
  await clickAt(NX + RW - 14, NY - 14);
  await waitPixel(NX + 120, NY + 80, TEAL);
  check('close box quit the app; desktop restored', true);

  // ... and its taskbar button is gone (EV_DESTROYED -> wm model -> redraw).
  await waitPixel(100, BARY, FACE);
  check('taskbar button removed after close', true);

  // The shell survives its windowed child (background job reaped). Back to
  // VT1 — the switch refocuses the terminal.
  await setVt(1);
  await page.keyboard.type('echo WM-SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('WM-SHELL-OK'), { timeout: 20000, polling: 200 });
  check('shell alive after windowed app exits', true);

  // 0014: wmctl from the shell, in the browser — one op set, everywhere.
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => window.__osOut.includes('taskbar'), { timeout: 20000, polling: 200 });
  check('wmctl list from the in-browser shell sees the taskbar', true);

  // ---- window cycling (todos/0032): the Ctrl+Alt+Tab chord ----
  // Two fresh winboxes (cascade slots k=1: 40,60 and k=2: 68,84; the
  // second is focused). The chord flips focus to the least-recent one;
  // again flips back. After killing the wm the chord is NOT recognized
  // and the Tab reaches the app (winbox toggles green on any keydown).
  await page.keyboard.type('winbox & winbox &\r');
  await setVt(2);
  const AX = 40, AY = 60, BX = 68, BY = 84;      // cascade slots 1 and 2
  await waitPixel(BX + 200, BY + 100, ORANGE, 60000);   // B's client, clear of A
  check('two more winboxes composited', true);
  await waitPixel(BX + 150, BY - 14, NAVY);
  check('second winbox focused (navy title)', true);
  check('first winbox blurred (gray title)',
    near(await sample(AX + 150, AY - 14), [128, 128, 128], 20), await sample(AX + 150, AY - 14));

  const chord = async () => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Alt');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
  };
  await clickAt(BX + 200, BY + 100);             // focus the canvas (B stays focused)
  await chord();
  await waitPixel(AX + 100, AY - 14, NAVY);      // A's title, clear of B's bar
  check('chord flipped focus to the other winbox', true);
  await chord();
  await waitPixel(BX + 150, BY - 14, NAVY);
  check('chord again flipped back', true);

  // ---- window system menu (todos/0102): Alt+Space raises the sysmenu on
  // the focused window; keyboard-only Move commits; Close via the menu tears
  // it down. A fresh winbox C keeps A/B (and the later legs) untouched. The
  // bare Alt KEYDOWN reaches the app (the os-snap "one toggle per chord"
  // rule — winbox flips green on it); only the Space-with-Alt chord is
  // swallowed, so C ends EXACTLY one toggle from orange: green. A leaked
  // Space would toggle it straight back to orange, so green IS the swallow
  // proof. Keys in the mode go to the menu grabber, not the app. ----
  await setVt(1);
  await page.keyboard.type('winbox &\r');
  await setVt(2);
  const CX = 96, CY = 108;                       // cascade slot 3
  // Wait for C's FOCUSED TITLE before touching anything (the 0215 flake):
  // the probe point (CX+200, CY+100) lies inside B's client too, so an
  // orange wait there is satisfied before C even maps (map-on-placement,
  // todos/0069) — and a canvas focus click sent while C's map is in flight
  // lands on whichever window the hit test finds THAT moment. Under load C
  // maps first, the click landed on C, and winbox's persistent 8x8 black
  // click mark sat exactly on the green-swallow probe below. The navy
  // title composites only once C is mapped, and create-focus (kernel
  // mechanism) makes it C's — after it the geometry is settled.
  await waitPixel(CX + 150, CY - 14, NAVY, 60000, "C's focused title — C mapped + focused");
  await waitPixel(CX + 200, CY + 100, ORANGE, 30000, "C's fill at the swallow-probe point");
  check('third winbox (C) composited and focused', true);
  // Focus click for the canvas — on C, but AWAY from every later probe:
  // the click paints winbox's black mark wherever it lands.
  await clickAt(CX + 30, CY + 30);
  // Alt+Space: the sysmenu appears and the Space keydown is swallowed —
  // C shows exactly the one Alt toggle (orange -> green).
  await page.keyboard.down('Alt');
  await page.keyboard.press('Space');
  await page.keyboard.up('Alt');
  // Wait on a FOCUS marker, not mere presence (todos/0199, the 0171 rule):
  // the arrows below only nav the menu if the sysmenu popup already holds
  // KERNEL focus (the kernel routes keys to the focused surface's owner —
  // an unfocused-yet-listed popup would drop them onto winbox C, leaving
  // the menu on the wrong row when Enter fires). `grep ctxmenu` proved the
  // popup EXISTS but not that it holds focus; the `f` flag in `wmctl list`
  // (FLAGS = the second-to-last field, `f` when focused) is that proof. In
  // practice create-focus (kernel SURFACE_CREATE) sets focus synchronously,
  // so the flag is already up when the popup lists — but asserting it makes
  // the leg fail LOUD if that ever regresses, instead of racing the arrows.
  await setVt(1);
  await page.keyboard.type(
    "wmctl wait win ctxmenu 8000 && wmctl list | " +
    "awk '$NF==\"ctxmenu\"&&$(NF-1)~/^f/{print \"SYSMENU-FOCUS\" \"ED\"}'\r");
  await page.waitForFunction(() => window.__osOut.includes('SYSMENU-FOCUSED'), { timeout: 20000, polling: 200 });
  check('Alt+Space opened the window system menu (popup holds focus)', true);
  await setVt(2);
  await waitPixel(CX + 200, CY + 100, GREEN, 30000,
    'the Alt-toggled fill; black = a click mark landed on the probe (0215)');
  check('the Space keydown was swallowed (fill = exactly the Alt toggle)', true);
  // Keyboard: Down -> Move (the engine's nav SKIPS grayed rows since 0259
  // — Restore is disabled on a floating window, so the first Down lands
  // on Move directly), Enter -> move mode; arrows nudge 8px; Enter
  // commits. Right x5 / Down x2 = +40 x, +16 y. Arrows/Enter go to the
  // menu grabber, not C, so the fill stays green through the move.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');            // commit + dismiss
  // C's old corner is NOT teal when exposed — B (orange, net-zero chord
  // toggles) sits underneath it; C's green fill vacating to B's orange is
  // the move proof. It must be a marker WAIT, not an instant sample: the
  // old "window extended right" waitPixel (CX+240, CY+116) sat inside C's
  // PRE-move footprint too, so it passed before the move composited and
  // the instant corner sample raced the frame (33% flake under --repeat).
  await waitPixel(CX + 5, CY + 5, ORANGE, 30000,
    "C's old corner vacated to B's orange — the move composited");
  check('keyboard Move relocated C (+40,+16)', true);
  // Re-open and Close via the menu (C moved to CX+40,CY+16): Down x5 ->
  // Close (grayed Restore skipped by the engine nav, 0259).
  await page.keyboard.down('Alt');
  await page.keyboard.press('Space');
  await page.keyboard.up('Alt');
  await setVt(1);   // focus marker again (todos/0199) — the Down x5 -> Close
                    // nav needs the re-opened popup to hold focus first.
  await page.keyboard.type(
    "wmctl wait win ctxmenu 8000 && wmctl list | " +
    "awk '$NF==\"ctxmenu\"&&$(NF-1)~/^f/{print \"SYSMENU2-FOCUS\" \"ED\"}'\r");
  await page.waitForFunction(() => window.__osOut.includes('SYSMENU2-FOCUSED'), { timeout: 20000, polling: 200 });
  await setVt(2);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');            // Close
  // Probe a moved-C point clear of A, B AND their drop shadows (B's client
  // ends at x=308; +4 frame +14/+3 shadow reach ~329) so teardown = teal.
  await waitPixel(350, 200, TEAL, 30000);
  check('Close via the sysmenu tore C down', true);

  // ---- taskbar always-on-top (todos/0038): drag B onto the bottom strip;
  // the bar is pinned to the TOP z layer (wm.c SET_LAYER), so it composites
  // and hit-tests ABOVE the dragged window — its buttons stay clickable. ----
  const preStrip = await sample(200, BARY);
  check('strip is furniture before the drag', near(preStrip, FACE) || near(preStrip, FACE_DOWN), preStrip);
  // Grab B's title, drop so the client top lands at SH-60: the window then
  // overlaps the strip (which starts at SH-28).
  await page.mouse.move(rect.x + BX + 100, rect.y + BY - 14);
  await page.mouse.down();
  await page.mouse.move(rect.x + BX + 100, rect.y + SH - 72, { steps: 8 });
  await page.mouse.up();
  await waitPixel(BX + 120, SH - 45, ORANGE);    // B's fill just above the bar
  check('winbox dragged onto the strip', true);
  const strip = await sample(200, BARY);
  check('taskbar still composited above the dragged window (todos/0038)',
    near(strip, FACE) || near(strip, FACE_DOWN), strip);
  // The button UNDER the overlap still clicks: B is focused, so its button
  // click must minimize it (pre-0038 the click landed in B's client).
  await clickAt(300, BARY);
  await waitPixel(BX + 120, SH - 45, TEAL);
  check('taskbar button under the overlap still clicks (B minimized)', true);
  await clickAt(300, BARY);                      // restore
  await waitPixel(BX + 120, SH - 45, ORANGE);
  check('...and restores', true);
  // wmctl agrees: the LAST list row (top of z) is the pinned taskbar.
  await setVt(1);
  await page.keyboard.type("wmctl list | sed '$!d' | grep -q taskbar && echo Z-TOP-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('Z-TOP-OK'), { timeout: 20000, polling: 200 });
  check('wmctl list: top of z is the taskbar (todos/0038)', true);
  await setVt(2);
  // Put B back where the kill-the-wm legs expect it.
  await waitPixel(BX + 150, SH - 66, NAVY);      // B's title, refocused settle
  await page.mouse.move(rect.x + BX + 100, rect.y + SH - 66);
  await page.mouse.down();
  await page.mouse.move(rect.x + BX + 100, rect.y + BY - 6, { steps: 8 });
  await page.mouse.up();
  await waitPixel(BX + 150, BY - 14, NAVY);
  check('winbox dragged back off the strip', true);

  // Kill the wm: the chord passes through — the focused winbox sees the
  // Tab keydown and toggles green (the kernel never eats keys without a
  // subscriber). B was clicked once above, so it carries one black mark.
  await setVt(1);
  await page.keyboard.type('WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//") && kill $WMPID && echo WM-DEAD\r');
  await page.waitForFunction(() => window.__osOut.includes('WM-DEAD'), { timeout: 20000, polling: 200 });
  await setVt(2);
  // The kill is cooperative (SIGTERM at a safe point): wait for the wm's
  // surfaces to actually vanish (taskbar strip -> teal) before the chord,
  // or the still-subscribed wm would eat it.
  await waitPixel(400, BARY, TEAL, 30000);
  check('wm dead: taskbar reclaimed', true);
  await clickAt(BX + 200, BY + 100);             // re-focus B post-kill
  const preToggle = await sample(BX + 220, BY + 130);
  await chord();
  await waitPixel(BX + 220, BY + 130, near(preToggle, ORANGE) ? GREEN : ORANGE);
  check('no WM: the chord reaches the app (fill toggled)', true);

  // no WM: Alt+Space is likewise NOT recognized — BOTH keydowns reach the
  // app (todos/0102, the EV_CYCLE rule): the Alt flips the fill, the Space
  // flips it back. Wait for each flip in turn so the two toggles can't
  // cancel into an indistinguishable no-op.
  const preAltSpace = await sample(BX + 220, BY + 130);
  const flipOf = c => (near(c, ORANGE) ? GREEN : ORANGE);
  await page.keyboard.down('Alt');
  await waitPixel(BX + 220, BY + 130, flipOf(preAltSpace));
  check('no WM: the Alt keydown reaches the app (fill toggled)', true);
  await page.keyboard.press('Space');
  await page.keyboard.up('Alt');
  await waitPixel(BX + 220, BY + 130, flipOf(flipOf(preAltSpace)));
  check('no WM: Alt+Space is not a chord — the Space toggles it back', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos wm (browser): PASS' : `\nos wm (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
