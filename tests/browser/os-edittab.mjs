// EDIT tab expansion browser acceptance (todos/0274, design todos/WIN32.md):
// a literal TAB (0x09) in the user32 multiline EDIT must render as whitespace
// advancing to the next tab stop — NOT as gdi32's control-char '?' glyph.
//
// The bug surfaced opening vendor/magicpoint/decks/talks/posix-on-wasm.mgp in
// notepad (lines 26+ begin with a real '\t' and each showed a leading '?').
// The fix lives in the SHARED EDIT control (os/win32/user32.c edit_proc), so
// this drives the deterministic case through ctldemo's multiline EDIT — the
// exact same control notepad delegates to — typing "X<TAB>Y" and asserting a
// WIDE blank gap between the two glyphs (proves BOTH the tab advance AND that
// no '?' is drawn in the gap). A notepad-on-the-deck open smoke covers the
// headline repro end to end.
//
// The kernel twin (tests/kernel/test_user32_e2e.js `ctldemo selftest`) pins
// the caret column-mapping math; this is the on-screen render leg.
//
// Usage: node os-edittab.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3212;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

// A screen pixel is "ink" if it's clearly darker than the white EDIT well.
const isInk = ([r, g, b]) => (r + g + b) / 3 < 160;

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, waitPixel, waitScreen } = osHelpers(page);
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut.includes(n), needle, { timeout: ms || 30000, polling: 200 });

  const WHITE = [255, 255, 255];

  await setVt(2);
  await waitScreen();

  // Launch the seeded controls demo (real tty path).
  await setVt(1);
  await page.keyboard.type('ctldemo &\r');
  await waitOut('ctldemo: ready', 60000);
  await setVt(2);

  // The WM places the first window at (12,36); the multiline EDIT (id=102)
  // is laid out at window-relative (12,176) in os/win32/ctldemo.c WM_CREATE.
  const WX = 12, WY = 36;
  const EDIT_X = WX + 12, EDIT_Y = WY + 176;     // EDIT client origin (screen px)
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const clickScreen = (sx, sy) => page.mouse.click(rect.x + sx, rect.y + sy);

  // The well composites white — the sampling baseline.
  await waitPixel(EDIT_X + 100, EDIT_Y + 40, WHITE, 60000);
  check('multiline EDIT well white', true);

  // Focus the multiline EDIT's first line AT COLUMN 0 and type "X" TAB "Y"
  // through the REAL input path (page keyboard -> kernel ring -> WM_CHAR).
  // ctldemo's main window is a plain GetMessage loop (no IsDialogMessage), so
  // Tab reaches the EDIT as WM_CHAR 9 and inserts a real '\t' rather than
  // moving focus. Typed at the row START the next default stop is a full
  // 8-char grid cell away, so the tab opens a wide gap in ANY face. (The old
  // append-at-line-end flow was flag-day fragile: under C2's sans stock
  // "line oneX" ended 3px short of a stop, and a real tab legally advances
  // 3px — the wide-gap premise broke, not the tab.)
  await clickScreen(EDIT_X + 4, EDIT_Y + 30);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.type('X', { delay: 40 });
  await page.keyboard.press('Tab');
  await page.keyboard.type('Y', { delay: 40 });
  await new Promise(r => setTimeout(r, 400));

  // Confirm the buffer really holds a tab. The agent tree escapes '\t' as the
  // two chars backslash+t; accept a raw tab too, just in case.
  await setVt(1);
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('wmctl gettext EDIT:1\r');
  await new Promise(r => setTimeout(r, 600));
  const gt = await page.evaluate(() => window.__osOut);
  check('EDIT holds a real tab between X and Y', /X(\t|\\t)Y/.test(gt),
    JSON.stringify(gt.replace(/.*gettext EDIT:1/s, '').slice(0, 60)));
  await setVt(2);
  await new Promise(r => setTimeout(r, 300));

  // Scan the EDIT's first text row for ink columns. Take a column as ink if
  // ANY y in a small band is dark (tolerates sub-pixel glyph placement). One
  // page.evaluate reads the whole strip.
  const x0 = EDIT_X + 3;                          // EDIT_PAD
  const strip = await page.evaluate(([sx, sy0, sy1, w]) => {
    const c = document.getElementById('screen');
    const t = document.createElement('canvas');
    const r = c.getBoundingClientRect();
    t.width = Math.round(r.width); t.height = Math.round(r.height);
    t.getContext('2d').drawImage(c, 0, 0);
    const ctx = t.getContext('2d');
    const out = [];
    for (let x = 0; x < w; x++) {
      let ink = false;
      for (let y = sy0; y <= sy1; y++) {
        const d = ctx.getImageData(sx + x, y, 1, 1).data;
        if ((d[0] + d[1] + d[2]) / 3 < 160) { ink = true; break; }
      }
      out.push(ink ? 1 : 0);
    }
    return out;
  }, [x0, EDIT_Y + 3, EDIT_Y + 26, 240]);

  // Group the ink columns into glyph runs (letters), then find the WIDEST
  // blank gap between consecutive runs. That gap IS the expanded tab: at the
  // 20px font the default 8-column stop opens ~75px of whitespace. Under the
  // pre-fix bug the tab was a single '?' glyph, so every inter-run gap stayed
  // one-character narrow (~3px). 40px cleanly discriminates the two.
  const runs = [];
  let run = null;
  strip.forEach((v, x) => {
    if (v) { if (!run) { run = { s: x, e: x }; runs.push(run); } else run.e = x; }
    else run = null;
  });
  check('glyph runs present on the row', runs.length >= 2,
    'runs=' + JSON.stringify(runs));
  let widest = 0, gapAt = null;
  for (let i = 1; i < runs.length; i++) {
    const g = runs[i].s - runs[i - 1].e - 1;
    if (g > widest) { widest = g; gapAt = { after: runs[i - 1].e, before: runs[i].s }; }
  }
  check('tab expands to a wide blank gap (no "?" glyph in it)', widest >= 40,
    'widestGap=' + widest + 'px runs=' + JSON.stringify(runs));
  if (gapAt) {
    // And the gap really is blank — a '?' anywhere in it would be ink.
    const between = strip.slice(gapAt.after + 1, gapAt.before);
    check('the tab gap is entirely blank', between.every(v => v === 0),
      'ink cols in gap: ' + between.reduce((a, v) => a + v, 0));
  }

  // Quit ctldemo cleanly.
  await setVt(1);
  await page.keyboard.type('wmctl click Quit\r');
  await waitOut('ctldemo: bye', 20000).catch(() => {});
  await setVt(2);

  // ---- headline repro: open the actual deck in notepad. Lines 26+ begin
  // with a real '\t'; the app must render (no crash) and present its window.
  //
  // This leg used to be unconditionally true. Its needle — the window title —
  // was a literal substring of the `wmctl wait win "..."` line typed one
  // statement earlier, and the kernel tty line discipline echoes typed input
  // into __osOut at TYPE time, so the wait was satisfied before `wmctl wait`
  // had even been dispatched. A `.catch(() => {})` swallowed the timeout on
  // top of that, and the final regex re-tested the same cumulative buffer.
  // Nothing here proved notepad launched, opened this deck, survived rendering
  // tab-indented lines, or ever created a window — i.e. the whole repro.
  //
  // Now: a SPLIT marker gated on `wmctl wait win` (the echo shows NP-DE""CK,
  // the shell prints NP-DECK), no swallowed timeout, plus a client pixel — the
  // multiline EDIT well goes white at the window's LIVE geometry, which is
  // what "it rendered the tab-indented deck without crashing" actually means.
  await setVt(1);
  await page.keyboard.type('notepad /usr/share/mgp/talks/posix-on-wasm.mgp &\r');
  await page.keyboard.type(
    'wmctl wait win "posix-on-wasm.mgp - Notepad" 30000 && echo NP-DE""CK\r');
  let deckUp = true;
  try { await waitOut('NP-DECK', 40000); }
  catch { deckUp = false; }
  check('notepad opens the tab-indented deck (headline repro)', deckUp,
    (await page.evaluate(() => window.__osOut)).replace(/\n/g, ' ').slice(-160));
  // Derive the window rect from `wmctl list` (never a constant) and assert the
  // EDIT client actually painted.
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('wmctl list\r');
  await page.waitForFunction(() => /Notepad/.test(window.__osOut), { timeout: 20000, polling: 200 });
  const npOut = await page.evaluate(() => window.__osOut);
  const npRow = npOut.split('\n').filter(l => /posix-on-wasm\.mgp - Notepad$/.test(l.trim())).pop() || '';
  const npGeom = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(npRow);
  check('notepad window has a real rect in wmctl list', !!npGeom, npRow.trim());
  if (npGeom) {
    const [, , , nx, ny] = npGeom.map(Number);
    await setVt(2);
    // Client-relative (40,60): inside the multiline EDIT well, below the menu
    // bar (20px) and past the left margin — white when the control painted.
    await waitPixel(nx + 40, ny + 60, [255, 255, 255], 30000);
    check('the deck rendered into notepad\'s EDIT well (white client)', true);
    await setVt(1);
  }
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
console.log(state.failures === 0 ? '\nos edittab (browser): PASS' : `\nos edittab (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
