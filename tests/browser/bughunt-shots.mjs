// bughunt-sc: boot gucOS headless, drive apps, save screenshots for visual
// inspection (NOT a pass/fail test — an evidence collector).
// Usage: node bughunt-shots.mjs [legs...]   (default: all)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const PORT = 3299;
const OUT = path.join(ROOT, 'media', 'bughunt-sc');
fs.mkdirSync(OUT, { recursive: true });

{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet'],
    { stdio: 'inherit' });
  if (r.status !== 0) { console.error('mkpkg failed'); process.exit(1); }
}

const s = await openOsSession({ port: PORT, serverTries: 900, serverInterval: 1000 });
const { page, setVt, waitOut, waitScreen } = s;
const only = process.argv.slice(2);
const want = (leg) => only.length === 0 || only.includes(leg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
// Run a shell line on VT1, wait for its completion marker (split needle).
async function sh(cmd, ms = 30000) {
  const id = ++seq;
  await setVt(1);
  await page.keyboard.type(`${cmd}; echo BH${id}-""RC=$?\r`);
  await waitOut(`BH${id}-RC=`, ms);
  const out = await page.evaluate(() => window.__osOut);
  const m = new RegExp(`BH${id}-RC=(\\d+)`).exec(out);
  return m ? Number(m[1]) : -1;
}

// Last-matching wmctl list row whose TITLE contains `title`.
async function geom(title) {
  await sh('wmctl list');
  const out = await page.evaluate(() => window.__osOut);
  const re = /(\d+)\s+(\d+)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\S+\s+-?\d+\s+\S+\s+([^\r\n]+)/g;
  let m, last = null;
  while ((m = re.exec(out))) {
    if (m[7].trim().includes(title)) last = m;
  }
  if (!last) throw new Error(`geom: no window titled ~"${title}" in wmctl list`);
  return { sid: +last[1], pid: +last[2], w: +last[3], h: +last[4], x: +last[5], y: +last[6] };
}

async function toVt2() {
  await setVt(2);
  await waitScreen();
  await sleep(1800); // EV_SCREEN quiesce (no marker exists for it)
}

async function shot(name, crop) {
  const data = await page.evaluate(([c]) => {
    const cv = document.getElementById('screen');
    const r = cv.getBoundingClientRect();
    let sx = 0, sy = 0, sw = Math.round(r.width), sh2 = Math.round(r.height), z = 1;
    if (c) {
      [sx, sy, sw, sh2, z] = c;
      sx = Math.max(0, sx); sy = Math.max(0, sy);
      sw = Math.min(sw, Math.round(r.width) - sx);
      sh2 = Math.min(sh2, Math.round(r.height) - sy);
    }
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
  if (!want(name)) return;
  console.log('== leg: ' + name);
  try { await fn(); } catch (e) { console.error(`  LEG-FAIL ${name}: ${e && e.message}`); }
}

const screen = async () => page.evaluate(() => window.__osScreen);

try {
  await leg('desktop', async () => {
    await toVt2();
    await shot('desktop');
  });

  await leg('software', async () => {
    await sh('software &');
    await sh('wmctl wait win Software 30000');
    await sh('sleep 3'); // let the catalog load + cards fill
    const g = await geom('Software');
    await toVt2();
    await shot('sc-window', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await shot('sc-toggle-4x', [g.x + 240, g.y + 4, 300, 52, 4]);
    await sh("wmctl click 'Install to Desktop'");
    await setVt(2); await sleep(800);
    await shot('sc-toggle-checked-4x', [g.x + 240, g.y + 4, 300, 52, 4]);
    await shot('sc-cards-2x', [g.x, g.y + 76, g.w, 180, 2]);
    await sh("wmctl click 'Install to Desktop'"); // restore OFF
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('fontramp', async () => {
    await sh('fontramp &');
    await sh("wmctl wait win 'Font Ramp' 30000");
    const g = await geom('Font Ramp');
    await toVt2();
    await shot('fontramp', [g.x, g.y, g.w, g.h, 1]);
    await shot('fontramp-aa-small-3x', [g.x, g.y, 640, 130, 3]);
    await shot('fontramp-aa-mid-3x', [g.x, g.y + 130, 640, 160, 3]);
    await shot('fontramp-mono-small-3x', [g.x, g.y + 320, 640, 130, 3]);
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('startmenu', async () => {
    await toVt2();
    await sh('wmctl menu');
    await setVt(2); await sleep(1000);
    const scr = await screen();
    await shot('startmenu', [0, scr.h - 330, 480, 330, 1]);
    await shot('startmenu-2x', [0, scr.h - 320, 210, 290, 2]);
    await sh('wmctl menu'); // toggle off
  });

  await leg('notepad', async () => {
    await sh('notepad &');
    await sh('wmctl wait atleast Notepad 1 30000');
    const g = await geom('Notepad');
    await toVt2();
    // type into the edit area through the real input path
    const cv = await page.evaluate(() => {
      const r = document.getElementById('screen').getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    await page.mouse.click(cv.left + g.x + 60, cv.top + g.y + 80);
    await page.keyboard.type('Sphinx of black quartz, judge my vow. 0123456789 Illegal Immmlll');
    await sleep(500);
    await shot('notepad', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await shot('notepad-text-3x', [g.x + 4, g.y + 24, 320, 60, 3]);
    await sh("wmctl click 'File'");
    await setVt(2); await sleep(800);
    await shot('notepad-filemenu', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await sh(`wmctl close ${g.sid}`, 60000);
  });

  await leg('ctlpanel', async () => {
    await sh('ctlpanel &');
    await sh('sleep 2');
    const g = await geom('Control Panel');
    await toVt2();
    await shot('ctlpanel', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await sh(`wmctl close ${g.sid}`);
    await sh('ctlpanel Sounds &');
    await sh('sleep 2');
    const g2 = await geom('Sounds');
    await setVt(2); await sleep(800);
    await shot('ctlpanel-sounds', [g2.x - 12, g2.y - 34, g2.w + 24, g2.h + 46, 1]);
    await shot('ctlpanel-sounds-3x', [g2.x, g2.y, 320, 90, 3]);
    await sh(`wmctl close ${g2.sid}`);
  });

  await leg('fileman', async () => {
    await sh('fileman &');
    await sh('sleep 2');
    const g = await geom('/root');
    await toVt2();
    await shot('fileman', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('winmine', async () => {
    await sh('winmine &');
    await sh('sleep 2');
    const g = await geom('Minesweeper');
    await toVt2();
    await shot('winmine', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('term', async () => {
    await sh('term &');
    await sh('wmctl wait atleast term 1 30000');
    const g = await geom('term');
    await toVt2();
    const cv = await page.evaluate(() => {
      const r = document.getElementById('screen').getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    await page.mouse.click(cv.left + g.x + 100, cv.top + g.y + 100);
    await page.keyboard.type('ls /bin | head -8\r');
    await sleep(1200);
    await shot('term', [g.x - 12, g.y - 34, g.w + 24, g.h + 46, 1]);
    await shot('term-3x', [g.x + 2, g.y + 2, 300, 90, 3]);
    await sh(`wmctl close ${g.sid}`);
  });

  await leg('taskbar', async () => {
    await sh('winbox &');
    await sh('sleep 1');
    await toVt2();
    const scr = await screen();
    await shot('taskbar', [0, scr.h - 40, scr.w, 40, 2]);
    // right-click the empty strip (left of the clock region)
    await sh(`wmctl sdown ${scr.w - 220} ${scr.h - 14} 3`);
    await sh(`wmctl sup ${scr.w - 220} ${scr.h - 14} 3`);
    await setVt(2); await sleep(800);
    await shot('taskbar-menu', [scr.w - 500, scr.h - 320, 500, 320, 1]);
    await page.keyboard.press('Escape');
    await sleep(400);
  });

  await leg('overview', async () => {
    await sh('gdidemo &');
    await sh('sleep 2');
    await sh('wmctl overview');
    await setVt(2); await sleep(1200);
    await shot('overview');
    await sh('wmctl overview');
    await sh('pkill gdidemo; pkill winbox');
  });
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
console.log('bughunt-shots: done, media at ' + OUT);
process.exit(0);
