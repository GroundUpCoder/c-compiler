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
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3199;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

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
  for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  let page = await context.newPage();
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
  await page.waitForFunction(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return window.__osScreen && window.__osScreen.w > 800 &&
      Math.abs(r.width - window.__osScreen.w) < 2 &&
      Math.abs(r.height - window.__osScreen.h) < 2;
  }, { timeout: 30000, polling: 200 });
  const { h: SH } = await page.evaluate(() => window.__osScreen);
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await waitPixel(400, SH - 14, FACE, 60000);      // taskbar composited (wm up)

  // ---- drop a binary file ----
  // Seeded /root/Desktop: doom gameboy quake term (4 links). "blob.bin"
  // sorts FIRST, so the grid becomes 5 cells and cell 4 (term, pushed
  // down) fills in — the fifth white tile is the "icon appeared" signal.
  const hl = await dropFile(page, 'blob.bin', BLOB);
  check('dragover lit the drop highlight', hl.lit && hl.cleared, hl);
  await waitDropLog(page, 'blob.bin -> /root/Desktop/blob.bin (256 bytes)');
  check('kernel logged the write', true);
  await waitPixel(48, 16 + 4 * 64 + 6 + 2, WHITE, 15000);   // cell 4 tile
  check('icon appeared without a reboot (5th grid cell)', true);

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
  // Sorted grid: blob-1.bin blob.bin doom gameboy quake run-winbox term
  // -> run-winbox is cell 5; wait for cell 6 (term) so the re-lay is done.
  const RW_Y = 16 + 5 * 64 + 6;
  await waitPixel(48, 16 + 6 * 64 + 6 + 2, WHITE, 15000);
  check('launcher icon appeared (7-cell grid)', true);
  await page.mouse.dblclick(rect.x + 58, rect.y + RW_Y + 10);
  await waitPixel(12 + 120, 36 + 80, ORANGE, 60000);   // first client window
  check('double-click ran the dropped launcher (winbox composited)', true);

  // ---- persistence: the files survive a page reload (OPFS flush) ----
  await page.close();                    // frees the 0045 boot lock
  page = await context.newPage();        // same context = same OPFS
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });
  check('reboots to ready on the persisted image', true);
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
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos drop (browser): PASS' : `\nos drop (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
