#!/usr/bin/env node
// 0015 acceptance, headless: the seeded vendor apps (/bin/doom, /bin/gameboy,
// /bin/snake — built from vendor bin.jsons at seed time, game data landed via
// image.json `bin` entries) run windowed in-OS with zero source changes,
// driven through os/boot.js. Covers: binary-asset seeding (doom1.wad found in
// cwd /root by d_iwad.c, a ROM under /root/roms), WM placement + titles for
// real SDL apps, and `wmctl shot SID` frames that are verifiably real
// (bit-exact shm client pixels: full window dims, rich color histograms).
// Snake (tty app, not SDL) gets a paced interactive session: play, quit,
// shell survives. NOTE snake needs TWO paced 'q's (game over, then the
// "Press q to exit" prompt) — its final read loop spins on EOF, so the q's
// must arrive in separate reads.
//
// Run: node tests/kernel/test_os_apps_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-apps-'));
const image = path.join(tmp, 'os.img');

/* ---- session A: seed, launch doom + gameboy, list, shot their surfaces ---- */
const script = [
  'ls -l /root/doom1.wad',                        // bin entry seeded
  'doom &',
  'sleep 5',                                      // wasm instantiation + WAD load
  'gameboy /root/roms/PokemonBlue.gb &',
  'sleep 3.5',
  'echo ==list1',
  'wmctl list',
  'DSID=$(wmctl list | grep "DOOM Shareware$" | sed "s/[^0-9].*//")',
  'GSID=$(wmctl list | grep "Peanut-GB$" | sed "s/[^0-9].*//")',
  'wmctl shot $DSID /root/doom.ppm && echo shot-doom-ok',
  'wmctl shot $GSID /root/gb.ppm && echo shot-gb-ok',
  '',
].join('\n');

const a = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
  { input: script, encoding: 'utf8', timeout: 300000 });
if (a.error) throw a.error;
const out = a.stdout;
const list1 = (out.split('==list1\n')[1] || '');
const row = (title) => list1.split('\n').find(l => l.endsWith('\t' + title)) || '';

check('doom1.wad seeded via the bin entry (4196020 bytes)',
  out.includes('4196020'), out.split('\n')[0]);
const doomRow = row('DOOM Shareware');
check('doom opens a WM-placed window titled "DOOM Shareware"',
  doomRow !== '', JSON.stringify(list1));
check('doom window is 1280x800 (640x400 doubled — the app chose, not the WM)',
  doomRow.includes('1280x800'), doomRow);
const gbRow = row('Peanut-GB');
check('gameboy opens a window titled "Peanut-GB" (ROM from /root/roms)',
  gbRow !== '', JSON.stringify(list1));
check('gameboy window is 480x432 (160x144 tripled)', gbRow.includes('480x432'), gbRow);
check('wmctl shot wrote both surface PPMs',
  out.includes('shot-doom-ok') && out.includes('shot-gb-ok'));

/* ---- session B: extract the PPMs byte-clean and prove they're real frames ---- */
const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
  { input: 'cat /root/doom.ppm /root/gb.ppm\n', timeout: 120000,
    maxBuffer: 32 * 1024 * 1024 });   // two raw PPMs ≈ 5.7MB
if (b.error) throw b.error;

function parsePPM(buf, off) {
  const head = buf.toString('latin1', off, off + 32);
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!m) return null;
  const w = +m[1], h = +m[2], data = off + m[0].length;
  return { w, h, data, end: data + w * h * 3 };
}
function frameStats(buf, ppm) {
  const colors = new Set();
  for (let y = 0; y < ppm.h; y += 3) {
    for (let x = 0; x < ppm.w; x += 3) {
      const i = ppm.data + (y * ppm.w + x) * 3;
      colors.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
    }
  }
  return colors.size;
}

const doomPPM = parsePPM(b.stdout, 0);
check('doom shot parses as P6 at full client size 1280x800',
  doomPPM !== null && doomPPM.w === 1280 && doomPPM.h === 800,
  doomPPM && `${doomPPM.w}x${doomPPM.h}`);
if (doomPPM) {
  const n = frameStats(b.stdout, doomPPM);
  check('doom frame is a real render (rich color histogram, not a fill)',
    n > 50, n + ' distinct colors');
  const gbPPM = parsePPM(b.stdout, doomPPM.end);
  check('gameboy shot parses as P6 at full client size 480x432',
    gbPPM !== null && gbPPM.w === 480 && gbPPM.h === 432,
    gbPPM && `${gbPPM.w}x${gbPPM.h}`);
  if (gbPPM) {
    const gn = frameStats(b.stdout, gbPPM);
    check('gameboy frame has the LCD palette (>=2 colors, not a fill)',
      gn >= 2, gn + ' distinct colors');
  }
}

/* ---- session C: snake — a paced interactive tty session ---- */
// Timers, not script `sleep`: snake's poll_key() slurps every queued tty byte,
// so the two q's (and the trailing shell line) must arrive while it's already
// running, in separate reads.
function snakeSession() {
  return new Promise((resolve) => {
    const p = cp.spawn('node', [BOOT, '--image=' + image, '--quiet', '--tty-out'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    let sout = '';
    p.stdout.on('data', (d) => { sout += d.toString('latin1'); });
    p.on('close', () => resolve(sout));
    const feed = [
      [3500, 'snake\n'],       // boot + prompt
      [7000, 'q'],             // game over
      [8000, 'q'],             // dismiss "Press q to exit"
      [9000, 'echo SNAKE-EXIT=$?\n'],
      [10500, null],           // EOF -> hush exits -> halt
    ];
    for (const [t, s] of feed) {
      setTimeout(() => { if (s === null) p.stdin.end(); else p.stdin.write(s); }, t);
    }
    setTimeout(() => p.kill('SIGKILL'), 60000).unref();
  });
}

snakeSession().then((sout) => {
  check('snake draws its board through the kernel tty', sout.includes('Arrow keys to move'),
    JSON.stringify(sout.slice(0, 200)));
  check('snake reaches GAME OVER on q', sout.includes('GAME OVER'));
  check('snake exits 0; shell survives', sout.includes('SNAKE-EXIT=0'),
    JSON.stringify(sout.slice(-200)));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nos apps e2e: ${failures} FAILED` : '\nos apps e2e: PASS');
  process.exit(failures ? 1 : 0);
});
