// Desktop-shell browser acceptance (todos/0028 start menu, Win7 two-pane
// restyle todos/0098 reverted to one Win95 column by todos/0132, todos/0029
// desktop icons): boot the reference OS page in headless Chromium and drive
// the /bin/wm shell furniture through the real UI-bridge path — canvas
// clicks -> kernel hit-test/rings -> wm.c policy — asserting composited
// pixels. Covers: the Start button, the single-column root (pinned/recents/
// All-Programs + a groove + the fixed places Settings/Run... + search box),
// the All Programs cascade, MRU recents relaunch, live search +
// Enter, the Run... place, menu open/dismiss; the desktop
// icon grid (EV_SCREEN-recreated at the live size), single-click select,
// double-click launch of term, minimize revealing the desktop; the 0089
// Control Panel applet hub (icon-folder composite, Sound applet in its
// own window, per-window close box, agent-tree volume/system drive); the
// 0090 system clipboard (notepad -> notepad Ctrl+A/C/V/X over the real
// VT2 keyboard path, cross-checked against /bin/clip on VT1).
//
// Usage: node os-shell.mjs   (manual tier — run the os-*.mjs sweep serially)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl, deskEntries, deskCell, menuGroups, menuLeaves } from './lib/os-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3197;
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

  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], NAVY = [0, 0, 128],
        FACE = [192, 192, 192], WHITE = [255, 255, 255];
  // Poll until a pixel stops matching `notWant` (the absence twin of waitPixel).
  const waitNotPixel = async (x, y, notWant, ms, what) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (!near(got, notWant)) return got;
      if (Date.now() - t0 > (ms || 30000))
        throw new Error(`pixel (${x},${y}) stayed ${notWant}${what ? ` (${what})` : ''}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  await setVt(2);
  // Derive geometry from the LIVE screen (todos/0023 rule).
  await waitScreen();
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickAt = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);
  const BARY = SH - 14;                          // mid-taskbar sample row

  // ---- the Start menu (todos/0028) ----
  await waitPixel(400, BARY, FACE, 60000);       // taskbar composited
  check('taskbar strip composited', true);

  // The clock (todos/0031): right-aligned HH.MM — histogram the black
  // text pixels over the clock cell (exact digits depend on the time). The
  // cell now sits left of the 0101 Show Desktop sliver (SHOWDESK_W = 14).
  const clockBlack = await page.evaluate(([x0, y0, w, h]) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) n++;
    return n;
  }, [SW - 18 - 75, SH - 28, 72, 18]);
  check('taskbar clock digits present (black-pixel histogram)', clockBlack >= 15, clockBlack);
  // The Start button face, right of the "START" label glyphs (x 8..38).
  check('Start button face at the taskbar left', near(await sample(74, BARY), FACE),
    await sample(74, BARY));

  // The single-column root (os/wm.c, todos/0098+0132 + follow-up): a fixed
  // 192x274 panel above the 28px taskbar. A 22px gucOS branding BAND runs down
  // the left, then a 170px column = pinned + MRU recents, a groove, the fixed
  // places Settings/Run..., a groove, and — XP/Vista/7 style — the "All
  // Programs" row at the BOTTOM, with a search box at its foot. Clear
  // recents/pins first so the column is deterministic ([Settings, Run...,
  // All Programs] at rows 0-2, AP_ROW=2); "All Programs" cascades the tree
  // snugly off the column's right edge — startmenu2 lists the GROUPS,
  // startmenu3 a group's leaves. Item x is offset past the SM_SIDE band.
  const SM_SIDE = 30, SM_COL = 260;
  const SM_W = SM_SIDE + SM_COL, SM_H = 378, SM_ROW_H = 28, SM_PAD = 4, SM_ROWS = 12;
  const SM_Y = SH - 36 - SM_H;
  const AP_ROW = SM_ROWS - 1;                    // All Programs DISPLAY row: pinned to
                                                 // the bottom (XP/Win7), above search
  const SM_SEARCH_Y = SM_Y + SM_PAD + SM_ROWS * SM_ROW_H + 4;
  // The Run... dialog (wm.c RUN_W/RUN_H, parked by handle_event at
  // (6, scr_h - BAR_H - RUN_H - 6)): its sunken white input box spans
  // (8,34)..(RUN_W-8,64) of the window and IS the observable "the dialog is
  // up". Derived once here — the legs below used to carry two different
  // hand-rolled offsets, one of them still on the pre-0132 28/70 geometry.
  const RUN_DW = 340, RUN_DH = 78, RUN_DX = 6, RUN_DY = SH - 36 - RUN_DH - 6;
  const RUN_FIELD = [RUN_DX + 194, RUN_DY + 50];   // inside the white field
  // Flyout columns are menucore chain levels since 0259: 18px rows, 1px
  // border, measured widths (edge-scanned below, never a constant).
  const MC_ROW = 30;
  const flyRowY = (i) => 1 + i * MC_ROW + 9;
  const flyH = (n) => 4 + n * MC_ROW;
  // Walk right from x0 along y until the desktop TEAL reappears — the
  // menu's measured right edge (its outer border is dark, never teal).
  const menuRightEdge = async (x0, y) => {
    for (let x = x0 + 59; x < x0 + 220; x++)
      if (near(await sample(x, y), TEAL)) return x;
    return -1;
  };
  // DERIVED from os/image.json + the non-gated packages/ defs (os-harness
  // menuGroups/menuLeaves — the 0164/0166 rule): the old hardcoded lists let
  // 0272's mgp-plus entry silently shift winbox's flyout row.
  const MENU_GROUPS = menuGroups();
  const DEMOS = menuLeaves('Demos');
  const winCount = async () => {
    await setVt(1);
    await page.waitForTimeout(400);              // timing subject: VT1 prompt-settle pacing (no page-observable marker)
    await page.keyboard.type('echo WBQ""$(wmctl list | grep -c "winbox$")\r', { delay: 40 });
    await page.waitForFunction(() => /WBQ\d/.test(window.__osOut), { timeout: 20000, polling: 200 });
    const out = await page.evaluate(() => window.__osOut);
    const n = +(/WBQ(\d+)(?![\s\S]*WBQ\d)/.exec(out)[1]);
    await page.evaluate(() => { window.__osOut = window.__osOut.replace(/WBQ\d+/g, ''); });
    await setVt(2);
    await page.waitForTimeout(300);              // timing subject: post-VT2 settle before returning (no marker)
    return n;
  };
  // Clear recents+pinned from VT1 so the column is deterministic — the fixed
  // places (Settings/Run...) sit right after All Programs at known rows (0132:
  // Run... moved from a fixed right-pane row into the column, so its row now
  // depends on the recents count).
  //
  // Two things this must NOT do, both of which it used to do:
  //
  //  - Needle its own ECHO. The kernel tty line discipline mirrors typed input
  //    into __osOut at TYPE time (the trap this file's last leg documents), and
  //    the tag was interpolated straight into the typed command — so
  //    `includes('RCLR1')` was satisfied by the keystrokes, before hush had run
  //    the `rm` at all. Under load wm then still read a recent at the next menu
  //    open, Settings/Run... stacked one row lower, and the fixed-row click
  //    below landed on Settings: the 67%-failure flake. Split the needle so the
  //    marker can only come from the shell's OUTPUT.
  //
  //  - Treat "the shell printed something" as "the state changed". Assert the
  //    POSTCONDITION instead: both files are gone. wm.c rebuilds the column
  //    from exactly these two files at every menu open (sm_rebuild_left <-
  //    menu_open_root), so "both absent" is precisely the state the row indices
  //    below depend on. A failed `test` prints nothing and the wait fails loud.
  let clrN = 0;
  const clearRecents = async () => {
    const tag = `RCLR${++clrN}`;
    await setVt(1);
    await page.keyboard.type(
      'R=/root/.config; rm -f $R/recent $R/pinned; ' +
      `test ! -e $R/recent && test ! -e $R/pinned && echo RCL""R${clrN}\r`, { delay: 40 });
    try {
      await page.waitForFunction((t) => window.__osOut.includes(t), tag, { timeout: 20000, polling: 200 });
    } catch {
      const tail = await page.evaluate(() => window.__osOut.slice(-300));
      throw new Error(`clearRecents: ${tag} never printed — ~/.config/{recent,pinned} ` +
        `were not both removed (VT1 tail: ${JSON.stringify(tail)})`);
    }
    await setVt(2);
  };
  // Solid non-face ink inside column DISPLAY row `r`'s text band. An empty row
  // slot is pure face gray; a row that lists something (a pin, a recent, or a
  // fixed place) carries glyph ink. The 4px inset keeps the Win95 grooves —
  // drawn on the pixel ABOVE a row — out of the band, and the >40 threshold
  // keeps freetype's AA fringe out of the count.
  const rowInk = (r) => page.evaluate(([x0, y0, w, h]) => {
    const c = document.getElementById('screen');
    const rc = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(rc.width); t.height = Math.round(rc.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (Math.abs(d[i] - 192) > 40 || Math.abs(d[i + 1] - 192) > 40 ||
          Math.abs(d[i + 2] - 192) > 40) n++;
    return n;
  }, [SM_SIDE + 4, SM_Y + SM_PAD + r * SM_ROW_H + 4, SM_COL - 10, SM_ROW_H - 8]);
  // Open the Start menu and block until the COLUMN ITSELF shows the cleared
  // state — the todos/0171 rule: synchronise on the thing you depend on, not on
  // a proxy for it. wm.c stacks pins, then recents, then Settings and Run...,
  // with All Programs pinned to the bottom slot; so with the store cleared rows
  // 0/1 are the two fixed places and row 2 — the first slot any survivor would
  // occupy — is blank. This is a WAIT on the drawn panel (the face fill can
  // composite a frame before the glyphs), never a re-click or a re-open: if the
  // column still lists something the leg fails HERE, naming the cause, instead
  // of clicking Settings and leaving a 30s dialog timeout to be diagnosed.
  const openMenuOnFixedPlaces = async (what) => {
    await clickAt(25, BARY);                     // Start
    await waitPixel(120, SM_Y + 74, FACE, 30000, 'the Start panel parked above the taskbar');
    const t0 = Date.now();
    let ink = [];
    for (;;) {
      ink = [await rowInk(0), await rowInk(1), await rowInk(2)];
      if (ink[0] > 20 && ink[1] > 20 && ink[2] <= 2) return;
      if (Date.now() - t0 > 10000) break;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(
      `${what}: the Start column is not showing the fixed places at rows 0-1 — ` +
      `row ink [${ink.join(', ')}], expected [>20, >20, ~0]. Ink at row 2 means a ` +
      `pin/recent survived clearRecents(), which pushes Settings/Run... down a row.`);
  };
  await setVt(1);
  await page.keyboard.type('rm -f /root/.config/recent /root/.config/pinned && echo REC""-CLR\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('REC-CLR'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(400, BARY, FACE);
  await waitPixel(120, SM_Y + 74, TEAL);         // wait on the observable the check asserts (was a blind settle)

  check('menu spot is desktop before the click', near(await sample(120, SM_Y + 74), TEAL),
    await sample(120, SM_Y + 74));
  // Map-on-placement (todos/0069): burst-capture frames THROUGH the open —
  // the menu must never composite at the kernel cascade default (the
  // top-left band) before appearing parked above the taskbar. (120, SM_Y+74)
  // is an empty column row (recents cleared -> rows 0-2 are Settings + Run... +
  // All Programs, so row 3 at y+74 is blank), face gray only once parked.
  const CASC_H = Math.min(460, SM_Y - 10);
  const burst = page.evaluate(([px0, py0, ch]) => new Promise((resolve) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d', { willReadFrequently: true });
    const frames = [];
    let extra = 0;
    const grey = (d, i) => Math.abs(d[i] - 192) <= 8 &&
      Math.abs(d[i + 1] - 192) <= 8 && Math.abs(d[i + 2] - 192) <= 8;
    const step = () => {
      ctx.drawImage(c, 0, 0);
      const p = ctx.getImageData(px0, py0, 1, 1).data;
      const parked = grey(p, 0);
      const d = ctx.getImageData(0, 24, 460, ch - 24).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (grey(d, i)) n++;
      frames.push([parked ? 1 : 0, n]);
      if (parked) extra++;
      if (extra >= 5 || frames.length >= 600) return resolve(frames);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), [120, SM_Y + 74, CASC_H]);
  await page.waitForTimeout(100);                // timing subject: let the rAF burst-capture start before the click (no marker)
  await clickAt(25, BARY);                       // Start (x < 50)
  const frames = await burst;
  check('Start click opens the single-column root (face fill above the taskbar)',
    frames.some(f => f[0] === 1), frames.length);
  const maxCasc = Math.max(...frames.map(f => f[1]));
  check('no first-frame teleport: nothing composited in the cascade band (todos/0069)',
    maxCasc < 300, { maxCasc, frames: frames.length });
  await waitPixel(120, SM_Y + 74, FACE);         // settle

  // The gucOS branding band down the left (x < SM_SIDE): a blue gradient
  // (blue channel high, red low).
  {
    const b = await sample(15, SM_Y + Math.floor(SM_H / 4));
    check('gucOS branding band is a blue gradient down the left',
      b && b[2] > 60 && b[0] < 40, b);
  }
  // The search box is a sunken white field at the foot of the column (right
  // of the band). Sample clear of the "Search" ghost: the freetype glyphs
  // (Phase C) cover x up to ~SM_SIDE+45 where the 5x7 left this spot blank.
  check('search box is a white field at the foot of the column',
    near(await sample(SM_SIDE + 150, SM_SEARCH_Y + 8), [255, 255, 255]),
    await sample(SM_SIDE + 150, SM_SEARCH_Y + 8));

  // All Programs (the BOTTOM row) cascades the tree flyout of groups
  // (startmenu2 at x = SM_W - 3), which cascades UPWARD via the work-area
  // clamp (bottom-anchored, Win7); then a group cascades its leaves
  // (startmenu3, itself clamped). Hover All Programs, then the Demos group.
  const clampY = (y, n) => {                     // the win_create work-area clamp
    const h = flyH(n);
    return y + h > SH - 28 ? SH - 28 - h : y;
  };
  await page.mouse.move(rect.x + 60, rect.y + SM_Y + SM_PAD + AP_ROW * SM_ROW_H + 10);
  const FLY2_X = SM_W - 3;
  const FLY2_Y = clampY(SM_Y + AP_ROW * SM_ROW_H, MENU_GROUPS.length);
  await waitPixel(FLY2_X + 5, FLY2_Y + 6, FACE);   // row-0 left gutter
  check('All Programs cascades the tree flyout', true);
  const DEMOS_ROW = MENU_GROUPS.indexOf('Demos');
  // The tree column's width is measured (freetype) — scan its right edge,
  // then hover the Demos row inside it.
  const FLY2_R = await menuRightEdge(FLY2_X, FLY2_Y + 6);
  check('tree flyout right edge found', FLY2_R > 0, FLY2_R);
  await page.mouse.move(rect.x + FLY2_X + 30, rect.y + FLY2_Y + flyRowY(DEMOS_ROW));
  // startmenu3 parks at tree-right - 3, anchored to the Demos row's top.
  const FLY3_X = FLY2_R - 3;
  const FLY3_Y = clampY(FLY2_Y + 1 + DEMOS_ROW * MC_ROW, DEMOS.length);
  await waitPixel(FLY3_X + 5, FLY3_Y + 6, FACE);
  check('the Demos group cascades its leaves', true);
  await clickAt(FLY3_X + 30, FLY3_Y + flyRowY(DEMOS.indexOf('winbox')));
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000);
  check('nested flyout click launched winbox (orange fill at the WM placement)', true);
  await waitPixel(120, SM_Y + 74, TEAL);
  check('selection dismissed the whole cascade', true);

  // Recents (todos/0098): the launch above recorded winbox; re-open and the
  // MRU appears as left row 0 (above All Programs) — clicking it relaunches.
  const wb0 = await winCount();
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  check('menu re-opens', true);
  await clickAt(60, SM_Y + 14);                  // left row 0 = the winbox recent
  await page.waitForTimeout(500);                // timing subject: let the MRU relaunch spawn before the coordinate-free winCount snapshot
  const wb1 = await winCount();
  check('recent MRU entry relaunches the program (winbox +1)', wb1 === wb0 + 1, { wb0, wb1 });

  // Live search (todos/0098): type into the search box (the root holds
  // focus); the flat tree walk narrows and the top hit highlights navy. Esc
  // clears the query then closes; a fresh open + type + Enter launches it.
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.type('winbox', { delay: 60 });
  await waitPixel(100, SM_Y + 14, NAVY);
  check('search highlights the top hit (navy row 0)', true);
  await page.keyboard.press('Escape');           // clear the search (menu stays)
  await waitPixel(120, SM_Y + 74, FACE);
  check('Esc clears the search but keeps the menu open', true);
  await page.keyboard.press('Escape');           // close the menu
  await waitPixel(120, SM_Y + 74, TEAL);
  const wb2 = await winCount();
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.type('winbox', { delay: 60 });
  await waitPixel(100, SM_Y + 14, NAVY);
  await page.keyboard.press('Enter');            // launch the top hit
  await page.waitForTimeout(500);                // timing subject: let the search-hit spawn before the coordinate-free winCount snapshot
  const wb3 = await winCount();
  check('Enter launches the search top hit (winbox +1)', wb3 === wb2 + 1, { wb2, wb3 });

  // The Run... place is column row 1 (after Settings): click it, the dialog
  // opens (see the builtin leg below). clearRecents() + openMenuOnFixedPlaces()
  // make that row a VERIFIED position rather than an assumed one.
  //
  // "the menu dismissed" alone used to be this leg's whole assertion, and it is
  // satisfied by clicking ANY row — every one of them dismisses on its way to
  // launching something. So a wrong click passed here and detonated further
  // down. Assert the dialog's own input box: only Run... produces it.
  await clearRecents();
  await openMenuOnFixedPlaces('Run... dismiss leg');
  await clickAt(60, SM_Y + SM_PAD + 1 * SM_ROW_H + 14);   // column row 1 = Run...
  await waitPixel(RUN_FIELD[0], RUN_FIELD[1], WHITE, 30000, 'the run dialog input box');
  check('Run... click opens the run dialog', true);
  await waitPixel(120, SM_Y + 74, TEAL);
  check('Run... click dismisses the menu behind the dialog', true);
  await page.keyboard.press('Escape');           // close the run dialog
  // ...and wait for it to actually GO. The next leg re-opens the Start menu; a
  // dialog still up owns the keyboard and the focus that dismisses the menu.
  await waitNotPixel(RUN_FIELD[0], RUN_FIELD[1], WHITE, 30000, 'the run dialog after Esc');

  // Focus change dismisses: re-open, click the winbox window.
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await clickAt(12 + 120, 36 + 80);              // winbox client click
  await waitPixel(120, SM_Y + 74, TEAL);
  check('focus change dismisses the menu', true);

  // Start toggles: open, then a second Start click closes.
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, TEAL);
  check('Start click toggles the menu closed', true);

  // Keyboard (todos/0078): Esc closes the open menu (the root holds focus),
  // and the Ctrl+Esc chord toggles it from anywhere (kernel wmKey -> WMP
  // EV_MENU -> the same menu_toggle).
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.press('Escape');
  await waitPixel(120, SM_Y + 74, TEAL);
  check('Esc dismisses the menu', true);
  await page.keyboard.press('Control+Escape');
  await waitPixel(120, SM_Y + 74, FACE);
  check('Ctrl+Esc opens the Start menu (the chord)', true);
  await page.keyboard.press('Control+Escape');
  await waitPixel(120, SM_Y + 74, TEAL);
  check('Ctrl+Esc toggles it closed again', true);

  // ---- /etc/menu is searched (the 0259 UNION: both trees walked, /etc
  // first — pre-0259 first-existing-dir made it a shadowing override) ----
  // Create a single launcher, search its name, Enter launches it.
  await setVt(1);
  await page.keyboard.type('mkdir /etc/menu && ln -s /usr/bin/winbox /etc/menu/solo && echo MENU""-SET\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('MENU-SET'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(400, BARY, FACE);
  await page.waitForTimeout(800);                // timing subject: let wm pick up the new /etc/menu before the winCount baseline (no marker)
  const wo0 = await winCount();
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.type('solo', { delay: 60 });
  await waitPixel(100, SM_Y + 14, NAVY);
  check('override tree is searched (solo hit highlights)', true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);                // timing subject: let the override-search spawn before the coordinate-free winCount snapshot
  const wo1 = await winCount();
  check('override search hit launches (winbox +1)', wo1 === wo0 + 1, { wo0, wo1 });
  await setVt(1);
  await page.keyboard.type('rm -rf /etc/menu && echo MENU""-RESET\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('MENU-RESET'), { timeout: 20000, polling: 200 });
  await setVt(2);
  // The revert is a MENU fact, not a filesystem one. The MENU-RESET marker is
  // correctly split, so it genuinely proves `rm -rf /etc/menu` ran — but that
  // is all it proves, and this leg used to claim the union had reverted purely
  // on that. The feature's "on" direction was tested and its "off" direction
  // asserted by fiat, so a stale-index bug in the 0259 /etc + /usr/share union
  // would have been invisible here. Assert the inverse of the set side: re-open
  // the menu and search `solo` — the top row must NOT highlight.
  //
  // An absence assertion needs a positive control, or a search box that stopped
  // receiving keys entirely satisfies it just as well. So in the SAME open,
  // Esc-clear the query and search the baked `winbox` leaf: that row must still
  // highlight, which proves the box was live throughout.
  await waitPixel(400, BARY, FACE);
  await page.waitForTimeout(800);                // timing subject: the same coarse wm menu re-read tick the set side waits on (no marker)
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.type('solo', { delay: 60 });
  await page.waitForTimeout(800);                // timing subject: an absence has no marker to wait on — settle, then sample
  const soloRow = await sample(100, SM_Y + 14);
  check('override removed: `solo` no longer hits the search', !near(soloRow, NAVY), soloRow);
  await page.keyboard.press('Escape');           // clear the query (menu stays open)
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.type('winbox', { delay: 60 });
  await waitPixel(100, SM_Y + 14, NAVY);
  check('...and the search box was live throughout (baked `winbox` still hits)', true);
  await page.keyboard.press('Escape');           // clear the query
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.press('Escape');           // close the menu
  await waitPixel(120, SM_Y + 74, TEAL);

  // The Start-menu legs above launched several winboxes (recents, search, the
  // override); close them all so the desktop section starts from a clean
  // taskbar — the minimize leg below expects term to be the sole button, and a
  // floating window over column 0 would intercept the marquee's mouse-down (the
  // icons sit at the bottom of z, a window does not).
  //
  // `wmctl close` only POSTS the close; the shell echo says the requests went
  // out, not that the windows are gone. Gate the marker on `wmctl wait nowin`
  // — an absence condition that SUCCEEDS on absence rather than napping out a
  // clock — so a window that refuses to die prints nothing and this fails loud.
  // (This used to be two copies of the same close loop, the second of them
  // "synchronised" by `!/\twinbox$/m.test(...) || true`, a predicate that is
  // true on its first poll no matter what the OS is doing, plus two 800ms naps.)
  await setVt(1);
  await page.keyboard.type('for s in $(wmctl list | grep "winbox$" | sed "s/[^0-9].*//"); do wmctl close $s; done; ' +
    'wmctl wait nowin winbox 15000 && echo WB""-CLOSED\r', { delay: 30 });
  await page.waitForFunction(() => window.__osOut.includes('WB-CLOSED'), { timeout: 30000, polling: 200 });
  await setVt(2);
  await waitPixel(400, BARY, FACE);

  // ---- the desktop layer (todos/0029) ----
  // (WHITE and waitNotPixel are declared with the other pixel helpers up top —
  // the Start-menu legs need them too since the Run... dialog probes landed.)

  // Icons flow down the left edge, sorted. The grid model is the harness's
  // deskEntries/deskCell (the todos/0166 rule: derived from os/image.json,
  // never hardcoded — and since 0184/0185 the seeded set wraps into column
  // 1 and leads with the Presentations DIR, so cells are looked up at the
  // LIVE screen height). Probes below use doom (a 4-char label like the
  // old term probe: label starts at cell x+30) in column 0; term now sits
  // in column 1 and keeps the double-click-launch role. (The winboxes the
  // Start-menu legs launched were closed just above, gated on their absence.)
  const DESK_ENTRIES = deskEntries();
  const cell = (name) => deskCell(DESK_ENTRIES, name, SH);
  // The selection strip is `lx-2 .. lx+lw+2` at cy+40..63; its 2px LEFT
  // MARGIN (before the white label text) is the reliable pure-navy probe.
  // lw ~= min(len,9)*12 at the 12px mono advance; sample the margin center.
  const stripL = (c, name) =>
    [c.x + Math.floor((116 - Math.min(name.length, 9) * 12) / 2) - 1, c.y + 50];
  const DC = cell('doom');
  const I3X = DC.x + 42, I3Y = DC.y + 6;         // doom's icon tile origin
  await waitPixel(I3X + 2, I3Y + 2, WHITE);
  check(`desktop icon tile composited (doom, cell ${DC.col},${DC.row})`, true);
  check('icon glyph navy center', near(await sample(I3X + 16, I3Y + 16), NAVY),
    await sample(I3X + 16, I3Y + 16));
  // The Presentations folder icon (todos/0185): tab+body glyph — the tab
  // notch leaves (+16,+6) of the tile white where a launcher block is navy.
  const FC = cell('Presentations');
  check('folder glyph on the Presentations icon (white tab notch, navy body)',
    near(await sample(FC.x + 42 + 21, FC.y + 6 + 8), WHITE) &&
    near(await sample(FC.x + 42 + 10, FC.y + 6 + 16), NAVY),
    [await sample(FC.x + 42 + 21, FC.y + 6 + 8), await sample(FC.x + 42 + 10, FC.y + 6 + 16)]);

  // Single click: selection highlight (navy label strip), NO launch.
  await clickAt(DC.x + 58, I3Y + 16);
  { const [lx, ly] = stripL(DC, 'doom'); await waitPixel(lx, ly, NAVY); }   // label strip left
  check('single click selects (navy label strip)', true);

  // ---- selection & manipulation (todos/0077) ----
  // The click above also focused the desktop (wm.c policy), so modifier
  // and navigation keys reach the icon grid from here on.
  // Ctrl+click paint: additive — doom stays.
  const MC = cell('paint');
  const MSTRIP = stripL(MC, 'paint');            // paint label strip left margin
  await page.keyboard.down('Control');
  await clickAt(MC.x + 58, MC.y + 48);
  await page.keyboard.up('Control');
  await waitPixel(MSTRIP[0], MSTRIP[1], NAVY);
  check('ctrl+click adds to the selection (paint strip navy)', true);
  { const [lx, ly] = stripL(DC, 'doom');
    check('...and doom stays selected', near(await sample(lx, ly), NAVY), await sample(lx, ly)); }

  // Marquee from empty desktop over two vertically-adjacent column-0 tiles
  // (fileman + notepad — #434 removed the three sameboy launchers, so the
  // seeded set is three icons shorter): REPLACES the set — paint drops out.
  const FMC = cell('fileman'), GC = cell('notepad');
  // Box the two icon TILES (icon at cell.x+42..74, y cell.y+6..38): start
  // at empty desktop above-right of the pair, drag through both, stopping
  // above paint's row (fileman + notepad rows swept, paint's excluded).
  // The marquee must START in an EMPTY cell: desk_hit is CELL-based (a
  // press anywhere inside an occupied cell selects that icon and arms an
  // icon-move, not a marquee). Column 1 has only term and the Recycle Bin,
  // so everything from column 2 right is empty — start 3 columns right of
  // fileman and sweep back-left across the two tiles, staying above
  // paint's row.
  const mqTop = Math.min(FMC.y, GC.y) - 14, mqBot = Math.max(FMC.y, GC.y) + 44;
  await page.mouse.move(rect.x + FMC.x + 360, rect.y + mqTop);
  await page.mouse.down();
  await page.mouse.move(rect.x + FMC.x + 180, rect.y + (mqTop + mqBot) / 2, { steps: 6 });
  await page.mouse.move(rect.x + FMC.x + 40, rect.y + mqBot, { steps: 6 });
  await page.mouse.up();
  { const [lx, ly] = stripL(FMC, 'fileman'); await waitPixel(lx, ly, NAVY); }  // fileman strip
  check('marquee selects the intersected icons (fileman strip navy)', true);
  { const [lx, ly] = stripL(GC, 'notepad');
    check('notepad caught by the marquee too', near(await sample(lx, ly), NAVY), await sample(lx, ly)); }
  check('marquee replaces: paint deselected', near(await sample(MSTRIP[0], MSTRIP[1]), TEAL),
    await sample(MSTRIP[0], MSTRIP[1]));

  // Drag-move: a plain click on the selected ctlpanel collapses the set to
  // it (mouseup rule); past the 500ms double-click window, drag it two
  // columns right — (0,r) -> (2,r), snapped and persisted (.icons).
  const PC = cell('ctlpanel');
  await clickAt(PC.x + 58, PC.y + 48);
  await new Promise(r => setTimeout(r, 600));
  await page.mouse.move(rect.x + (PC.x + 58), rect.y + (PC.y + 48));
  await page.mouse.down();
  await page.mouse.move(rect.x + (PC.x + 58 + 116), rect.y + (PC.y + 48), { steps: 3 });
  await page.mouse.move(rect.x + (PC.x + 58 + 232), rect.y + (PC.y + 48), { steps: 3 });
  await page.mouse.up();
  await waitPixel(PC.x + 232 + 44, PC.y + 8, WHITE);   // tile ring at the new cell
  check('drag repositions the icon (tile at col 2)', true);
  check('the old cell is teal again', near(await sample(PC.x + 58, PC.y + 22), TEAL),
    await sample(PC.x + 58, PC.y + 22));
  check('moved icon stays selected (strip navy at the new cell)',
    near(await sample(PC.x + 232 + (stripL(PC,'ctlpanel')[0]-PC.x), stripL(PC,'ctlpanel')[1]), NAVY),
    await sample(PC.x + 232 + (stripL(PC,'ctlpanel')[0]-PC.x), stripL(PC,'ctlpanel')[1]));

  // Esc clears the selection (the desktop holds focus).
  await page.keyboard.press('Escape');
  await waitPixel(PC.x + 232 + (stripL(PC,'ctlpanel')[0]-PC.x), stripL(PC,'ctlpanel')[1], TEAL);
  check('Esc clears the selection', true);

  // Double-click launches term (640x456 at the cascade slot; term's live
  // cell — column 1 since the wrap). Sample a point inside term but
  // outside winbox; wait for it to leave teal.
  const TC = cell('term');
  await page.mouse.dblclick(rect.x + (TC.x + 58), rect.y + (TC.y + 22));
  await waitNotPixel(500, 300, TEAL, 90000);     // freetype startup is slow
  check('double-click launched term (window composited)', true);

  // wmctl from VT1: the desktop layer tracks the LIVE screen (EV_SCREEN
  // recreate on the VT2-entry resize) and sits at the bottom of z.
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => window.__osOut.split('\n').some(l => l.trim().endsWith('desktop')), { timeout: 20000, polling: 200 });
  const dline = await page.evaluate(() => window.__osOut.split('\n').find(l => l.trim().endsWith('desktop')));
  check('desktop layer recreated at the live screen size (EV_SCREEN)',
    dline.includes(`${SW}x${SH}+0+0`), { dline, SW, SH });
  check('desktop layer at the bottom of z', dline.split('\t')[4] === '0', dline);
  await setVt(2);

  // Minimize term via its taskbar button (button 0 — the winboxes were
  // closed above, so term is the sole button): the desktop shows through
  // where the window was. The app strip starts past the Start strip AND the
  // Task-View/overview button (todos/EXPOSE), so button 0 is at x~112.
  await clickAt(150, BARY);
  await waitPixel(500, 300, TEAL);
  check('minimize reveals the desktop', true);

  // ---- the Run... builtin (todos/0078; folded into the column by 0132) ----
  // Start -> the Run... place opens the dialog (RUN_DW x RUN_DH bottom-left,
  // white input box); typed command + Enter spawns via /bin/sh -c.
  //
  // The row-1 click is a VERIFIED position, not an assumed one: clearRecents()
  // proves the store is empty (postcondition, not echo) and
  // openMenuOnFixedPlaces() proves the drawn column reflects that before the
  // click. This leg is the one the 67% flake surfaced on — it used to open the
  // menu and click row 1 with only a shell echo behind it, so under load the
  // click landed on Settings and the dialog wait timed out 30s later with a
  // bare "pixel never became white".
  const rb0 = await winCount();
  await clearRecents();
  await openMenuOnFixedPlaces('Run... builtin leg');
  await clickAt(60, SM_Y + SM_PAD + 1 * SM_ROW_H + 14);   // Run... (column row 1)
  await waitPixel(RUN_FIELD[0], RUN_FIELD[1], WHITE, 30000, 'the run dialog input box');
  check('Run... place opens the run dialog', true);
  check('the menu closed behind it', near(await sample(120, SM_Y + 74), TEAL),
    await sample(120, SM_Y + 74));
  await page.keyboard.type('winbox');
  await page.keyboard.press('Enter');
  await waitNotPixel(RUN_FIELD[0], RUN_FIELD[1], WHITE, 30000, 'the run dialog after Enter');
  check('Enter closes the dialog', true);
  const rb1 = await winCount();
  check('run-dialog command spawned (winbox +1)', rb1 === rb0 + 1, { rb0, rb1 });

  // ---- Control Panel v2: the applet hub (todos/0089) ----
  // Launch from VT1, parse LIVE geometry from wmctl list (the 0023 rule),
  // then drive the real pixel path on VT2: single-click the Sound icon in
  // the hub folder -> the applet opens as its OWN window; the kernel close
  // box on the applet closes IT and the hub survives (the 0089 per-window
  // WM_CLOSE); the 0048 volume/system behaviour still drives through the
  // agent tree, now inside the applets.
  await setVt(1);
  await page.keyboard.type('ctlpanel &\r');
  // Let hush print its async job notice before typing more — the notice
  // redraw mid-line mangles a long typed command. And emit markers with
  // a split quote so the TYPED echo never contains the marker string
  // (waitForFunction must fire on the output, not the input echo).
  await page.waitForTimeout(800);                // timing subject: async job-notice ([1] pid) has no distinct page-observable marker
  await page.keyboard.type('i=0; while [ $i -lt 30 ]; do wmctl list | grep -q "Control Panel" && break; sleep 1; i=$((i+1)); done; wmctl list; echo CP-U""P\r');
  await page.waitForFunction(() => window.__osOut.includes('CP-UP'), { timeout: 120000, polling: 200 });
  const cpLine = await page.evaluate(() => window.__osOut.split('\n').find(l => /Control Panel\s*$/.test(l)));
  check('ctlpanel hub listed', !!cpLine,
    cpLine || await page.evaluate(() => window.__osOut.slice(-400)));
  const cpGeom = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(cpLine || '');
  const [CPW, CPH, CPX, CPY] = cpGeom ? cpGeom.slice(1).map(Number) : [0, 0, 0, 0];
  await setVt(2);
  await waitPixel(CPX + CPW - 6, CPY + CPH - 4, WHITE);
  check('hub composites as an icon folder (white interior)', true);
  // Icon 0 (Sound) is selected by default: navy label strip, left of text.
  check('default selection strip navy (Sound label)',
    near(await sample(CPX + 8 + 6, CPY + 8 + 47), NAVY),
    await sample(CPX + 8 + 6, CPY + 8 + 47));
  // Single-click the Sound icon (hub client cell 0): the applet opens.
  await clickAt(CPX + 46, CPY + 38);
  await setVt(1);
  await page.keyboard.type('i=0; while [ $i -lt 20 ]; do wmctl list | grep -q "Sound Properties" && break; sleep 1; i=$((i+1)); done; wmctl list; echo CP-SN""D\r');
  await page.waitForFunction(() => window.__osOut.includes('CP-SND'), { timeout: 60000, polling: 200 });
  const sndLine = await page.evaluate(() => window.__osOut.split('\n').find(l => /Sound Properties\s*$/.test(l)));
  check('Sound applet opened as its own window', !!sndLine,
    sndLine || await page.evaluate(() => window.__osOut.slice(-400)));
  const sndGeom = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(sndLine || '');
  const [SNW, , SNX, SNY] = sndGeom ? sndGeom.slice(1).map(Number) : [0, 0, 0, 0];
  await setVt(2);
  await waitPixel(SNX + 240, SNY + 92, FACE);
  check('Sound applet composites (face interior)', true);
  // The 0048 volume drive, through the applet's agent tree.
  await setVt(1);
  await page.keyboard.type('wmctl click "Vol +"; sleep 1; wmctl gettext STATIC:0; echo CP-VO""L\r');
  await page.waitForFunction(() => window.__osOut.includes('CP-VOL'), { timeout: 30000, polling: 200 });
  check('Vol + through the applet steps the kernel gain (110%)',
    await page.evaluate(() => window.__osOut.includes('Volume: 110%')), true);
  // The System applet, through the agent path (icon label click).
  await page.keyboard.type('wmctl click System; sleep 1; wmctl tree | grep "NAME="; echo CP-SY""S\r');
  await page.waitForFunction(() => window.__osOut.includes('CP-SYS'), { timeout: 30000, polling: 200 });
  check('System applet shows os-release',
    await page.evaluate(() => /NAME=gucOS/.test(window.__osOut)), true);
  await setVt(2);
  // Kernel close box on the Sound applet: per-window close (0089).
  await clickAt(SNX + SNW - 12, SNY - 12);
  await setVt(1);
  await page.keyboard.type('sleep 1; echo CP-MAR""K; wmctl list; echo CP-AFTE""R\r');
  await page.waitForFunction(() => window.__osOut.includes('CP-AFTER'), { timeout: 30000, polling: 200 });
  const afterClose = await page.evaluate(() =>
    window.__osOut.slice(window.__osOut.lastIndexOf('CP-MARK')));
  check('close box closes only the applet: hub + System alive, Sound gone',
    /Control Panel/.test(afterClose) && /System Properties/.test(afterClose) &&
    !/Sound Properties/.test(afterClose), afterClose.slice(0, 400));
  await setVt(2);

  // ---- System clipboard (todos/0090): notepad -> notepad over the real
  // keyboard path. Type into one notepad on VT2, Ctrl+A/Ctrl+C, Ctrl+V
  // into a SECOND notepad process; Ctrl+X empties the source while the
  // kernel slot keeps the text. gettext EDIT:0 is tree-order-global
  // across processes (the 0089 gotcha), so the paste is asserted by a
  // black-glyph histogram over the second notepad's client area and the
  // cut through EDIT:0, which resolves to the FIRST notepad.
  const blackIn = (x0, y0, w, h) => page.evaluate(([bx, by, bw, bh]) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(bx, by, bw, bh).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) n++;
    return n;
  }, [x0, y0, w, h]);
  const npLines = () => page.evaluate(() =>
    window.__osOut.split('\n').filter(l => /Notepad\s*$/.test(l)));
  await setVt(1);
  await page.keyboard.type('notepad &\r');
  await page.waitForTimeout(800);                // timing subject: the async job-notice trap (no distinct page-observable marker)
  await page.keyboard.type('i=0; while [ $i -lt 30 ]; do wmctl list | grep -q Notepad && break; sleep 1; i=$((i+1)); done; sleep 1; wmctl list; echo NP-U""P1\r');
  await page.waitForFunction(() => window.__osOut.includes('NP-UP1'), { timeout: 120000, polling: 200 });
  const np1Line = (await npLines()).pop() || '';
  const np1 = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(np1Line);
  check('first notepad listed', !!np1, np1Line);
  const [N1W, , N1X, N1Y] = np1 ? np1.slice(1).map(Number) : [0, 0, 0, 0];
  await setVt(2);
  // Click into the EDIT (below the 20px in-surface menu bar), type, copy.
  // PACED input: zero-delay typing floods the per-frame pump and drops
  // events (chars vanish, the Control keydown separates from its letter),
  // so type with a delay and hold Control across explicitly-gapped presses.
  const chord = async (letter) => {
    // timing subject: the Ctrl chord is hand-paced — zero-delay presses flood
    // the per-frame input pump and drop events (see the PACED-input note above);
    // there is no page-observable marker between the down/press/up steps.
    await page.keyboard.down('Control');
    await page.waitForTimeout(100);             // timing subject: paced Ctrl chord (see note above)
    await page.keyboard.press(letter);
    await page.waitForTimeout(100);             // timing subject: paced Ctrl chord (see note above)
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);             // timing subject: paced Ctrl chord settle (see note above)
  };
  await clickAt(N1X + Math.min(120, N1W - 20), N1Y + 60);
  await page.waitForTimeout(300);                // timing subject: EDIT focus-click settle before typing (no marker)
  await page.keyboard.type('CLIP-ROCKS', { delay: 60 });
  await page.waitForTimeout(400);                // timing subject: let the typed text land before the Ctrl chord (no marker)
  await chord('a');
  await chord('c');
  await setVt(1);
  await page.keyboard.type('sleep 1; clip -o; echo " "CLIP-GO""T1\r');
  await page.waitForFunction(() => window.__osOut.includes('CLIP-GOT1'), { timeout: 30000, polling: 200 });
  check('Ctrl+C filled the kernel slot (clip -o)',
    await page.evaluate(() => window.__osOut.includes('CLIP-ROCKS CLIP-GOT1')),
    await page.evaluate(() => window.__osOut.slice(-300)));
  // Second notepad; find ITS list line (the one that isn't notepad 1's).
  await page.keyboard.type('notepad &\r');
  await page.waitForTimeout(800);                // timing subject: the async job-notice trap (no distinct page-observable marker)
  await page.keyboard.type('i=0; while [ $i -lt 30 ]; do [ $(wmctl list | grep -c Notepad) -ge 2 ] && break; sleep 1; i=$((i+1)); done; sleep 1; wmctl list; echo NP-U""P2\r');
  await page.waitForFunction(() => window.__osOut.includes('NP-UP2'), { timeout: 120000, polling: 200 });
  const np2Line = (await npLines()).filter(l => !l.includes(`+${N1X}+${N1Y}`)).pop() || '';
  const np2 = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(np2Line);
  check('second notepad listed at its own position', !!np2, np2Line);
  const [N2W, , N2X, N2Y] = np2 ? np2.slice(1).map(Number) : [0, 0, 0, 0];
  await setVt(2);
  const npClient = [N2X + 8, N2Y + 28, Math.min(220, N2W - 16), 44];
  const beforePaste = await blackIn(...npClient);
  await clickAt(N2X + Math.min(120, N2W - 20), N2Y + 60);
  await page.waitForTimeout(300);                // timing subject: EDIT focus-click settle before the paste chord (no marker)
  await chord('v');
  await page.waitForTimeout(1000);               // timing subject: let the pasted glyphs render before the histogram sample (no single-pixel marker)
  const afterPaste = await blackIn(...npClient);
  check('Ctrl+V renders the pasted text in the second notepad',
    afterPaste > beforePaste + 30, `${beforePaste} -> ${afterPaste}`);
  // Ctrl+X in the FIRST notepad: source emptied, slot still has the text.
  // Click its LEFT edge — the second notepad cascades +28,+24 and covers
  // the client center, and a covered click would focus THAT window.
  await clickAt(N1X + 12, N1Y + 60);
  await page.waitForTimeout(300);                // timing subject: EDIT focus-click settle before the select-all chord (no marker)
  await chord('a');
  await chord('x');
  await setVt(1);
  await page.keyboard.type('sleep 1; echo GT-"["$(wmctl gettext EDIT:0)"]"; clip -o; echo " "CLIP-GO""T2\r');
  await page.waitForFunction(() => window.__osOut.includes('CLIP-GOT2'), { timeout: 30000, polling: 200 });
  check('Ctrl+X emptied the source EDIT and the slot keeps the text',
    await page.evaluate(() => window.__osOut.includes('GT-[]') &&
      window.__osOut.includes('CLIP-ROCKS CLIP-GOT2')),
    await page.evaluate(() => window.__osOut.slice(-300)));
  await setVt(2);

  // ---- taskbar polish (todos/0101): the strip menu (render + dismiss on
  // outside-click AND Esc), the clock date tooltip (hover), and Show Desktop
  // (reveals the desktop, restores). Park one winbox at a KNOWN spot via
  // wmctl so the reveal is a deterministic pixel, not window-placement luck.
  await setVt(1);
  await page.keyboard.type('winbox & echo TP""-WB\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('TP-WB'), { timeout: 20000, polling: 200 });
  await page.waitForTimeout(1200);               // timing subject: TP-WB fires at the & echo, not when winbox is up; let it spawn before wmctl targets it
  // move it to (300,300) and raise it so it owns the (350,350) sample point.
  await page.keyboard.type('TPW=$(wmctl list | grep "winbox$" | sed "s/[^0-9].*//" | sort -n | tail -1); wmctl move $TPW 300 300; wmctl raise $TPW; echo TP""-MV\r', { delay: 30 });
  await page.waitForFunction(() => window.__osOut.includes('TP-MV'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(350, 350, ORANGE);
  check('a winbox is parked over the sample point (orange)', true);

  // Right-click the EMPTY strip (x = SW/2: past the term button, left of the
  // 75px clock cell) -> the strip menu (opens above the 36px bar). Sample a
  // blank face-gray spot inside it, near its left edge.
  const STRIPX = Math.floor(SW / 2), MENUPROBEX = STRIPX + 8, MENUPROBEY = SH - 90;
  const rclickStrip = () => page.mouse.click(rect.x + STRIPX, rect.y + BARY, { button: 'right' });
  await rclickStrip();
  await waitPixel(MENUPROBEX, MENUPROBEY, FACE);
  check('right-click the taskbar strip opens the menu (face gray above the bar)', true);
  // an outside-click (on the empty desktop) dismisses it (the 0091 rule).
  await clickAt(200, 200);
  await waitNotPixel(MENUPROBEX, MENUPROBEY, FACE);
  check('outside-click dismisses the strip menu',
    !near(await sample(MENUPROBEX, MENUPROBEY), FACE), await sample(MENUPROBEX, MENUPROBEY));
  // re-open and dismiss with Esc.
  await rclickStrip();
  await waitPixel(MENUPROBEX, MENUPROBEY, FACE);
  await page.keyboard.press('Escape');
  await waitNotPixel(MENUPROBEX, MENUPROBEY, FACE);
  check('Esc also dismisses the strip menu',
    !near(await sample(MENUPROBEX, MENUPROBEY), FACE), await sample(MENUPROBEX, MENUPROBEY));

  // The clock date tooltip: HOVER the clock cell -> "datepop" (184x30,
  // light-yellow face above the clock, at x=SW-184). Sample its blank area.
  await page.mouse.move(rect.x + SW - 55, rect.y + BARY);
  await new Promise(r => setTimeout(r, 400));            // hover-raise settle
  await waitPixel(SW - 100, SH - 56, [255, 255, 225]);
  check('clock hover shows the date tooltip', true);
  await page.mouse.move(rect.x + 200, rect.y + 300);   // off the clock: it idles out

  // The Show Desktop sliver ([SW-14, SW)): the first click minimizes-all and
  // REVEALS the desktop (the covered (350,350) goes teal; the sliver reads
  // pressed); a second click restores the windows (the point is covered
  // again) and the sliver is raised.
  await clickAt(SW - 6, BARY);
  await waitPixel(350, 350, TEAL);
  check('Show Desktop reveals the desktop (covered point now teal)', true);
  check('...and the sliver reads pressed', near(await sample(SW - 6, BARY), [170, 170, 170]),
    await sample(SW - 6, BARY));
  await clickAt(SW - 6, BARY);
  await waitNotPixel(350, 350, TEAL);
  check('Show Desktop restores the windows (point covered again)', true);
  check('...and the sliver is raised', near(await sample(SW - 6, BARY), FACE),
    await sample(SW - 6, BARY));

  // ---- desktop icon rename-in-place (todos/0103): F2 opens an inline editor
  // over the label (a solid white box); the grid relabels after Enter commits
  // rename(2). A fresh 'aaa' that sorts before every seeded icon makes the
  // top-left cell deterministic despite the earlier grid churn — select it by
  // keyboard (Right from a cleared selection lands top-left), F2, retype. ----
  await setVt(1);
  // Kill every leftover app (hub/applet/notepads/winbox) first — the
  // desktop-focus click below must land on the DESKTOP, not on the window
  // soup the earlier legs accumulated (todos/0156: the click hit a window, so
  // ArrowRight never selected anything). SIGKILL, not `wmctl close`: a close
  // box on a modified notepad raises a modal save prompt that keeps focus
  // (and SIGTERM can't wake a process parked in GetMessage).
  await page.keyboard.type('pkill -9 notepad; pkill -9 ctlpanel; pkill -9 winbox; pkill -9 term; echo WCL""-DONE\r', { delay: 20 });
  await page.waitForFunction(() => window.__osOut.includes('WCL-DONE'), { timeout: 20000, polling: 200 });
  // Drop the seeded Presentations DIR too: dirs sort first (todos/0185),
  // so it would steal the top-left cell from aaa — the long-name leg
  // below wipes the whole Desktop anyway.
  await page.keyboard.type('rm -f /root/Desktop/.icons; rm -rf /root/Desktop/Presentations; printf x > /root/Desktop/aaa; echo RN-""SETUP\r', { delay: 20 });
  await page.waitForFunction(() => window.__osOut.includes('RN-SETUP'), { timeout: 20000, polling: 200 });
  await new Promise(r => setTimeout(r, 2500));       // desk_load re-read tick
  await setVt(2);
  // Focus the desktop on an empty cell (col ~5), then Right selects the
  // top-left icon (aaa). Its 3-char label strip goes navy when selected.
  // The strip spans x=47..67, y=48..58 with the 'aaa' glyphs at y>=50 —
  // (49,52) sat ON the first 'a' glyph's white ink (todos/0156, could never
  // pass); sample the strip's all-navy top padding row instead.
  await clickAt(500, 400);
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.press('ArrowRight');
  await waitPixel(55, 66, NAVY);                     // aaa label strip left margin (row 0)
  check('top-left icon selected (navy label strip)', true);
  // F2 opens the inline editor: a solid white box over the label cell. Sample
  // just above the text row — teal on the plain desktop, white with the box.
  await page.keyboard.press('F2');
  await waitPixel(55, 60, WHITE);
  check('F2 opens the inline editor (white box over the label)', true);
  // Clear "aaa" (3 Backspaces), type "bbb", Enter commits the rename.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('bbb', { delay: 60 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 700));
  // The editor closed (box gone) and the grid relabelled — verify on disk.
  await waitPixel(55, 60, TEAL);
  check('editor closes after commit (box gone)', true);
  await setVt(1);
  await page.keyboard.type('test -e /root/Desktop/bbb && echo RN-BBB""-YES; test -e /root/Desktop/aaa || echo RN-AAA""-GONE\r', { delay: 20 });
  await page.waitForFunction(() => window.__osOut.includes('RN-BBB-YES') && window.__osOut.includes('RN-AAA-GONE'),
    { timeout: 20000, polling: 200 });
  check('inline rename committed on disk (aaa -> bbb)', true);
  await setVt(2);

  // ---- long/spaced Desktop-icon launch (todos/0151): a launcher whose name
  // exceeds the old menu_ent.name[32] used to be snprintf-truncated, so
  // desk_launch stat()'d a path that didn't exist and the icon silently never
  // launched. Clear the desktop to a short-spaced and a 36-char-spaced
  // launcher (sorted auto-flow: 'My App' row 0, the long name row 1) and
  // double-click each; winCount() must rise by one both times (coordinate-free
  // window counting, so cascade placement churn is irrelevant). ----
  await setVt(1);
  await page.keyboard.type(
    'rm -f /root/Desktop/.icons; for f in /root/Desktop/*; do rm -rf "$f"; done; ' +
    "printf '#!/bin/sh\\nwinbox\\n' > '/root/Desktop/My App'; " +
    "printf '#!/bin/sh\\nwinbox\\n' > '/root/Desktop/My Really Long Application Name Here'; echo LN-\"\"SETUP\r",
    { delay: 20 });
  await page.waitForFunction(() => window.__osOut.includes('LN-SETUP'), { timeout: 20000, polling: 200 });
  await new Promise(r => setTimeout(r, 2500));       // desk_load re-read tick
  await setVt(2);
  const ln0 = await winCount();                      // winCount() ends back on VT2
  await page.mouse.dblclick(rect.x + 74, rect.y + 16 + 0 * 96 + 48);   // row 0 = 'My App'
  await new Promise(r => setTimeout(r, 3500));        // sh -> winbox spawn
  const ln1 = await winCount();
  check('short spaced Desktop name launches on dblclick (winbox +1)',
    ln1 === ln0 + 1, { ln0, ln1 });
  await page.mouse.dblclick(rect.x + 74, rect.y + 16 + 1 * 96 + 48);   // row 1 = 36-char name
  await new Promise(r => setTimeout(r, 3500));
  const ln2 = await winCount();
  check('36-char spaced Desktop name launches on dblclick (no name[32] truncation)',
    ln2 === ln1 + 1, { ln1, ln2 });

  // The shell stays healthy behind the desktop (menu spawns are reaped —
  // no zombie pileup would show here, but the VT1 round-trip proves the
  // system is still driveable).
  await setVt(1);
  // Split needle (the 0089 echo trap): the kernel tty line discipline
  // echoes typed input into __osOut at TYPE time, so an unsplit `echo
  // SHELL-OK` needle is satisfied by its own echo — this leg passed
  // with hush DEAD, which is the one thing it exists to rule out.
  await page.keyboard.type("echo SHELL-O''K\r");
  await page.waitForFunction(() => window.__osOut.includes('SHELL-OK'), { timeout: 20000, polling: 200 });
  check('VT1 shell alive after menu driving', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos shell (browser): PASS' : `\nos shell (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
