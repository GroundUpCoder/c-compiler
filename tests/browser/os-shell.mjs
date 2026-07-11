// Desktop-shell browser acceptance (todos/0028 start menu, Win7 two-pane
// restyle todos/0098, todos/0029 desktop icons): boot the reference OS page
// in headless Chromium and drive the /bin/wm shell furniture through the
// real UI-bridge path — canvas clicks -> kernel hit-test/rings -> wm.c
// policy — asserting composited pixels. Covers: the Start button, the
// two-pane root (left pinned/recents/All-Programs + search box, right
// places), the All Programs cascade, MRU recents relaunch, live search +
// Enter, right-pane RUN..., menu open/dismiss; the desktop
// icon grid (EV_SCREEN-recreated at the live size), single-click select,
// double-click launch of term, minimize revealing the desktop; the 0089
// Control Panel applet hub (icon-folder composite, Sound applet in its
// own window, per-window close box, agent-tree volume/system drive); the
// 0090 system clipboard (notepad -> notepad Ctrl+A/C/V/X over the real
// VT2 keyboard path, cross-checked against /bin/clip on VT1).
//
// Usage: node os-shell.mjs   (manual tier — run the os-*.mjs sweep serially)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3197;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);
  const sample = (x, y) => page.evaluate(([sx, sy]) => {
    const c = document.getElementById('screen');
    const r = c.getBoundingClientRect();
    const t = document.createElement('canvas');
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    const ctx = t.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(sx, sy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);
  const near = (got, want, tol) => got && got.every((v, i) => Math.abs(v - want[i]) <= (tol || 8));
  const waitPixel = async (x, y, want, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (near(got, want)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) never became ${want}; last ${got}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], NAVY = [0, 0, 128],
        FACE = [192, 192, 192];

  await setVt(2);
  // Derive geometry from the LIVE screen (todos/0023 rule).
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });
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
  }, [SW - 14 - 45, SH - 20, 42, 12]);
  check('taskbar clock digits present (black-pixel histogram)', clockBlack >= 15, clockBlack);
  // The Start button face, right of the "START" label glyphs (x 8..38).
  check('Start button face at the taskbar left', near(await sample(44, BARY), FACE),
    await sample(44, BARY));

  // The Win7 two-pane root (os/wm.c, todos/0098): a fixed 290x234 panel
  // above the 28px taskbar. LEFT pane (170px) = pinned + MRU recents + an
  // "All Programs" row, with a search box at its foot; RIGHT pane (120px) =
  // SETTINGS then RUN... . Clear recents/pins first so the left pane is
  // deterministic ([All Programs] at row 0); "All Programs" cascades the
  // menu tree — startmenu2 lists the GROUPS, startmenu3 a group's leaves.
  const SM_W = 290, SM_LEFT_W = 170, SM_H = 234, SM_ROW_H = 20, SM_PAD = 4;
  const SM_Y = SH - 28 - SM_H;
  const SM_SEARCH_Y = SM_Y + SM_PAD + 10 * SM_ROW_H + 4;
  const flyRowY = (i) => SM_PAD + i * SM_ROW_H + 10;
  const MENU_GROUPS = ['Accessories', 'Demos', 'Games'];
  const DEMOS = ['cairodemo', 'ctldemo', 'gdidemo', 'gpubox', 'winbox'];
  const winCount = async () => {
    await setVt(1);
    await page.waitForTimeout(400);              // let the prompt settle (VT1 pacing)
    await page.keyboard.type('echo WBQ""$(wmctl list | grep -c "winbox$")\r', { delay: 40 });
    await page.waitForFunction(() => /WBQ\d/.test(window.__osOut), { timeout: 20000, polling: 200 });
    const out = await page.evaluate(() => window.__osOut);
    const n = +(/WBQ(\d+)(?![\s\S]*WBQ\d)/.exec(out)[1]);
    await page.evaluate(() => { window.__osOut = window.__osOut.replace(/WBQ\d+/g, ''); });
    await setVt(2);
    await page.waitForTimeout(300);
    return n;
  };
  await setVt(1);
  await page.keyboard.type('rm -f /root/.config/recent /root/.config/pinned && echo REC""-CLR\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('REC-CLR'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(400, BARY, FACE);
  await page.waitForTimeout(500);

  check('menu spot is desktop before the click', near(await sample(120, SM_Y + 74), TEAL),
    await sample(120, SM_Y + 74));
  // Map-on-placement (todos/0069): burst-capture frames THROUGH the open —
  // the menu must never composite at the kernel cascade default (the
  // top-left band) before appearing parked above the taskbar. (120, SM_Y+74)
  // is an empty left-pane row (recents cleared -> only All Programs at row
  // 0), so it is face gray only once the panel is parked.
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
  await page.waitForTimeout(100);                // capture running first
  await clickAt(25, BARY);                       // Start (x < 50)
  const frames = await burst;
  check('Start click opens the two-pane root (face fill above the taskbar)',
    frames.some(f => f[0] === 1), frames.length);
  const maxCasc = Math.max(...frames.map(f => f[1]));
  check('no first-frame teleport: nothing composited in the cascade band (todos/0069)',
    maxCasc < 300, { maxCasc, frames: frames.length });
  await waitPixel(120, SM_Y + 74, FACE);         // settle

  // The right pane is a distinct band (176,176,176) split from the left by
  // a divider; the search box is a sunken white field at the foot.
  check('right pane renders as a distinct band', near(await sample(230, SM_Y + 120), [176, 176, 176]),
    await sample(230, SM_Y + 120));
  check('search box is a white field at the foot of the left pane',
    near(await sample(40, SM_SEARCH_Y + 8), [255, 255, 255]), await sample(40, SM_SEARCH_Y + 8));

  // All Programs (left row 0) cascades the tree flyout of groups
  // (startmenu2 at x = SM_W - 3), then a group cascades its leaves
  // (startmenu3). Hover All Programs, then the Demos group.
  await page.mouse.move(rect.x + 60, rect.y + SM_Y + 14);
  await waitPixel(SM_W - 3 + 40, SM_Y + 6, FACE);
  check('All Programs cascades the tree flyout', true);
  const DEMOS_ROW = MENU_GROUPS.indexOf('Demos');
  await page.mouse.move(rect.x + SM_W - 3 + 40, rect.y + SM_Y + flyRowY(DEMOS_ROW));
  // startmenu3 parks at (SM_W-3 + 150-3, SM_Y + DEMOS_ROW*SM_ROW_H).
  const FLY3_X = SM_W - 3 + 150 - 3, FLY3_Y = SM_Y + DEMOS_ROW * SM_ROW_H;
  await waitPixel(FLY3_X + 40, FLY3_Y + 6, FACE);
  check('the Demos group cascades its leaves', true);
  await clickAt(FLY3_X + 60, FLY3_Y + flyRowY(DEMOS.indexOf('winbox')));
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
  await page.waitForTimeout(500);
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
  await page.waitForTimeout(500);
  const wb3 = await winCount();
  check('Enter launches the search top hit (winbox +1)', wb3 === wb2 + 1, { wb2, wb3 });

  // The RUN... place is in the RIGHT pane (row 1): click it, the dialog
  // opens (see the builtin leg below). Here just confirm the right-pane
  // click routing dismisses the menu into the dialog.
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await clickAt(210, SM_Y + SM_PAD + SM_ROW_H + 10);   // right pane, RUN row 1
  await waitPixel(120, SM_Y + 74, TEAL);
  check('right-pane RUN... click dismisses the menu (opens the dialog)', true);
  await page.keyboard.press('Escape');           // close the run dialog

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

  // ---- /etc/menu override is searched (todos/0040: first-existing-dir) ----
  // With /etc/menu present, menu_dir points there, so the live search walks
  // IT: create a single launcher, search its name, Enter launches it.
  await setVt(1);
  await page.keyboard.type('mkdir /etc/menu && ln -s /usr/bin/winbox /etc/menu/solo && echo MENU""-SET\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('MENU-SET'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(400, BARY, FACE);
  await page.waitForTimeout(800);
  const wo0 = await winCount();
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await page.keyboard.type('solo', { delay: 60 });
  await waitPixel(100, SM_Y + 14, NAVY);
  check('override tree is searched (solo hit highlights)', true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const wo1 = await winCount();
  check('override search hit launches (winbox +1)', wo1 === wo0 + 1, { wo0, wo1 });
  await setVt(1);
  await page.keyboard.type('rm -rf /etc/menu && echo MENU""-RESET\r', { delay: 40 });
  await page.waitForFunction(() => window.__osOut.includes('MENU-RESET'), { timeout: 20000, polling: 200 });
  await setVt(2);
  check('override removed: back to the baked default', true);

  // The two-pane legs above launched several winboxes (recents, search, the
  // override); close them all so the desktop section starts from a clean
  // taskbar (the icon legs avoid the top-left cascade regardless, but the
  // minimize leg below expects term to be the sole button).
  await setVt(1);
  await page.keyboard.type('for s in $(wmctl list | grep "winbox$" | sed "s/[^0-9].*//"); do wmctl close $s; done; echo WB""-CLOSED\r', { delay: 30 });
  await page.waitForFunction(() => window.__osOut.includes('WB-CLOSED'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(400, BARY, FACE);
  await page.waitForTimeout(500);

  // ---- the desktop layer (todos/0029) ----
  const WHITE = [255, 255, 255];
  const waitNotPixel = async (x, y, notWant, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await sample(x, y);
      if (!near(got, notWant)) return got;
      if (Date.now() - t0 > (ms || 30000)) throw new Error(`pixel (${x},${y}) stayed ${notWant}`);
      await new Promise(r => setTimeout(r, 200));
    }
  };

  // Icons flow down the left edge, sorted (the seeded /root/Desktop —
  // bump the list with image.json, the kernel-e2e rule). The winbox
  // launched above covers rows 0-2; term's row is clear of it: white
  // 24x24 tile, navy center, label below. The label-strip sample at
  // x=45 relies on term's 4-char label starting at x=46 — pick a
  // SHORT-named entry if this ever moves.
  const DESK_ENTRIES = ['doom', 'drmario', 'gameboy', 'mario', 'pokemon',
                        'quake', 'term'];
  const TROW = DESK_ENTRIES.indexOf('term');
  const I3X = 46, I3Y = 16 + TROW * 64 + 6;      // term's icon tile origin
  await waitPixel(I3X + 2, I3Y + 2, WHITE);
  check(`desktop icon tile composited (term, cell ${TROW})`, true);
  check('icon glyph navy center', near(await sample(I3X + 12, I3Y + 12), NAVY),
    await sample(I3X + 12, I3Y + 12));

  // Single click: selection highlight (navy label strip), NO launch.
  await clickAt(58, I3Y + 10);
  await waitPixel(45, 16 + TROW * 64 + 24 + 10 + 3, NAVY);   // label bg, left of text
  check('single click selects (navy label strip)', true);

  // ---- selection & manipulation (todos/0077) ----
  // The click above also focused the desktop (wm.c policy), so modifier
  // and navigation keys reach the icon grid from here on.
  // Ctrl+click mario (row 3, clear of the winbox): additive — term stays.
  const MROW = DESK_ENTRIES.indexOf('mario');
  const MSTRIP = [42, 16 + MROW * 64 + 37];      // mario len 5 -> label x 43
  await page.keyboard.down('Control');
  await clickAt(58, 16 + MROW * 64 + 30);
  await page.keyboard.up('Control');
  await waitPixel(MSTRIP[0], MSTRIP[1], NAVY);
  check('ctrl+click adds to the selection (mario strip navy)', true);
  check('...and term stays selected', near(await sample(45, 16 + TROW * 64 + 37), NAVY),
    await sample(45, 16 + TROW * 64 + 37));

  // Marquee from empty desktop over the row 4-6 tiles (pokemon, quake,
  // term): REPLACES the set — mario drops out.
  const PROW = DESK_ENTRIES.indexOf('pokemon'), QROW = DESK_ENTRIES.indexOf('quake');
  await page.mouse.move(rect.x + 150, rect.y + 300);
  await page.mouse.down();
  await page.mouse.move(rect.x + 95, rect.y + 360, { steps: 4 });
  await page.mouse.move(rect.x + 40, rect.y + 430, { steps: 4 });
  await page.mouse.up();
  await waitPixel(36, 16 + PROW * 64 + 37, NAVY);    // pokemon len 7 -> x 37
  check('marquee selects the intersected icons (pokemon strip navy)', true);
  check('quake caught by the marquee too', near(await sample(42, 16 + QROW * 64 + 37), NAVY),
    await sample(42, 16 + QROW * 64 + 37));
  check('marquee replaces: mario deselected', near(await sample(MSTRIP[0], MSTRIP[1]), TEAL),
    await sample(MSTRIP[0], MSTRIP[1]));

  // Drag-move: a plain click on the selected quake collapses the set to it
  // (mouseup rule); past the 500ms double-click window, drag it two columns
  // right — (0,5) -> (2,5), snapped and persisted (.icons).
  await clickAt(58, 16 + QROW * 64 + 30);
  await new Promise(r => setTimeout(r, 600));
  await page.mouse.move(rect.x + 58, rect.y + (16 + QROW * 64 + 30));
  await page.mouse.down();
  await page.mouse.move(rect.x + 140, rect.y + (16 + QROW * 64 + 30), { steps: 3 });
  await page.mouse.move(rect.x + 226, rect.y + (16 + QROW * 64 + 30), { steps: 3 });
  await page.mouse.up();
  await waitPixel(216, 16 + QROW * 64 + 8, WHITE);   // tile ring at the new cell
  check('drag repositions the icon (tile at col 2)', true);
  check('the old cell is teal again', near(await sample(58, 16 + QROW * 64 + 18), TEAL),
    await sample(58, 16 + QROW * 64 + 18));
  check('moved icon stays selected (strip navy at the new cell)',
    near(await sample(210, 16 + QROW * 64 + 37), NAVY),
    await sample(210, 16 + QROW * 64 + 37));

  // Esc clears the selection (the desktop holds focus).
  await page.keyboard.press('Escape');
  await waitPixel(210, 16 + QROW * 64 + 37, TEAL);
  check('Esc clears the selection', true);

  // Double-click launches term (640x432 at the cascade slot). Sample a
  // point inside term but outside winbox; wait for it to leave teal.
  await page.mouse.dblclick(rect.x + 58, rect.y + I3Y + 10);
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
  // where the window was.
  await clickAt(100, BARY);
  await waitPixel(500, 300, TEAL);
  check('minimize reveals the desktop', true);

  // ---- the RUN... builtin (todos/0078; a right-pane place since 0098) ----
  // Start -> the RUN... place (right pane, row 1) opens the dialog (240x70
  // bottom-left, white input box); typed command + Enter spawns via
  // /bin/sh -c.
  const WHITE2 = [255, 255, 255];
  const rb0 = await winCount();
  await clickAt(25, BARY);
  await waitPixel(120, SM_Y + 74, FACE);
  await clickAt(210, SM_Y + SM_PAD + SM_ROW_H + 10);   // RUN... (right pane row 1)
  await waitPixel(200, SH - 28 - 70 - 6 + 35, WHITE2);   // the input box
  check('RUN... place opens the run dialog', true);
  check('the menu closed behind it', near(await sample(120, SM_Y + 74), TEAL),
    await sample(120, SM_Y + 74));
  await page.keyboard.type('winbox');
  await page.keyboard.press('Enter');
  await waitPixel(200, SH - 28 - 70 - 6 + 35, TEAL);     // dialog gone
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
  await page.waitForTimeout(800);
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
  await page.waitForTimeout(800);                // the async job-notice trap
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
    await page.keyboard.down('Control');
    await page.waitForTimeout(100);
    await page.keyboard.press(letter);
    await page.waitForTimeout(100);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
  };
  await clickAt(N1X + Math.min(120, N1W - 20), N1Y + 60);
  await page.waitForTimeout(300);
  await page.keyboard.type('CLIP-ROCKS', { delay: 60 });
  await page.waitForTimeout(400);
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
  await page.waitForTimeout(800);
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
  await page.waitForTimeout(300);
  await chord('v');
  await page.waitForTimeout(1000);
  const afterPaste = await blackIn(...npClient);
  check('Ctrl+V renders the pasted text in the second notepad',
    afterPaste > beforePaste + 30, `${beforePaste} -> ${afterPaste}`);
  // Ctrl+X in the FIRST notepad: source emptied, slot still has the text.
  // Click its LEFT edge — the second notepad cascades +28,+24 and covers
  // the client center, and a covered click would focus THAT window.
  await clickAt(N1X + 12, N1Y + 60);
  await page.waitForTimeout(300);
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
  await page.waitForTimeout(1200);
  // move it to (300,300) and raise it so it owns the (350,350) sample point.
  await page.keyboard.type('TPW=$(wmctl list | grep "winbox$" | sed "s/[^0-9].*//" | sort -n | tail -1); wmctl move $TPW 300 300; wmctl raise $TPW; echo TP""-MV\r', { delay: 30 });
  await page.waitForFunction(() => window.__osOut.includes('TP-MV'), { timeout: 20000, polling: 200 });
  await setVt(2);
  await waitPixel(350, 350, ORANGE);
  check('a winbox is parked over the sample point (orange)', true);

  // Right-click the clock cell (x = SW-40: always past the button run) ->
  // the strip menu (CTX_W 120, clamped to the right edge, 96 tall above the
  // 28px bar). Sample a blank face-gray spot inside it (menu-local x~100).
  const rclickStrip = () => page.mouse.click(rect.x + SW - 40, rect.y + BARY, { button: 'right' });
  await rclickStrip();
  await waitPixel(SW - 20, SH - 74, FACE);
  check('right-click the taskbar strip opens the menu (face gray above the bar)', true);
  // an outside-click (on the empty desktop) dismisses it (the 0091 rule).
  await clickAt(200, 200);
  await page.waitForTimeout(400);
  check('outside-click dismisses the strip menu',
    !near(await sample(SW - 20, SH - 74), FACE), await sample(SW - 20, SH - 74));
  // re-open and dismiss with Esc.
  await rclickStrip();
  await waitPixel(SW - 20, SH - 74, FACE);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Esc also dismisses the strip menu',
    !near(await sample(SW - 20, SH - 74), FACE), await sample(SW - 20, SH - 74));

  // The clock date tooltip: HOVER the clock cell -> "datepop" (104x22,
  // light-yellow face above the clock). Sample its blank right end.
  await page.mouse.move(rect.x + SW - 40, rect.y + BARY);
  await waitPixel(SW - 8, SH - 43, [255, 255, 225]);
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
  await page.keyboard.type('rm -f /root/Desktop/.icons; printf x > /root/Desktop/aaa; echo RN-""SETUP\r', { delay: 20 });
  await page.waitForFunction(() => window.__osOut.includes('RN-SETUP'), { timeout: 20000, polling: 200 });
  await new Promise(r => setTimeout(r, 2500));       // desk_load re-read tick
  await setVt(2);
  // Focus the desktop on an empty cell (col ~5), then Right selects the
  // top-left icon (aaa). Its 3-char label strip goes navy when selected.
  await clickAt(500, 400);
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.press('ArrowRight');
  await waitPixel(49, 52, NAVY);                     // aaa label strip (row 0)
  check('top-left icon selected (navy label strip)', true);
  // F2 opens the inline editor: a solid white box over the label cell. Sample
  // just above the text row — teal on the plain desktop, white with the box.
  await page.keyboard.press('F2');
  await waitPixel(48, 47, WHITE);
  check('F2 opens the inline editor (white box over the label)', true);
  // Clear "aaa" (3 Backspaces), type "bbb", Enter commits the rename.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('bbb', { delay: 60 });
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 700));
  // The editor closed (box gone) and the grid relabelled — verify on disk.
  await waitPixel(48, 47, TEAL);
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
  await page.mouse.dblclick(rect.x + 58, rect.y + 16 + 0 * 64 + 32);   // row 0 = 'My App'
  await new Promise(r => setTimeout(r, 3500));        // sh -> winbox spawn
  const ln1 = await winCount();
  check('short spaced Desktop name launches on dblclick (winbox +1)',
    ln1 === ln0 + 1, { ln0, ln1 });
  await page.mouse.dblclick(rect.x + 58, rect.y + 16 + 1 * 64 + 32);   // row 1 = 36-char name
  await new Promise(r => setTimeout(r, 3500));
  const ln2 = await winCount();
  check('36-char spaced Desktop name launches on dblclick (no name[32] truncation)',
    ln2 === ln1 + 1, { ln1, ln2 });

  // The shell stays healthy behind the desktop (menu spawns are reaped —
  // no zombie pileup would show here, but the VT1 round-trip proves the
  // system is still driveable).
  await setVt(1);
  await page.keyboard.type('echo SHELL-OK\r');
  await page.waitForFunction(() => window.__osOut.includes('SHELL-OK'), { timeout: 20000, polling: 200 });
  check('VT1 shell alive after menu driving', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos shell (browser): PASS' : `\nos shell (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
