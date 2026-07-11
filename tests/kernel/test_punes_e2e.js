#!/usr/bin/env node
// 0088 acceptance, headless: /bin/punes (puNES core — cycle-accurate NES/
// Famicom 6502/2C02/2A03) runs windowed in-OS. puNES is the NES leg and the
// default .nes association (0072 store). This drives the built-in NROM test
// ROM end-to-end: the 6502 boots on mapper 0, waits out PPU warm-up, writes a
// distinctive backdrop colour ($21) into palette RAM and enables rendering, so
// the PPU paints a solid frame that composites at 512x480 (256x240 doubled).
// Same solid-fill acceptance shape as /bin/mgba's MODE 3 red test.
//
// Run: node tests/kernel/test_punes_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-punes-'));
const image = path.join(tmp, 'os.img');

/* ---- session A: launch, geometry, a shot, association ---- */
function sessionApps() {
  const script = [
    'punes &',
    'sleep 8',                                   // core init + emu_turn_on + frames
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "puNES$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/nes1.ppm && echo shot-1-ok',
    'kill %1',
    'sleep 1',
    'echo ==assoc',
    'grep "^nes" /etc/openwith /usr/share/openwith 2>/dev/null',
    '',
  ].join('\n');

  const a = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 420000 });
  if (a.error) throw a.error;
  const out = a.stdout;
  const list1 = (out.split('==list1\n')[1] || '');
  const row = list1.split('\n').find(l => l.endsWith('\tpuNES')) || '';

  check('punes boots the built-in test ROM',
    out.includes('using built-in test ROM'),
    JSON.stringify(out.slice(0, 200)));
  check('punes opens a window titled "puNES"', row !== '', JSON.stringify(list1));
  check('punes window is 512x480 (256x240 doubled)', row.includes('512x480'), row);
  check('frame shot written', out.includes('shot-1-ok'));
  check('the .nes association points at /bin/punes',
    /nes\t\/bin\/punes/.test(out), out.split('\n').slice(-6).join('|'));
}

/* ---- session B: pixel-level proof from the PPM ---- */
function sessionFrames() {
  const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: 'cat /root/nes1.ppm\n', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (b.error) throw b.error;

  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }

  const p = parsePPM(b.stdout, 0);
  check('frame parses as P6 at full client size 512x480',
    p !== null && p.w === 512 && p.h === 480, p && `${p.w}x${p.h}`);
  if (!p) return;

  // The test ROM fills the frame with NES palette colour $21 = {76,154,236},
  // a bright blue (blue-dominant, low red). Sample on a grid and require the
  // frame is overwhelmingly that blue — proves the 6502 executed, the PPU
  // applied the CPU-written palette, and the frame reached the surface (not a
  // cleared/host-default window).
  let blue = 0, sampled = 0;
  for (let y = 0; y < p.h; y += 4) {
    for (let x = 0; x < p.w; x += 4) {
      const i = p.data + (y * p.w + x) * 3;
      const r = b.stdout[i], g = b.stdout[i + 1], bl = b.stdout[i + 2];
      sampled++;
      if (r < 0x80 && g > 0x60 && bl > 0xC0 && bl > r) blue++;
    }
  }
  check('frame is a solid palette-$21 blue fill (6502 ran + PPU painted)',
    blue > sampled * 0.9, `${blue}/${sampled} blue`);
}

/* ---- session C: controller input reaches the emulated CPU ---- */
// The built-in ROM's NMI handler polls controller 1 each frame and tints the
// backdrop white ($30) while the A button is held, else blue ($21). Inject the
// A key (SDL keycode 'z' = 122, which main.c maps to BUT_A) and confirm the
// frame flips to white, then releases back to blue. This exercises the whole
// input path — INJECT_KEY → SDL event → set_button → port[0].data.treated[] →
// standard-controller $4016 read — which is dead unless port[].type is wired to
// CTRL_STANDARD (the bug this leg guards).
function sessionInput() {
  const script = [
    'punes &',
    'sleep 8',
    'SID=$(wmctl list | grep "puNES$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/ni.ppm && echo ni-ok',   // no input: blue
    'wmctl keydown $SID 0 122 0',                    // hold A
    'sleep 1',
    'wmctl shot $SID /root/ap.ppm && echo ap-ok',    // A held: white
    'wmctl keyup $SID 0 122 0',
    'kill %1',
    'sleep 1',
    'printf __NI__; cat /root/ni.ppm; printf __AP__; cat /root/ap.ppm; printf __END__',
    '',
  ].join('\n');
  const c = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (c.error) throw c.error;
  const out = c.stdout;
  const text = out.toString('latin1');

  // dominant pixel of the PPM starting at the given byte offset (a P6 header
  // may sit a few bytes past the marker; find it, then sample a sparse grid).
  function domColor(off) {
    const start = out.indexOf(Buffer.from('P6\n'), off);
    if (start < 0) return null;
    const head = out.toString('latin1', start, start + 24);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = start + m[0].length, end = data + w * h * 3;
    const counts = new Map();
    for (let p = data; p + 2 < end && p + 2 < out.length; p += 3 * 97) {
      const key = (out[p] << 16) | (out[p + 1] << 8) | out[p + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = 0, bestn = -1;
    for (const [k, n] of counts) if (n > bestn) { bestn = n; best = k; }
    return best.toString(16).padStart(6, '0');
  }
  const niOff = out.indexOf(Buffer.from('__NI__'));
  const apOff = out.indexOf(Buffer.from('__AP__'));
  const ni = niOff >= 0 ? domColor(niOff) : null;
  const ap = apOff >= 0 ? domColor(apOff) : null;

  check('both input shots captured',
    text.includes('ni-ok') && text.includes('ap-ok'), text.slice(0, 120));
  check('no-input frame is the blue backdrop ($21 = 4c9aec)',
    ni === '4c9aec', ni);
  check('holding A tints the frame white ($30 = eceeec) — input reached the CPU',
    ap === 'eceeec', ap);
}

sessionApps();
sessionFrames();
sessionInput();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\npunes e2e: ${failures} FAILED` : '\npunes e2e: PASS');
process.exit(failures ? 1 : 0);
