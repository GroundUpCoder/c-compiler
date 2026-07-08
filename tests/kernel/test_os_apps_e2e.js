#!/usr/bin/env node
// 0015 acceptance, headless: the seeded vendor apps (/bin/doom, /bin/gameboy,
// /bin/snake — built from vendor bin.jsons at seed time, game data landed via
// image.json `bin` entries) run windowed in-OS with zero source changes,
// driven through os/boot.js. Covers: binary-asset seeding (doom1.wad found in
// cwd /root by d_iwad.c, a ROM under /root/roms), optional-entry semantics
// (the gitignored ROMs must not brick boots on other checkouts), WM placement
// + titles for real SDL apps, and `wmctl shot SID` frames that are verifiably
// real (bit-exact shm client pixels: full window dims, rich color
// histograms). Snake (tty app, not SDL) gets a paced interactive session:
// play, quit, shell survives. NOTE snake needs TWO paced 'q's (game over,
// then the "Press q to exit" prompt) — its final read loop spins on EOF, so
// the q's must arrive in separate reads.
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

// The gameboy ROMs are deliberately NOT in the repo (gitignored) — their
// image.json entries are `optional`. With the ROM present locally we play
// Pokémon; without it, gameboy's built-in test ROM (same window, same LCD)
// keeps the test meaningful on any checkout.
const HAVE_ROM = fs.existsSync(path.join(ROOT, 'vendor/gameboy/roms/PokemonBlue.gb'));
const GB_CMD = HAVE_ROM ? 'gameboy /root/roms/PokemonBlue.gb &' : 'gameboy &';

/* ---- optional bin entries: a missing asset skips, a required one fails ----
 * Direct seedEntries unit check (in-memory BlockFS) so the graceful path is
 * exercised on EVERY checkout, including ones where the ROMs exist. */
async function testOptionalSeeding() {
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const mkfs = () => BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(4 * 1024 * 1024));
  const io = {
    readBinary: (p) => {
      if (p === 'present.bin') return new Uint8Array([1, 2, 3]);
      throw new Error(p + ': No such file');
    },
    log: () => {},
  };
  const kfs1 = mkfs();
  const seeded = await COMMON.seedEntries(kfs1, { dirs: ['/etc'], files: {
    '/a': { bin: 'present.bin' },
    '/b': { bin: 'missing.bin', optional: true },
    '/c': { bin: 'present.bin' },
  } }, io).then((s) => s, (e) => e);
  check('optional missing bin entry: seeding completes', seeded === true,
    seeded && seeded.message);
  check('  ...later entries still seeded', kfs1.stat('/c') !== null);
  check('  ...the missing path is absent, not empty', kfs1.stat('/b') === null);

  const err = await COMMON.seedEntries(mkfs(), { dirs: ['/etc'], files: {
    '/b': { bin: 'missing.bin' },
  } }, io).then(() => null, (e) => e);
  check('required missing bin entry still fails the boot', err !== null);
}

