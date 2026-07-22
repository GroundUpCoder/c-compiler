// bughunt-sc round 3: datepop via click, notepad menus via real mouse.
import path from 'node:path';
import fs from 'node:fs';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3296;
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

  await leg('datepop-click', async () => {
    const scr = await screen();
    const cv = await canvasOrigin();
    await page.mouse.click(cv.left + scr.w - 45, cv.top + scr.h - 14);
    await sleep(900);
    await shot('datepop-click', [scr.w - 400, scr.h - 140, 400, 140, 2]);
    await page.mouse.click(cv.left + scr.w / 2, cv.top + scr.h / 2);
  });

  await leg('notepad-menu-mouse', async () => {
    await sh('notepad &');
    await sh("wmctl wait win 'Untitled - Notepad' 30000");
    const g = await geom('Untitled - Notepad');
    await setVt(2); await sleep(800);
    const cv = await canvasOrigin();
    // File is the first bar item, ~x=30 in the 30px menu bar band
    await page.mouse.click(cv.left + g.x + 34, cv.top + g.y + 40);
    await sleep(700);
    await shot('notepad-filemenu-mouse', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    // hover down to a menu item for the hot state
    await page.mouse.move(cv.left + g.x + 60, cv.top + g.y + 140);
    await sleep(400);
    await shot('notepad-filemenu-hot', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await page.keyboard.press('Escape'); await sleep(300);
    await sh('pkill notepad');
  });
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
console.log('bughunt-round3: done');
process.exit(0);
