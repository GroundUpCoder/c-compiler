// 0398 browser acceptance: the egress seam's page actor — the headless
// twin is tests/kernel/test_egress_e2e.js (which proves the RPC, walk, zip
// and errno semantics; THIS file proves the browser-only leg: activation +
// the real download). The wm.c icon-menu Download is driven by REAL
// page.mouse input — wmctl clicks carry NO page activation, so a
// wmctl-driven leg would silently prove nothing — and the assertion is
// Playwright's `download` EVENT (suggested filename + exact saved bytes),
// i.e. the browser really performed a download. Covers: a lone desktop
// file downloads as itself; a directory downloads as ONE <name>.zip
// (store-only zip magic checked on the saved bytes); the __osEgress page
// probe counts both. The saveas disposition raises a native picker
// (unautomatable) and its plumbing is kernel-proven — not driven here.
//
// Usage: node os-egress.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl, deskEntries, deskCell } from './lib/os-harness.mjs';
const PORT = 3278;
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
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, waitPixel, waitOut, waitScreen } = osHelpers(page);
  const FACE = [192, 192, 192];
  // timing subject: paces genuine no-marker settles — the coarse desktop
  // re-read tick and the EV_SCREEN quiesce (annotated per site).
  const pause = (ms) => page.waitForTimeout(ms);

  // ---- seed a desktop file + a desktop dir through the VT1 shell ----
  await setVt(1);
  await pause(300);   // VT switch settles before typing (no page-side marker)
  await page.keyboard.type('printf egress-browser-bytes > /root/Desktop/dl.txt && mkdir -p /root/Desktop/dldir && printf zipped > /root/Desktop/dldir/inner.txt && echo SEED-O""K\r', { delay: 50 });
  await waitOut('SEED-OK');
  check('seeded dl.txt + dldir/ on the desktop', true);

  await setVt(2);
  await waitScreen();
  const { h: SH } = await page.evaluate(() => window.__osScreen);
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  // Grid cells from the harness model (the 0166 derive-never-hardcode rule);
  // dldir must be marked dir:true — dirs sort FIRST in wm.c's entcmp, so a
  // string extra would shift every derived cell by one.
  const extras = ['dl.txt', { name: 'dldir', dir: true }];
  const FILE = deskCell(deskEntries(extras), 'dl.txt', SH);
  const DIR = deskCell(deskEntries(extras), 'dldir', SH);
  await pause(2500);   // coarse desk tick draws the new icons + EV_SCREEN quiesce (0091 trap)

  // ---- lone file: icon menu Download -> a real browser download ----
  // Document icon menu rows (menucore, 30px + 10px sep): Open, Edit, ---,
  // Cut, Copy, Download -> Download center at +146 from the menu origin.
  let mx = FILE.x + 58, my = FILE.y + 48;
  await page.mouse.click(rect.x + mx, rect.y + my, { button: 'right' });
  await waitPixel(mx + 5, my + 40, FACE);
  check('right-click on the file icon raises its menu', true);
  const dl1p = page.waitForEvent('download', { timeout: 20000 });
  await page.mouse.click(rect.x + mx + 30, rect.y + my + 146);
  const dl1 = await dl1p;
  check('Download fires a real browser download', true);
  check('lone file: suggested name is the basename', dl1.suggestedFilename() === 'dl.txt',
    dl1.suggestedFilename());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-egress-'));
  const f1 = path.join(tmp, 'dl.txt');
  await dl1.saveAs(f1);
  check('lone file: exact bytes crossed', fs.readFileSync(f1, 'utf8') === 'egress-browser-bytes',
    fs.readFileSync(f1, 'utf8'));

  // ---- directory: ONE zip artifact ----
  // Launcher/dir icon menu has no Edit row: Open, ---, Cut, Copy,
  // Download -> center at +116.
  mx = DIR.x + 58; my = DIR.y + 48;
  await page.mouse.click(rect.x + mx, rect.y + my, { button: 'right' });
  await waitPixel(mx + 5, my + 50, FACE);   // Cut-row gutter (row 1 is the sep here)
  const dl2p = page.waitForEvent('download', { timeout: 20000 });
  await page.mouse.click(rect.x + mx + 30, rect.y + my + 116);
  const dl2 = await dl2p;
  check('directory: suggested name is <basename>.zip', dl2.suggestedFilename() === 'dldir.zip',
    dl2.suggestedFilename());
  const f2 = path.join(tmp, 'dldir.zip');
  await dl2.saveAs(f2);
  const zb = fs.readFileSync(f2);
  check('directory: saved bytes are a zip (PK\\x03\\x04 magic)',
    zb[0] === 0x50 && zb[1] === 0x4b && zb[2] === 3 && zb[3] === 4,
    zb.subarray(0, 4).toString('hex'));
  check('directory: zip names the inner file',
    zb.includes(Buffer.from('dldir/inner.txt')));

  check('__osEgress probe counted both artifacts',
    await page.evaluate(() => window.__osEgress) === 2,
    await page.evaluate(() => window.__osEgress));

  fs.rmSync(tmp, { recursive: true, force: true });
  await setVt(1);
  await page.keyboard.type("echo EGRESS-SHELL-O''K\r", { delay: 60 });
  await waitOut('EGRESS-SHELL-OK');
  check('shell alive after the run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos egress (browser): PASS' : `\nos egress (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