/* ---- session A: seed, launch doom + gameboy + quake, list, shot surfaces ---- */
function sessionApps() {
  const script = [
    'ls -l /root/doom1.wad',                        // bin entry seeded
    'ls -l /root/id1/pak0.pak',                     // 18MB bin entry (todos/0018)
    'doom &',
    'sleep 5',                                      // wasm instantiation + WAD load
    GB_CMD,
    'sleep 3.5',
    'quake &',
    'sleep 6',                                      // pak load + demo start
    'echo ==list1',
    'wmctl list',
    'DSID=$(wmctl list | grep "DOOM Shareware$" | sed "s/[^0-9].*//")',
    'GSID=$(wmctl list | grep "Peanut-GB$" | sed "s/[^0-9].*//")',
    'QSID=$(wmctl list | grep "Quake$" | sed "s/[^0-9].*//")',
    'wmctl relmove $QSID 15 5 && echo relmove-ok',  // rel inject over the socket
    // 0021 acceptance: doom is fixed-res (no SDL_WINDOW_RESIZABLE) — the
    // kernel refuses the resize and the window keeps its geometry.
    'wmctl resize $DSID 900 700 || echo resize-refused',
    'wmctl shot $DSID /root/doom.ppm && echo shot-doom-ok',
    'wmctl shot $GSID /root/gb.ppm && echo shot-gb-ok',
    'wmctl shot $QSID /root/quake.ppm && echo shot-quake-ok',
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
  check('doom window is 640x400 (native res — 0024 compositor scaling, no CPU pre-scale)',
    doomRow.includes('640x400'), doomRow);
  const gbRow = row('Peanut-GB');
  check('gameboy opens a window titled "Peanut-GB"' +
    (HAVE_ROM ? ' (ROM from /root/roms)' : ' (built-in test ROM; local ROM absent)'),
    gbRow !== '', JSON.stringify(list1));
  check('gameboy window is 480x432 (160x144 tripled)', gbRow.includes('480x432'), gbRow);

  // Quake (todos/0018): the 18MB pak seeds, the game boots into its demo
  // loop, and its VID_Init relative-mouse request shows as the 'r' flag.
  check('pak0.pak seeded via the bin entry (18689235 bytes)',
    out.includes('18689235'), out.split('\n')[1]);
  const qRow = row('Quake');
  check('quake opens a window titled "Quake"', qRow !== '', JSON.stringify(list1));
  check('quake window is 320x200 (native software renderer)',
    qRow.includes('320x200'), qRow);
  check('quake requested relative mouse (r flag in wmctl list)',
    (qRow.split('\t')[5] || '').includes('r'), qRow);   // FLAGS col (after DST, 0024)
  check('wmctl relmove injects over the socket', out.includes('relmove-ok'));
  check('wmctl resize on fixed-res doom is refused (todos/0021)',
    out.includes('resize-refused'));
  check('doom is not resizable (no R flag in wmctl list)',
    !(doomRow.split('\t')[5] || '').includes('R'), doomRow);   // FLAGS col (after DST, 0024)
  check('wmctl shot wrote all three surface PPMs',
    out.includes('shot-doom-ok') && out.includes('shot-gb-ok') &&
    out.includes('shot-quake-ok'));
}

/* ---- session B: extract the PPMs byte-clean and prove they're real frames ---- */
function sessionFrames() {
  const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: 'cat /root/doom.ppm /root/gb.ppm /root/quake.ppm\n', timeout: 120000,
      maxBuffer: 32 * 1024 * 1024 });   // three raw PPMs ≈ 1.6MB
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
  check('doom shot parses as P6 at full client size 640x400',
    doomPPM !== null && doomPPM.w === 640 && doomPPM.h === 400,
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
      const qPPM = parsePPM(b.stdout, gbPPM.end);
      check('quake shot parses as P6 at full client size 320x200 (todos/0018)',
        qPPM !== null && qPPM.w === 320 && qPPM.h === 200,
        qPPM && `${qPPM.w}x${qPPM.h}`);
      if (qPPM) {
        const qn = frameStats(b.stdout, qPPM);
        check('quake frame is a real render (rich color histogram, not a fill)',
          qn > 50, qn + ' distinct colors');
      }
    }
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

(async () => {
  await testOptionalSeeding();
  sessionApps();
  sessionFrames();
  const sout = await snakeSession();
  check('snake draws its board through the kernel tty', sout.includes('Arrow keys to move'),
    JSON.stringify(sout.slice(0, 200)));
  check('snake reaches GAME OVER on q', sout.includes('GAME OVER'));
  check('snake exits 0; shell survives', sout.includes('SNAKE-EXIT=0'),
    JSON.stringify(sout.slice(-200)));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nos apps e2e: ${failures} FAILED` : '\nos apps e2e: PASS');
  process.exit(failures ? 1 : 0);
})();
