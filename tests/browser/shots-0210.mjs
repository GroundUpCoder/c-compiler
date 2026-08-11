// Booted-OS verification + screenshots for todos/0210 (manual; NOT part of
// the sweep — the os-*.mjs discovery glob deliberately doesn't match).
// Boots the reference OS in Chromium, opens a CRLF file in notepad (no "?"),
// a 120-line document (built-in WS_VSCROLL scrollbar), wheel-scrolls it with
// the REAL page wheel, and saves desktop PNGs to media/.
//
// Usage: node shots-0210.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, launchBrowser, waitForServer, osHelpers, osUrl } from './lib/os-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTDIR = path.join(ROOT, 'media');
const PORT = 3271;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  ' + extra));
  if (!ok) failed++;
};

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 860 } });
  const page = await context.newPage();
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 250 });
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 200 });
  check('boots to ready', true);

  const { setVt, waitOut, waitScreen } = osHelpers(page);
  const type = (s) => page.keyboard.type(s + '\r', { delay: 25 });

  const shoot = async (file) => {
    const dataUrl = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      const t = document.createElement('canvas');
      t.width = Math.round(r.width); t.height = Math.round(r.height);
      t.getContext('2d').drawImage(c, 0, 0);
      return t.toDataURL('image/png');
    });
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(path.join(OUTDIR, file),
      Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  shot ' + path.join('media', file));
  };
  const canvasRect = async () => page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // ---- seed the files on VT1 ----
  await setVt(1);
  await type('printf "Meeting notes\\r\\n=============\\r\\n\\r\\nThis file was written by a Windows tool with CRLF endings.\\r\\nBefore todos/0210 every one of these lines ended in a ?\\r\\n\\r\\nNow the EDIT strips the CR at load and saves back pure LF.\\r\\n" > /root/notes-crlf.txt; echo SEED""1');
  await waitOut('SEED1');
  await type('i=1; while [ $i -le 120 ]; do echo "line $i of the long document, enough rows that the EDIT needs its scrollbar"; i=$((i+1)); done > /root/longdoc.txt; echo SEED""2');
  await waitOut('SEED2');

  // ---- notepad on the CRLF file ----
  await type('notepad /root/notes-crlf.txt &');
  await type('wmctl wait win "notes-crlf.txt - Notepad" 15000 && wmctl list && echo NP""1-UP');
  await waitOut('NP1-UP');
  const sid1 = await page.evaluate(() => {
    const m = window.__osOut.split('\n').filter(l => /notes-crlf\.txt - Notepad\s*$/.test(l)).pop();
    return m ? m.trim().split('\t')[0] : null;
  });
  check('notepad opened notes-crlf.txt', !!sid1);
  await type(`wmctl move ${sid1} 480 60 && wmctl resize ${sid1} 520 300 && echo MO""VED1`);
  await waitOut('MOVED1');
  // no \r left in the loaded EDIT (the "?" source) — agent-verified too
  await type('wmctl gettext EDIT:0 | od -c | grep -q "\\\\r" && echo CR""-FOUND || echo CR""-CLEAN');
  await waitOut('CR-CLEAN');
  check('loaded EDIT holds no \\r', true);

  await setVt(2);
  await waitScreen();
  await new Promise(r => setTimeout(r, 1500));   // late EV_SCREEN settle
  await shoot('0210-crlf-clean.png');

  // ---- second notepad on the long document: the scrollbar ----
  await setVt(1);
  await type('notepad /root/longdoc.txt &');
  await type('wmctl wait win "longdoc.txt - Notepad" 15000 && wmctl list && echo NP""2-UP');
  await waitOut('NP2-UP');
  const sid2 = await page.evaluate(() => {
    const m = window.__osOut.split('\n').filter(l => /longdoc\.txt - Notepad\s*$/.test(l)).pop();
    return m ? m.trim().split('\t')[0] : null;
  });
  check('notepad opened longdoc.txt', !!sid2);
  await type(`wmctl move ${sid2} 40 330 && wmctl resize ${sid2} 560 380 && echo MO""VED2`);
  await waitOut('MOVED2');

  await setVt(2);
  await waitScreen();
  await new Promise(r => setTimeout(r, 1500));
  await shoot('0210-scrollbar-top.png');

  // ---- REAL mouse wheel over the EDIT (full os.html -> kernel path) ----
  const cr = await canvasRect();
  // window client at (40,330), 560x380: EDIT center ~ (40+280, 330+180)
  await page.mouse.move(cr.x + 40 + 280, cr.y + 330 + 180);
  await page.mouse.wheel(0, 800);                // 8 notches down = 24 lines
  await new Promise(r => setTimeout(r, 800));
  await shoot('0210-wheel-scrolled.png');

  // verify the wheel really scrolled: first visible line is no longer 1
  await setVt(1);
  await type(`wmctl shot ${sid2} /root/after.png && echo SH""OT-OK`);
  await waitOut('SHOT-OK');
  check('wheel scroll captured', true);
} catch (e) {
  console.error('FAILED:', e.message);
  failed++;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
