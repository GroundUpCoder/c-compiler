// Host-file drag-and-drop browser acceptance (todos/0067): boot the
// reference OS page in headless Chromium and drop files onto the desktop
// pane through the real DataTransfer path — page 'drop' listener ->
// {type:'drop-file'} postMessage -> kernel-side MountFS write into
// /root/Desktop -> /bin/wm's coarse re-read grows the icon. Covers: the
// dragover highlight, a binary payload's byte-identity (md5 round-trip),
// the icon appearing without a reboot, the "-N" collision suffix, a
// dropped #!/bin/sh launcher being double-click runnable (todos/0066
// activate), and OPFS persistence across a page reload.
//
// Usage: node os-drop.mjs   (manual tier — run the os-*.mjs sweep serially)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl, deskEntries, deskCell } from './lib/os-harness.mjs';
import { createHash } from 'node:crypto';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3199;
const URL = osUrl(PORT);
const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

// The binary payload: every byte value once — any transport mangling
// (UTF-8 coercion, truncation, transfer detach bug) breaks the md5.
const BLOB = Uint8Array.from({ length: 256 }, (_, i) => i);
const BLOB_MD5 = createHash('md5').update(BLOB).digest('hex');
const LAUNCHER = '#!/bin/sh\nwinbox\n';

// Synthetic DataTransfer drop on the #desktop pane (Chromium supports the
// DataTransfer/File constructors in page context). dragover first — the
// real sequence, and it exercises the highlight class.
const dropFile = (page, name, byteArr) => page.evaluate(([n, arr]) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(arr)], n));
  const el = document.getElementById('desktop');
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  const lit = el.classList.contains('droptarget');
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return { lit, cleared: !el.classList.contains('droptarget') };
}, [name, Array.from(byteArr)]);

const waitDropLog = (page, needle) => page.waitForFunction(
  (s) => window.__osLogs.some(l => l.startsWith('[drop]') && l.includes(s)),
  needle, { timeout: 20000, polling: 200 });

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  let page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });

  // `let` so the persistence-reload leg can rebind these to the NEW page —
  // osHelpers closes over the page it was handed, and the reload below
  // reassigns `page` (a stale capture here would call evaluate() on the
  // closed original: "Target page has been closed").
  let { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);
  const shellExpect = async (cmd, pred, name, ms) => {
    await setVt(1);
    await page.evaluate(() => { window.__osOut = ''; });
    await page.keyboard.type(cmd + '\r');
    await page.waitForFunction(pred, undefined, { timeout: ms || 20000, polling: 200 });
    check(name, true);
  };

  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], WHITE = [255, 255, 255],
        FACE = [192, 192, 192];

  await setVt(2);
  await waitScreen();
  const { h: SH } = await page.evaluate(() => window.__osScreen);
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await waitPixel(400, SH - 14, FACE, 60000);      // taskbar composited (wm up)

  // ---- drop a binary file ----
  // Seeded /root/Desktop from the harness grid model (deskEntries/deskCell,
  // the todos/0166 rule — files + the Presentations dir + the Recycle Bin,
  // wrapping into column 1 since 0184/0185): the tail-pinned bin's tile
  // appearing at its post-drop cell is the "icon appeared" signal.
  const GRID1 = deskEntries(['blob.bin']);
  const B1 = deskCell(GRID1, 'Recycle Bin', SH);
  const hl = await dropFile(page, 'blob.bin', BLOB);
  check('dragover lit the drop highlight', hl.lit && hl.cleared, hl);
  await waitDropLog(page, 'blob.bin -> /root/Desktop/blob.bin (256 bytes)');
  check('kernel logged the write', true);
  await waitPixel(B1.x + 32, B1.y + 6 + 2, WHITE, 15000);   // the bin's post-drop tile
  check(`icon appeared without a reboot (${GRID1.length}-cell grid)`, true);

  // Byte-identity through the shell (busybox md5sum over the brokered fs).
  await shellExpect('md5sum /root/Desktop/blob.bin',
    () => /[0-9a-f]{32}/.test(window.__osOut), 'md5sum ran on the dropped file', 20000);
  const md5Out = await page.evaluate(() => window.__osOut);
  check('binary payload byte-identical (md5)', md5Out.includes(BLOB_MD5), { md5Out, BLOB_MD5 });

  // ---- collision policy: same name again -> -1 suffix ----
  await setVt(2);
  await dropFile(page, 'blob.bin', BLOB);
  await waitDropLog(page, 'blob-1.bin -> /root/Desktop/blob-1.bin (256 bytes)');
  check('name collision took the -1 suffix (no overwrite)', true);

  // ---- a dropped #!/bin/sh launcher is double-click runnable (0066) ----
  const enc = new TextEncoder().encode(LAUNCHER);
  await dropFile(page, 'run-winbox', enc);
  await waitDropLog(page, 'run-winbox -> /root/Desktop/run-winbox');
  // Sorted grid: the two blobs + the seeds + run-winbox; wait for the
  // tail-pinned bin's cell so the re-lay is done before clicking.
  const GRID = deskEntries(['blob.bin', 'blob-1.bin', 'run-winbox']);
  const RW = deskCell(GRID, 'run-winbox', SH);
  const B2 = deskCell(GRID, 'Recycle Bin', SH);
  await waitPixel(B2.x + 32, B2.y + 6 + 2, WHITE, 15000);
  check(`launcher icon appeared (${GRID.length}-cell grid)`, true);
  await page.mouse.dblclick(rect.x + (RW.x + 42), rect.y + (RW.y + 6 + 10));
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000);   // first client window
  check('double-click ran the dropped launcher (winbox composited)', true);

  // ---- persistence: the files survive a page reload (OPFS flush) ----
  await page.close();                    // frees the 0045 boot lock
  page = await context.newPage();        // same context = same OPFS
  ({ setVt, sample, near, waitPixel, waitScreen } = osHelpers(page));  // rebind to the new page
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });
  check('reboots to ready on the persisted image', true);
  await setVt(1);   // 0070: ready lands on VT2; the checks below type on the tty
  await page.keyboard.type('ls /root/Desktop\r');
  await page.waitForFunction(() => window.__osOut.includes('run-winbox'), { timeout: 20000, polling: 200 });
  const ls = await page.evaluate(() => window.__osOut);
  check('dropped files survive the reload', ['blob.bin', 'blob-1.bin', 'run-winbox'].every(n => ls.includes(n)), ls);
  await page.evaluate(() => { window.__osOut = ''; });
  await page.keyboard.type('md5sum /root/Desktop/blob.bin /root/Desktop/blob-1.bin\r');
  await page.waitForFunction(() => (window.__osOut.match(/[0-9a-f]{32}/g) || []).length >= 2, { timeout: 20000, polling: 200 });
  const md5After = await page.evaluate(() => window.__osOut.match(/[0-9a-f]{32}/g));
  check('bytes byte-identical after the reload (both copies)',
    md5After.every(h => h === BLOB_MD5), { md5After, BLOB_MD5 });
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(state.failures === 0 ? '\nos drop (browser): PASS' : `\nos drop (browser): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
