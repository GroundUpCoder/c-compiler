// 0093 browser acceptance: the Recycle Bin on the real compositor — the
// headless twin is tests/kernel/test_recycle_e2e.js. Covers: the bin icon
// composits at the grid's TAIL (row 7 on the seeded desktop) with the
// empty basket glyph, trashing a desktop file (the wm.c icon menu's
// DELETE, driven through wmctl surface coords per the 0092 browser-trap
// notes) flips the glyph full, a REAL double-click on the bin opens
// fileman AT the store listing the entry, and Restore returns the file to
// the desktop and flips the glyph back to empty. fs truth is the VT1
// shell (test -f markers with split-quote echoes, the 0089 trap).
//
// Usage: node os-recycle.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3233;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

let page;
try {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  const setVt = (n) => page.evaluate((v) => window.__osVtSwitch(v), n);
  const waitOut = (needle, ms) => page.waitForFunction(
    (n) => window.__osOut && window.__osOut.includes(n), needle,
    { timeout: ms || 20000, polling: 200 });

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
  const WHITE = [255, 255, 255], NAVY = [0, 0, 128];
  const pause = (ms) => page.waitForTimeout(ms);

  await setVt(2);
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await pause(1500);   // 0091 trap: quiesce so a late EV_SCREEN can't dismiss

  // -- the bin icon: grid tail (row 7 after the 7 seeds), empty glyph --
  // Tile origin (46,470): basket rim navy at (58,474), center (58,482)
  // white while the store is empty, navy once it holds an entry.
  await waitPixel(58, 474, NAVY, 60000);           // basket rim = icon drawn
  check('Recycle Bin icon composited at the grid tail', true);
  check('bin glyph starts EMPTY (white center)', near(await sample(58, 482), WHITE),
    await sample(58, 482));

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
  await waitPixel(58, 482, NAVY, 30000);
  check('bin glyph flips FULL (navy center)', true);

  // -- REAL double-click opens fileman AT the store --
  await page.mouse.dblclick(rect.x + 58, rect.y + 494);
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
  // junk.txt is back on the desktop (8 sorted entries now), so the
  // tail-pinned bin sits one row lower: row 8, tile center (58, 546).
  await waitPixel(58, 546, WHITE, 30000);
  check('bin glyph flips back EMPTY (at its new row-8 cell)', true);

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
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos recycle (browser): PASS' : `\nos recycle (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
