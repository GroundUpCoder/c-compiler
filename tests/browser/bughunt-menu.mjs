// bughunt-sc: interactive start-menu probe — are the root rows (Settings/Run)
// really absent, or just invisible?
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3298;
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

try {
  await sh('ls -la /root/.config/ 2>&1; cat /root/.config/pinned /root/.config/recent 2>&1');
  const cfg = await page.evaluate(() => window.__osOut);
  console.log('CONFIG TAIL:\n' + cfg.slice(-900));

  await setVt(2); await waitScreen(); await sleep(2000);
  await sh('wmctl menu');
  await setVt(2); await sleep(1000);

  // find the startmenu window geometry
  await sh('wmctl list');
  const out = await page.evaluate(() => window.__osOut);
  const re = /(\d+)\s+(\d+)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\S+\s+-?\d+\s+\S+\s+startmenu/g;
  let m, g = null;
  while ((m = re.exec(out))) g = { sid: +m[1], w: +m[3], h: +m[4], x: +m[5], y: +m[6] };
  console.log('startmenu geom: ' + JSON.stringify(g));
  if (!g) throw new Error('no startmenu window');

  await setVt(2); await sleep(500);
  await shot('menu-plain-2x', [g.x, g.y, g.w, g.h, 2]);

  // hover where Settings should be (row 0: X0+10, SM_PAD+14)
  await sh(`wmctl smove ${g.x + 120} ${g.y + 18}`);
  await setVt(2); await sleep(600);
  await shot('menu-hover-row0-2x', [g.x, g.y, g.w, g.h, 2]);

  // keyboard: Down should walk the rows and highlight them
  await page.keyboard.press('ArrowDown');
  await sleep(400);
  await shot('menu-down1-2x', [g.x, g.y, g.w, g.h, 2]);
  await page.keyboard.press('ArrowDown');
  await sleep(400);
  await shot('menu-down2-2x', [g.x, g.y, g.w, g.h, 2]);

  // type into search to prove the search path draws rows
  await page.keyboard.type('note');
  await sleep(800);
  await shot('menu-search-note-2x', [g.x, g.y, g.w, g.h, 2]);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
console.log('bughunt-menu: done');
process.exit(0);
