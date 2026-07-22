// bughunt-sc round 2: notepad/winmine (corrected titles), run dialog, datepop,
// paint, fileman With-picker.
import path from 'node:path';
import fs from 'node:fs';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3297;
const OUT = path.join(ROOT, 'media', 'bughunt-sc');
fs.mkdirSync(OUT, { recursive: true });
const s = await openOsSession({ port: PORT, serverTries: 900, serverInterval: 1000 });
const { page, setVt, waitOut, waitScreen } = s;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function sh(cmd, ms = 30000) {
  const id = ++seq;
  await setVt(1);
  await page.keyboard.type(`${cmd}; echo BH${id}-""RC=$?\r`);
  await waitOut(`BH${id}-RC=`, ms);
}
async function geom(title) {
  await sh('wmctl list');
  const out = await page.evaluate(() => window.__osOut);
  const re = /(\d+)\s+(\d+)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\S+\s+-?\d+\s+\S+\s+([^\r\n]+)/g;
  let m, last = null;
  while ((m = re.exec(out))) if (m[7].trim().includes(title)) last = m;
  if (!last) throw new Error(`geom: no window ~"${title}"`);
  return { sid: +last[1], pid: +last[2], w: +last[3], h: +last[4], x: +last[5], y: +last[6] };
}
async function shot(name, crop) {
  const data = await page.evaluate(([c]) => {
    const cv = document.getElementById('screen');
    const r = cv.getBoundingClientRect();
    let sx = 0, sy = 0, sw = Math.round(r.width), sh2 = Math.round(r.height), z = 1;
    if (c) { [sx, sy, sw, sh2, z] = c; sx = Math.max(0, sx); sy = Math.max(0, sy); }
    const t = document.createElement('canvas');
    t.width = sw * z; t.height = sh2 * z;
    const ctx = t.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, sx, sy, sw, sh2, 0, 0, sw * z, sh2 * z);
    return t.toDataURL('image/png');
  }, [crop || null]);
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
  console.log('  shot ' + name);
}
async function leg(name, fn) {
  console.log('== leg: ' + name);
  try { await fn(); } catch (e) { console.error(`  LEG-FAIL ${name}: ${e && e.message}`); }
}
const screen = async () => page.evaluate(() => window.__osScreen);
const canvasOrigin = async () => page.evaluate(() => {
  const r = document.getElementById('screen').getBoundingClientRect();
  return { left: r.left, top: r.top };
});

try {
  await setVt(2); await waitScreen(); await sleep(2000);

  await leg('notepad', async () => {
    await sh('notepad &');
    await sh("wmctl wait win 'Untitled - Notepad' 30000");
    const g = await geom('Untitled - Notepad');
    await setVt(2); await sleep(800);
    const cv = await canvasOrigin();
    await page.mouse.click(cv.left + g.x + 100, cv.top + g.y + 80);
    await page.keyboard.type('Sphinx of black quartz, judge my vow. 0123 Illegal Immmlll');
    await sleep(500);
    await shot('notepad', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await shot('notepad-text-3x', [g.x + 2, g.y + 24, 330, 50, 3]);
    await sh("wmctl click 'File'");
    await setVt(2); await sleep(800);
    await shot('notepad-filemenu', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await page.keyboard.press('Escape'); await sleep(300);
    await sh(`wmctl close ${g.sid}`);
    await sh("wmctl click \"Don't Save\" 2>/dev/null || true");
  });

  await leg('winmine', async () => {
    await sh('winmine &');
    await sh("wmctl wait win WineMine 30000");
    const g = await geom('WineMine');
    await setVt(2); await sleep(800);
    await shot('winmine', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('rundialog', async () => {
    await sh('wmctl menu');
    await setVt(2); await sleep(800);
    // row 1 = Run... (virgin boot: Settings row0, Run row1)
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await sleep(800);
    const g = await geom('startrun');
    await shot('rundialog', [g.x - 8, g.y - 8, g.w + 16, g.h + 16, 2]);
    await page.keyboard.type('winbox');
    await sleep(400);
    await shot('rundialog-typed', [g.x - 8, g.y - 8, g.w + 16, g.h + 16, 2]);
    await page.keyboard.press('Escape');
  });

  await leg('datepop', async () => {
    const scr = await screen();
    await sh(`wmctl smove ${scr.w - 40} ${scr.h - 14}`);
    await setVt(2); await sleep(1500);
    await shot('datepop', [scr.w - 360, scr.h - 120, 360, 120, 2]);
  });

  await leg('paint', async () => {
    await sh('paint &');
    await sh('sleep 2');
    const g = await geom('Paint');
    await setVt(2); await sleep(800);
    await shot('paint', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('fileman-with', async () => {
    await sh('fileman &');
    await sh('sleep 2');
    const g = await geom('/root');
    await setVt(2); await sleep(800);
    await shot('fileman-top-3x', [g.x, g.y, g.w, 60, 3]);
    // click hello.c row then the With picker
    await sh("wmctl click 'With'");
    await setVt(2); await sleep(800);
    await shot('fileman-with', null);
    await page.keyboard.press('Escape'); await sleep(300);
    await sh('pkill fileman');
  });
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
console.log('bughunt-more: done');
process.exit(0);
