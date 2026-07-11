#!/usr/bin/env node
// 0112 acceptance, headless: /bin/mgba (mGBA 0.10.5 core — ARM7TDMI GBA) runs
// windowed in-OS. mGBA is the GBA leg (the platform /bin/gameboy and
// /bin/sameboy can't reach) and the default .gba association (0072 store).
// This drives the built-in MODE 3 test ROM end-to-end: the ARM core boots on
// mGBA's HLE BIOS, the software renderer paints a solid red frame, and the
// window composites at 480x320 (240x160 doubled). .gb/.gbc must stay pointed
// at /bin/sameboy (mGBA is additive, not a replacement).
//
// Run: node tests/kernel/test_mgba_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-mgba-'));
const image = path.join(tmp, 'os.img');

/* ---- session A: launch, geometry, a shot, associations ---- */
function sessionApps() {
  const script = [
    'mgba &',
    'sleep 6',                                   // core init + HLE BIOS + test ROM
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "mGBA$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/gba1.ppm && echo shot-1-ok',
    'kill %1',
    'sleep 1',
    'grep "^gb" /etc/openwith /usr/share/openwith 2>/dev/null || echo ==assoc',
    'cat /usr/share/openwith',
    '',
  ].join('\n');

  const a = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 300000 });
  if (a.error) throw a.error;
  const out = a.stdout;
  const list1 = (out.split('==list1\n')[1] || '');
  const row = list1.split('\n').find(l => l.endsWith('\tmGBA')) || '';

  check('mgba boots the built-in test ROM',
    out.includes('using built-in test ROM') && out.includes('GBA core ready'),
    JSON.stringify(out.slice(0, 200)));
  check('mgba opens a window titled "mGBA"', row !== '', JSON.stringify(list1));
  check('mgba window is 480x320 (240x160 doubled)', row.includes('480x320'), row);
  check('frame shot written', out.includes('shot-1-ok'));
  check('the .gba association points at /bin/mgba',
    /gba\t\/bin\/mgba/.test(out), out.split('\n').slice(-10).join('|'));
  check('.gb/.gbc still default to /bin/sameboy (mgba is additive)',
    /gb\t\/bin\/sameboy/.test(out) && /gbc\t\/bin\/sameboy/.test(out),
    out.split('\n').slice(-10).join('|'));
}

/* ---- session B: pixel-level proof from the PPM ---- */
function sessionFrames() {
  const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: 'cat /root/gba1.ppm\n', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (b.error) throw b.error;

  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }

  const p = parsePPM(b.stdout, 0);
  check('frame parses as P6 at full client size 480x320',
    p !== null && p.w === 480 && p.h === 320, p && `${p.w}x${p.h}`);
  if (!p) return;

  // The MODE 3 test ROM fills the whole framebuffer with BGR555 red, which
  // mGBA expands to RGBA red. Sample on a grid and require the frame is
  // overwhelmingly red — proves the ARM core executed and the software
  // renderer wrote real pixels (not a cleared/black surface).
  let red = 0, sampled = 0;
  for (let y = 0; y < p.h; y += 4) {
    for (let x = 0; x < p.w; x += 4) {
      const i = p.data + (y * p.w + x) * 3;
      const r = b.stdout[i], g = b.stdout[i + 1], bl = b.stdout[i + 2];
      sampled++;
      if (r > 0x80 && g < 0x40 && bl < 0x40) red++;
    }
  }
  check('frame is a red MODE 3 fill (ARM core ran + software renderer painted)',
    red > sampled * 0.9, `${red}/${sampled} red`);
}

sessionApps();
sessionFrames();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nmgba e2e: ${failures} FAILED` : '\nmgba e2e: PASS');
process.exit(failures ? 1 : 0);
