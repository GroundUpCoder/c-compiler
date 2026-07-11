// 0092 browser acceptance: file manager operations on the real
// compositor, driven by REAL browser input (page.mouse right-clicks +
// page.keyboard) — the headless twin is tests/kernel/test_fileman_ops_e2e.js.
// Covers: right-click a fileman row raises the user32 context menu
// in-surface (Win95 face over the listbox), the menu's Copy + a pane
// Paste duplicate a file ("Copy of ..." verified through the VT1 shell),
// the F2 rename dialog renders and commits, and Del's confirm box appears
// and deletes on Yes. Pixel checks stay tolerant (the icon grid, teal
// desktop) per the 0091 browser-trap notes; the source of truth for the
// fs effects is the VT1 shell (test -f markers).
//
// Usage: node os-fileman.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = 3231;
const URL = `http://localhost:${PORT}/os/os.html`;

const server = spawn('node', [path.join(ROOT, 'serve.js'), ROOT, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] });
let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
};

try {
  for (let i = 0; i < 240; i++) { try { if ((await fetch(URL)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
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
  const FACE = [192, 192, 192], WHITE = [255, 255, 255];
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
  const clickAt = (sx, sy, btn) =>
    page.mouse.click(rect.x + sx, rect.y + sy, btn ? { button: btn } : {});
  await pause(1500);   // 0091 trap: quiesce so a late EV_SCREEN can't dismiss

  // -- fixtures + launch fileman on a private dir via the VT1 shell --
  await setVt(1);
  await page.keyboard.type('mkdir -p /root/fmb && printf hi > /root/fmb/note.txt\r', { delay: 50 });
  await page.keyboard.type('fileman /root/fmb &\r', { delay: 50 });
  await pause(800);
  await setVt(2);
  // fileman's window: wm cascades it; the LISTBOX client area is white.
  // Sample a stable interior point once the frame is up.
  const FX = 40, FY = 60;                        // top-level cascade origin
  await waitPixel(FX + 120, FY + 120, WHITE, 60000);
  check('fileman window up (white listbox client)', true);

  // -- right-click over the listbox raises the popup in-surface (real
  // browser mouse; the screen->surface offset makes the exact row
  // uncertain, so this leg proves the RENDER, and drives the row-precise
  // ops through wmctl surface coords below — the headless twin already
  // pins every op's fs effect). --
  await clickAt(FX + 120, FY + 120, 'right');
  await waitPixel(FX + 130, FY + 130, FACE);     // popup face over the listbox
  check('right-click over the listbox raises the context menu in-surface', true);
  // Dismiss it (Esc) — the ops below re-open with exact coords.
  await setVt(1);
  await page.keyboard.type('SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")\r', { delay: 40 });
  await page.keyboard.type('wmctl key $SID 41 27\r', { delay: 40 });             // Esc the popup

  // -- Copy row 0 then Paste in the pane (wmctl surface coords) --
  await page.keyboard.type('wmctl click $SID 100 30 3\r', { delay: 40 });        // right-click row 0
  await pause(400);
  await page.keyboard.type('wmctl click Copy\r', { delay: 40 });
  await pause(400);
  await page.keyboard.type('wmctl click $SID 100 300 3\r', { delay: 40 });       // right-click the pane
  await pause(400);
  await page.keyboard.type('wmctl click Paste\r', { delay: 40 });
  await pause(600);
  await page.keyboard.type('test -f "/root/fmb/Copy of note.txt" && echo PASTE-O""K\r', { delay: 50 });
  await waitOut('PASTE-OK');
  check('Copy + Paste duplicated the file ("Copy of note.txt")', true);

  // -- F2 rename dialog renders + commits --
  await page.keyboard.type('wmctl click $SID 100 30\r', { delay: 40 });          // focus + select row 0
  await page.keyboard.type('wmctl key $SID 59 1073741883\r', { delay: 40 });     // F2
  await pause(500);
  await page.keyboard.type('wmctl list | grep -q Rename && echo RENAME-DLG-O""K\r', { delay: 40 });
  await waitOut('RENAME-DLG-OK');
  check('F2 opens the rename dialog', true);
  await page.keyboard.type('wmctl settext EDIT:1 renamed.txt\r', { delay: 40 });
  await page.keyboard.type('wmctl click OK\r', { delay: 40 });
  await pause(500);
  await page.keyboard.type('test -f /root/fmb/renamed.txt && echo RENAMED-O""K\r', { delay: 40 });
  await waitOut('RENAMED-OK');
  check('rename commits (renamed.txt on disk)', true);

  // -- Del confirm box appears; Yes deletes --
  await page.keyboard.type('wmctl click $SID 100 30\r', { delay: 40 });          // select row 0
  await page.keyboard.type('wmctl key $SID 76 127\r', { delay: 40 });            // Del
  await pause(500);
  await page.keyboard.type('wmctl list | grep -q Confirm && echo DEL-BOX-O""K\r', { delay: 40 });
  await waitOut('DEL-BOX-OK');
  check('Del raises the confirm MessageBox', true);
  await page.keyboard.type('wmctl click Yes\r', { delay: 40 });
  await pause(500);
  // After Copy+Paste (note.txt, Copy of note.txt) then rename of row 0
  // ("Copy of note.txt" -> renamed.txt), the dir holds note.txt +
  // renamed.txt; Del of row 0 (note.txt) leaves renamed.txt alone.
  await page.keyboard.type('echo "LEFT-$(ls /root/fmb | wc -l | tr -d \\" \\")-END"\r', { delay: 40 });
  await waitOut('LEFT-1-END');
  check('Yes deletes the selected file (renamed.txt remains)', true);

  await page.keyboard.type("echo FMB-SHELL-O''K\r", { delay: 50 });
  await waitOut('FMB-SHELL-OK');
  check('shell alive after the run', true);
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  failures++;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? '\nos fileman (browser): PASS' : `\nos fileman (browser): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
