// 0093 browser acceptance: the Recycle Bin on the real compositor — the
// headless twin is tests/kernel/test_recycle_e2e.js. Covers: the bin icon
// composits at the grid's TAIL (row = #Desktop entries - 1, derived at
// runtime — a new seed icon like Notepad shifts it down) with the
// empty basket glyph, trashing a desktop file (the wm.c icon menu's
// DELETE, driven through wmctl surface coords per the 0092 browser-trap
// notes) flips the glyph full, a REAL double-click on the bin opens
// fileman AT the store listing the entry, and Restore returns the file to
// the desktop and flips the glyph back to empty. fs truth is the VT1
// shell (test -f markers with split-quote echoes, the 0089 trap).
//
// Usage: node os-recycle.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
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

  // Derive the bin's grid row from the LIVE desktop before anything else: it
  // tail-pins to column 0, so its row = (#Desktop entries - 1). Reading it
  // (instead of a row-7 constant) keeps the pixel probes correct however many
  // icons the image seeds. cellTop(row)=16+row*64; rim +10, center +18, click +30.
  await setVt(1);
  // Split-quote the marker (0089 trap) so `-END` appears ONLY in the command
  // output, never the typed-line echo — otherwise waitOut fires on the echo
  // before the count is printed.
  await page.keyboard.type('echo "NDESK=$(ls /root/Desktop | wc -l)-EN""D"\r', { delay: 50 });
  await waitOut('-END');
  const ndeskOut = await page.evaluate(() => window.__osOut);
  const ndeskM = ndeskOut.match(/NDESK=(\d+)-END/);
  check('read the live Desktop entry count', !!ndeskM, JSON.stringify(ndeskM));
  const binRow = (ndeskM ? Number(ndeskM[1]) : 8) - 1;
  const cellTop = (row) => 16 + row * 64;
  const rimY = cellTop(binRow) + 10, cenY = cellTop(binRow) + 18, clkY = cellTop(binRow) + 30;

  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await pause(1500);   // 0091 trap: quiesce so a late EV_SCREEN can't dismiss

  // -- the bin icon: grid tail (derived binRow), empty glyph --
  // basket rim navy at (58,rimY), center (58,cenY) white while the store is
  // empty, navy once it holds an entry.
  await waitPixel(58, rimY, NAVY, 60000);          // basket rim = icon drawn
  check('Recycle Bin icon composited at the grid tail', true);
  check('bin glyph starts EMPTY (white center)', near(await sample(58, cenY), WHITE),
    await sample(58, cenY));

  // -- trash a desktop file through the wm.c icon menu (wmctl coords) --
  await setVt(1);
  await page.keyboard.type('printf j > /root/Desktop/junk.txt\r', { delay: 50 });
  await pause(2000);                               // the coarse desk tick
  // NB every $(wmctl ...) substitution takes long enough that typing the
  // next line races the prompt (the leading keystroke gets eaten — hush
  // saw 'mctl'); pause after each shell line that runs a command.
  await page.keyboard.type('DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")\r', { delay: 40 });
  await pause(800);
  // junk.txt sorts to row 3 (doom drmario gameboy junk.txt ...)
  await page.keyboard.type('wmctl click $DSID 58 240 3\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('wmctl click $CXSID 60 82\r', { delay: 40 });   // DELETE
  await pause(800);
  await page.keyboard.type('test ! -f /root/Desktop/junk.txt && test -f /root/.recycle/files/junk.txt && echo DESK-TRASH-O""K\r', { delay: 50 });
  await waitOut('DESK-TRASH-OK');
  check('icon menu DELETE moved the file into the store', true);

  // -- the glyph flips FULL on the live compositor --
  await setVt(2);
  await waitPixel(58, cenY, NAVY, 30000);
  check('bin glyph flips FULL (navy center)', true);

  // -- REAL double-click opens fileman AT the store --
  await page.mouse.dblclick(rect.x + 58, rect.y + clkY);
  await setVt(1);
  await page.keyboard.type('for i in 1 2 3 4 5 6 7 8 9 10; do wmctl list | grep -q "File Manager" && break; sleep 1; done\r', { delay: 40 });
  await pause(6000);                               // fileman spawn + freetype
  await page.keyboard.type('wmctl gettext LISTBOX:0 | grep -q junk.txt && echo BIN-LISTS-O""K\r', { delay: 50 });
  await waitOut('BIN-LISTS-OK', 30000);
  check('double-clicking the bin opens fileman listing the entry', true);

  // -- Restore returns it to the desktop; the glyph flips back --
  await page.keyboard.type('SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('wmctl click $SID 100 30 3\r', { delay: 40 });  // row 0
  await pause(800);
  await page.keyboard.type('wmctl click Restore\r', { delay: 40 });
  await pause(800);
  await page.keyboard.type('test -f /root/Desktop/junk.txt && test ! -e /root/.recycle/files/junk.txt && echo RESTORED-O""K\r', { delay: 50 });
  await waitOut('RESTORED-OK');
  check('Restore puts the file back on the desktop', true);
  await setVt(2);
  // junk.txt is back on the desktop, so the tail-pinned bin sits one row
  // lower now: binRow + 1, tile center at cellTop(binRow+1)+18.
  await waitPixel(58, cellTop(binRow + 1) + 18, WHITE, 30000);
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
