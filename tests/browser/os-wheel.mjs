// #346/#347 browser acceptance: fractional (trackpad-sized) wheel deltas over
// the REAL page — Chrome pixel-mode wheel events at deltaY 25 convert to
// 0.25-notch SDL wheel motion (compositor.js: 1/100 notch per px), which is
// BELOW every consumer's one-line quantum (1/3 notch). Whole-notch wmctl
// injection passes against the truncating code, so these legs are the
// acceptance the tickets demand: several individually-sub-quantum events
// whose SUM scrolls, a remainder that survives into a later event, and
// opposite-sign motion that cancels without drift. Three consumers:
//   - term scrollback (#347): a full-ink marker row's grid position tracks
//     view_off exactly (19px per line)
//   - the fileman LISTBOX (#346): the selected row's navy strip tracks
//     st->top (22px per row)
//   - the notepad multiline EDIT: the POSITIVE CONTROL — the 0210 wheelAcc
//     precedent, proven here in the booted browser with trackpad-sized
//     deltas (the #30 closing evidence: the handler exists AND works)
// The exact quantum arithmetic is pinned headless (test_lb_vscroll_e2e.js,
// test_term_e2e.js session S); these legs prove the same contract from real
// browser input.
//
// Usage: node os-wheel.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3311;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

try {
  await waitForServer(URL, { tries: 240, interval: 500 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitOut, waitScreen } = osHelpers(page);
  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // The one fixed-settle class here is the MUST-NOT-move assert: the absence
  // of movement has no marker to wait on, so each no-move probe settles a
  // fixed second first (annotated at each use, the 0171 exemption).
  const pause = (ms) => page.waitForTimeout(ms);

  // First canvas y in [y0,y1) whose matching-pixel count across [x0,x1)
  // exceeds thr. mode 'bright' = glyph ink on a dark ground (r+g+b > 300,
  // term); mode 'dark' = ink on a white ground (r+g+b < 200, EDIT); mode
  // 'navy' = the COLOR_HIGHLIGHT selection strip (0,0,128).
  const bandTop = (x0, y0, x1, y1, thr, mode) => page.evaluate(([ax0, ay0, ax1, ay1, t, m]) => {
    const c = document.getElementById('screen');
    const cv = document.createElement('canvas');
    cv.width = c.width; cv.height = c.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(ax0, ay0, ax1 - ax0, ay1 - ay0).data;
    const w = ax1 - ax0;
    for (let y = 0; y < ay1 - ay0; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        if (m === 'navy' ? (r < 40 && g < 40 && Math.abs(b - 128) < 40)
            : m === 'dark' ? (r + g + b < 200)
                           : (r + g + b > 300)) n++;
      }
      if (n > t) return ay0 + y;
    }
    return -1;
  }, [x0, y0, x1, y1, thr, mode || 'bright']);

  // Poll a band probe until it reports `want` (a movement marker), loud on
  // timeout; `stable` waits for two consecutive equal non(-1) samples (the
  // render-settle for a freshly drawn band).
  const waitBand = async (fn, want, label, ms) => {
    const t0 = Date.now();
    for (;;) {
      const got = await fn();
      if (got === want) return got;
      if (Date.now() - t0 > (ms || 20000))
        throw new Error(`${label}: band at ${got}, wanted ${want}`);
      await new Promise(r => setTimeout(r, 300));
    }
  };
  const stableBand = async (fn, label, ms) => {
    const t0 = Date.now();
    let prev = -2;
    for (;;) {
      const got = await fn();
      if (got !== -1 && got === prev) return got;
      prev = got;
      if (Date.now() - t0 > (ms || 30000))
        throw new Error(`${label}: band never stabilized (last ${got})`);
      await new Promise(r => setTimeout(r, 500));
    }
  };

  // VT1 shell helper (split-marker echo discipline, the os-fileman model).
  const shLine = async (cmd, mark, ms) => {
    await page.keyboard.type(`${cmd} && echo ${mark[0]}""${mark.slice(1)}\r`, { delay: 40 });
    try {
      await page.waitForFunction(m => window.__osOut.includes(m), mark,
        { timeout: ms || 30000, polling: 200 });
    } catch { throw new Error(`shLine: ${mark} never echoed (after: ${cmd})`); }
  };
  // Window geometry DERIVED from its live `wmctl list` row (os-undo model).
  const wmGeom = async (grepNeedle, lineRe, tag) => {
    await page.keyboard.type(
      `wmctl list | grep "${grepNeedle}"; echo ${tag[0]}""${tag.slice(1)}\r`, { delay: 40 });
    await page.waitForFunction(m => window.__osOut.includes(m), tag,
      { timeout: 20000, polling: 200 });
    const out = await page.evaluate(() => window.__osOut);
    const line = out.split('\n').filter(l => lineRe.test(l)).pop() || '';
    const m = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  };
  const wheelAt = async (sx, sy, dy) => {
    await page.mouse.move(rect.x + sx, rect.y + sy);
    await page.mouse.wheel(0, dy);
  };

  // ================= leg 1: term scrollback (#347) =================
  // First window: the WM cascades it to (12,36); 640x486 = 80x24 at the
  // 8x19 cell below the 30px menu-bar strip (the os-term.mjs constants).
  const TX = 12, TY = 36, TW = 640, TH = 486;
  await setVt(1);
  await page.keyboard.type('term &\r');
  await setVt(2);
  await waitPixel(TX + 320, TY + 300, [0, 0, 0], 90000);
  check('term window composited', true);
  // Focus the term, flood history (scroll room), then print a full-ink
  // marker: the typed line's 40-# echo is the first heavy row on screen and
  // its grid row tracks view_off exactly.
  await page.mouse.click(rect.x + TX + 320, rect.y + TY + 300);
  await page.keyboard.type('seq 40\r');
  await pause(2000);   // seq output streams multi-frame; no completion marker on VT2
  const HASH = '#'.repeat(40);
  await page.keyboard.type(`printf '${HASH}\\n'; seq 8\r`);
  const termBand = () => bandTop(TX, TY + 30, TX + TW, TY + TH, 80);
  const T0 = await stableBand(termBand, 'term marker');
  check('term: marker band rendered mid-screen', T0 > TY + 30 && T0 < TY + TH - 5 * 19, T0);
  const tw = (dy) => wheelAt(TX + 320, TY + 250, dy);
  await tw(-25);                    // +0.25 notch up = 0.75 lines: below one line
  await pause(1000);                // no-move probe: fixed settle (no marker exists)
  check('term: one sub-notch event does not scroll', await termBand() === T0,
    `${await termBand()} vs ${T0}`);
  await tw(-25);                    // 1.5 lines -> one line up, carry 0.5
  await waitBand(termBand, T0 + 19, 'term: second event crosses one line');
  check('term: second sub-notch event scrolls one line (sum crossed)', true);
  await tw(-25);                    // 0.5+0.75 -> another line, carry 0.25
  await waitBand(termBand, T0 + 38, 'term: carry into third event');
  check('term: the 0.5-line remainder carries into the third event', true);
  await tw(25);                     // 0.25-0.75 = -0.5: no move either way
  await pause(1000);                // no-move probe: fixed settle (no marker exists)
  check('term: opposite sign cancels the remainder (no move)', await termBand() === T0 + 38,
    `${await termBand()} vs ${T0 + 38}`);
  await tw(25);                     // -1.25 -> one line back down
  await waitBand(termBand, T0 + 19, 'term: accumulated down-motion');
  check('term: accumulated down-motion scrolls one line back', true);
  // End the session (any keypress snaps live first — fine, the leg is done).
  await page.keyboard.type('exit\r');
  await waitPixel(TX + 320, TY + 300, [0, 128, 128], 30000);
  check('term session closed (desktop teal back)', true);

  // ================= leg 2: fileman LISTBOX (#346) =================
  await setVt(1);
  await shLine('mkdir -p /root/fmw && i=1; while [ $i -le 60 ]; do touch /root/fmw/f$i; i=$((i+1)); done', 'FMW-SEED');
  await page.keyboard.type('fileman /root/fmw &\r', { delay: 40 });
  await shLine('wmctl wait label Go 15000', 'FMW-UP', 25000);
  const fm = await wmGeom('File Manager', /File Manager - \/root\/fmw\s*$/, 'FMW-GEOM');
  check('fileman geometry derived', !!fm, fm);
  await setVt(2);
  // Select visible row 3 (rows are 22px below the 36px path strip): its
  // navy COLOR_HIGHLIGHT strip is the tracker.
  await page.mouse.click(rect.x + fm.x + 150, rect.y + fm.y + 36 + 3 * 22 + 10);
  const fmBand = () => bandTop(fm.x + 8, fm.y + 36, fm.x + fm.w - 30, fm.y + fm.h, 50, 'navy');
  const N0 = await stableBand(fmBand, 'fileman selection');
  check('fileman: selected row navy strip rendered', N0 > 0, N0);
  const fw = (dy) => wheelAt(fm.x + 150, fm.y + 36 + 3 * 22 + 10, dy);
  await fw(25);                     // -0.25 notch = -30 units: below the 40-unit quantum
  await pause(1000);                // no-move probe: fixed settle (no marker exists)
  check('fileman: one sub-notch event does not scroll', await fmBand() === N0,
    `${await fmBand()} vs ${N0}`);
  await fw(25);                     // -60 -> one row down (navy strip up), rem -20
  // One row's pixel height is MEASURED from this first crossing (the row
  // height rides the control's live font metrics — don't hardcode it).
  const ft0 = Date.now();
  let R2 = -1;
  for (;;) {
    R2 = await fmBand();
    if (R2 !== -1 && R2 < N0 - 8) break;
    if (Date.now() - ft0 > 20000) throw new Error(`fileman: no scroll after second event (band ${R2}, was ${N0})`);
    await new Promise(r => setTimeout(r, 300));
  }
  const FL = N0 - R2;
  check('fileman: second sub-notch event scrolls one row (sum crossed)',
    FL >= 12 && FL <= 40, `row height ${FL}`);
  await fw(25);                     // -50 -> another row, rem -10
  await waitBand(fmBand, N0 - 2 * FL, 'fileman: carry into third event');
  check('fileman: the remainder carries into the third event', true);
  await fw(-25);                    // -10+30 = +20: no move either way
  await pause(1000);                // no-move probe: fixed settle (no marker exists)
  check('fileman: opposite sign cancels the remainder (no move)', await fmBand() === N0 - 2 * FL,
    `${await fmBand()} vs ${N0 - 2 * FL}`);
  await fw(-25);                    // +50 -> one row back up, rem +10
  await waitBand(fmBand, N0 - FL, 'fileman: accumulated up-motion');
  check('fileman: accumulated up-motion scrolls one row back', true);
  await setVt(1);
  await shLine('pkill fileman && wmctl wait nowin "File Manager - /root/fmw" 10000', 'FMW-GONE', 20000);

  // ============ leg 3: notepad EDIT — the positive control (#30) ============
  // The 0210 wheelAcc precedent, proven with trackpad-sized deltas in the
  // booted browser: the marker row 5 lines into the file tracks topLine.
  await shLine(`seq 5 > /root/wh.txt && printf '${HASH}\\n' >> /root/wh.txt && seq 60 >> /root/wh.txt`, 'WH-SEED');
  await page.keyboard.type('notepad /root/wh.txt &\r', { delay: 40 });
  await shLine('wmctl wait win "wh.txt - Notepad" 30000', 'NP-UP', 40000);
  const np = await wmGeom('wh.txt - Notepad', /wh\.txt - Notepad\s*$/, 'NP-GEOM');
  check('notepad geometry derived', !!np, np);
  await setVt(2);
  // Client text area sits below the 20px user32 menu bar; the scan floor
  // (+45) additionally skips the EDIT's STATIC sunken-edge border line — a
  // full-width dark row that would otherwise pin the band forever — and the
  // x range keeps clear of the left edge and right scrollbar gutter. The
  // marker starts ~5 lines down and never rises past the floor in this leg.
  const npBand = () => bandTop(np.x + 8, np.y + 45, np.x + np.w - 24, np.y + np.h - 4, 60, 'dark');
  const E0 = await stableBand(npBand, 'notepad marker');
  check('notepad: marker band rendered below 5 seq lines', E0 > np.y + 24, E0);
  const nw = (dy) => wheelAt(np.x + Math.floor(np.w / 2), np.y + Math.floor(np.h / 2), dy);
  await nw(25);                     // -30 units: below the 40-unit line quantum
  await pause(1000);                // no-move probe: fixed settle (no marker exists)
  check('EDIT control: one sub-notch event does not scroll', await npBand() === E0,
    `${await npBand()} vs ${E0}`);
  await nw(25);                     // -60 -> one line, rem -20
  const t0 = Date.now();
  let E2 = -1;
  for (;;) {
    E2 = await npBand();
    if (E2 !== -1 && E2 < E0 - 8) break;
    if (Date.now() - t0 > 20000) throw new Error(`EDIT: no scroll after second event (band ${E2}, was ${E0})`);
    await new Promise(r => setTimeout(r, 300));
  }
  const L = E0 - E2;                // one line's pixel height, measured live
  check('EDIT control: second sub-notch event scrolls one line (sum crossed)',
    L >= 12 && L <= 40, `line height ${L}`);
  await nw(25);                     // -50 -> one line, rem -10
  await waitBand(npBand, E2 - L, 'EDIT: carry into third event');
  check('EDIT control: the remainder carries into the third event', true);
  await nw(25);                     // -40 -> one line, rem 0 (exact consumption)
  await waitBand(npBand, E2 - 2 * L, 'EDIT: fourth event');
  check('EDIT control: fourth event completes exactly (rem 0)', true);
  await nw(25);                     // -30: an exactly-consumed carry does not linger
  await pause(1000);                // no-move probe: fixed settle (no marker exists)
  check('EDIT control: an exactly-consumed remainder does not linger',
    await npBand() === E2 - 2 * L, `${await npBand()} vs ${E2 - 2 * L}`);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos wheel (browser): PASS' : `\nos wheel (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
