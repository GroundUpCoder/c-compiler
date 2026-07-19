// 0093 browser acceptance: the Recycle Bin on the real compositor — the
// headless twin is tests/kernel/test_recycle_e2e.js. Covers: the bin icon
// composits at the grid's TAIL (cell derived from the harness grid model —
// column 1 since the 0184/0185 seeds wrapped the grid) with the
// empty basket glyph, trashing a desktop file (the wm.c icon menu's
// DELETE, driven through wmctl surface coords per the 0092 browser-trap
// notes) flips the glyph full, a REAL double-click on the bin opens
// fileman AT the store listing the entry, and Restore returns the file to
// the desktop and flips the glyph back to empty. fs truth is the VT1
// shell (test -f markers with split-quote echoes, the 0089 trap).
//
// Usage: node os-recycle.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl, deskEntries, deskCell } from './lib/os-harness.mjs';
const PORT = 3233;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

let page;
try {
  await waitForServer(URL, { tries: 240, interval: 500 });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const { setVt, sample, near, waitPixel, waitOut, waitScreen } = osHelpers(page);
  const WHITE = [255, 255, 255], NAVY = [0, 0, 128];
  // timing subject: paces genuine no-marker settles — EV_SCREEN quiesce, the
  // coarse desktop re-read tick, and the inter-command wmctl subcommand gaps
  // (each call site is annotated; terminal fs effects use waitOut markers).
  const pause = (ms) => page.waitForTimeout(ms);

  // The bin's grid cell comes from the harness grid model (deskEntries/
  // deskCell over os/image.json — the 0166 rule): the bin tail-pins into
  // COLUMN 1 since the 0184/0185 seeds wrapped the grid, and it shifts one
  // index when junk.txt is on the desktop, so both cells are derived at
  // the live screen height. rim +10, center +18, click +30 from cell top.
  await setVt(2);
  await waitScreen();
  const { h: SH } = await page.evaluate(() => window.__osScreen);
  const BIN0 = deskCell(deskEntries(), 'Recycle Bin', SH);
  const BINJ = deskCell(deskEntries(['junk.txt']), 'Recycle Bin', SH);
  const JUNK = deskCell(deskEntries(['junk.txt']), 'junk.txt', SH);
  const binX = BIN0.x + 58;
  const rimY = BIN0.y + 10, cenY = BIN0.y + 22, clkY = BIN0.y + 48;
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await pause(1500);   // 0091 trap: quiesce so a late EV_SCREEN can't dismiss

  // -- the bin icon: grid tail (derived binRow), empty glyph --
  // basket rim navy at (58,rimY), center (58,cenY) white while the store is
  // empty, navy once it holds an entry.
  await waitPixel(binX, rimY, NAVY, 60000);        // basket rim = icon drawn
  check('Recycle Bin icon composited at the grid tail', true);
  check('bin glyph starts EMPTY (white center)', near(await sample(binX, cenY), WHITE),
    await sample(binX, cenY));

  // -- trash a desktop file through the wm.c icon menu (wmctl coords) --
  await setVt(1);
  await page.keyboard.type('printf j > /root/Desktop/junk.txt\r', { delay: 50 });
  await pause(2000);                               // the coarse desk tick
  // NB every $(wmctl ...) substitution takes long enough that typing the
  // next line races the prompt (the leading keystroke gets eaten — hush
  // saw 'mctl'); pause after each shell line that runs a command.
  await page.keyboard.type('DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")\r', { delay: 40 });
  await pause(800);
  // junk.txt's derived cell (dirs first + the 0184 launchers shift it)
  await page.keyboard.type(`wmctl click $DSID ${JUNK.x + 58} ${JUNK.y + 48} 3\r`, { delay: 40 });
  await pause(800);
  await page.keyboard.type('CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('wmctl click $CXSID 30 146\r', { delay: 40 });  // Delete (Edit shifted it, 0202; engine rows 0259)
  await pause(800);
  await page.keyboard.type('test ! -f /root/Desktop/junk.txt && test -f /root/.recycle/files/junk.txt && echo DESK-TRASH-O""K\r', { delay: 50 });
  await waitOut('DESK-TRASH-OK');
  check('icon menu DELETE moved the file into the store', true);

  // -- the glyph flips FULL on the live compositor --
  await setVt(2);
  await waitPixel(binX, cenY, NAVY, 30000);
  check('bin glyph flips FULL (navy center)', true);

  // -- REAL double-click opens fileman AT the store --
  await page.mouse.dblclick(rect.x + binX, rect.y + clkY);
  await setVt(1);
  await page.keyboard.type('for i in 1 2 3 4 5 6 7 8 9 10; do wmctl list | grep -q "File Manager" && break; sleep 1; done\r', { delay: 40 });
  await pause(6000);                               // fileman spawn + freetype
  await page.keyboard.type('wmctl gettext LISTBOX:0 | grep -q junk.txt && echo BIN-LISTS-O""K\r', { delay: 50 });
  await waitOut('BIN-LISTS-OK', 30000);
  check('double-clicking the bin opens fileman listing the entry', true);

  // -- Restore returns it to the desktop; the glyph flips back --
  await page.keyboard.type('SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('wmctl click $SID 100 51 3\r', { delay: 40 });  // row 0 (listbox at TOP_H=36)
  await pause(800);
  await page.keyboard.type('wmctl click Restore\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('test -f /root/Desktop/junk.txt && test ! -e /root/.recycle/files/junk.txt && echo RESTORED-O""K\r', { delay: 50 });
  await waitOut('RESTORED-OK');
  check('Restore puts the file back on the desktop', true);
  await setVt(2);
  // junk.txt is back on the desktop, so the tail-pinned bin sits one cell
  // further along (BINJ — derived, column-aware).
  await waitPixel(BINJ.x + 58, BINJ.y + 22, WHITE, 30000);
  check('bin glyph flips back EMPTY (at its new lower cell)', true);

  await setVt(1);
  await page.keyboard.type("echo RB-SHELL-O''K\r", { delay: 50 });
  await waitOut('RB-SHELL-OK');
  check('shell alive after the run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  try {   // the VT1 transcript is the best clue for a missing marker
    const out = await page.evaluate(() => window.__osOut.slice(-2500));
    console.error('--- __osOut tail ---\n' + out);
  } catch {}
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos recycle (browser): PASS' : `\nos recycle (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
