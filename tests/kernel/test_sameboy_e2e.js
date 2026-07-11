#!/usr/bin/env node
// 0075 acceptance, headless: /bin/sameboy (SameBoy v1.0.3 core, the
// cycle-accurate GB/GBC sibling of /bin/gameboy) runs windowed in-OS.
// Covers: the DMG path end-to-end through SameBoy's real dmg_boot (built-in
// checkerboard test ROM renders the exact GB_PALETTE_GREY shades and
// animates between shots), and — when the gitignored ROM is present
// locally — the CGB path through cgb_boot (Super Mario Bros. Deluxe reaches
// a colorful frame; boot-ROM type GB_BOOT_ROM_CGB_E must map to the CGB
// image, the launch bug this leg guards). SameBoy is now the default
// .gb/.gbc association (0072 store flipped to /bin/sameboy — it boots and
// runs better than Peanut-GB) — asserted here so the default can't silently
// regress. /bin/gameboy remains installed as the lighter alternate core.
//
// Run: node tests/kernel/test_sameboy_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-sameboy-');

// The ROMs are gitignored (optional image entries); without the GBC ROM the
// CGB leg skips and the DMG leg (built-in test ROM) still proves the core.
const HAVE_GBC = fs.existsSync(path.join(ROOT, 'vendor/gameboy/roms/SuperMarioDeluxe.gbc'));

/* ---- session A: launch, geometry, shots (DMG animation + optional CGB) ---- */
function sessionApps() {
  const script = [
    'sameboy &',
    'sleep 5',                                     // instantiation + dmg_boot + checkerboard
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "SameBoy$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/sb1.ppm && echo shot-1-ok',
    'sleep 2.5',
    'wmctl shot $SID /root/sb2.ppm && echo shot-2-ok',
    'kill %1',
    'sleep 1',
  ].concat(HAVE_GBC ? [
    'sameboy /root/roms/SuperMarioDeluxe.gbc &',
    'sleep 20',                                    // cgb_boot animation + game intro
    'CSID=$(wmctl list | grep "SameBoy$" | sed "s/[^0-9].*//")',
    'wmctl shot $CSID /root/sbc.ppm && echo shot-cgb-ok',
    'sleep 1',
  ] : []).concat([
    'grep "^gb" /etc/openwith /usr/share/openwith 2>/dev/null || echo ==assoc',
    'cat /usr/share/openwith',
    '',
  ]).join('\n');

  const a = driveBoot(script, { image });
  const out = a.stdout;
  const list1 = (out.split('==list1\n')[1] || '');
  const row = list1.split('\n').find(l => l.endsWith('\tSameBoy')) || '';

  check('sameboy boots the built-in test ROM on DMG-B',
    out.includes('Using built-in test ROM') && out.includes('SameBoy core, model DMG-B'),
    JSON.stringify(out.slice(0, 120)));
  check('sameboy opens a window titled "SameBoy"', row !== '', JSON.stringify(list1));
  check('sameboy window is 480x432 (160x144 tripled)', row.includes('480x432'), row);
  check('both DMG shots written', out.includes('shot-1-ok') && out.includes('shot-2-ok'));
  if (HAVE_GBC) {
    check('GBC ROM run selects CGB-E from the header flag',
      out.includes('SameBoy core, model CGB-E'), JSON.stringify(out.slice(0, 300)));
    check('CGB shot written', out.includes('shot-cgb-ok'));
  } else {
    console.log('  skip CGB leg (vendor/gameboy/roms/SuperMarioDeluxe.gbc absent)');
  }
  check('the .gb/.gbc association points at /bin/sameboy (0072 default = SameBoy)',
    /gb\t\/bin\/sameboy/.test(out) && /gbc\t\/bin\/sameboy/.test(out) &&
    !/gbc?\t\/bin\/gameboy/.test(out), out.split('\n').slice(-8).join('|'));
}

/* ---- session B: pixel-level proof from the PPMs ---- */
function sessionFrames() {
  const files = ['/root/sb1.ppm', '/root/sb2.ppm'].concat(HAVE_GBC ? ['/root/sbc.ppm'] : []);
  const b = driveBoot('cat ' + files.join(' ') + '\n',
    { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });

  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  function colorSet(buf, ppm) {
    const colors = new Set();
    for (let y = 0; y < ppm.h; y += 3) {
      for (let x = 0; x < ppm.w; x += 3) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        colors.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
      }
    }
    return colors;
  }

  const p1 = parsePPM(b.stdout, 0);
  check('DMG shot 1 parses as P6 at full client size 480x432',
    p1 !== null && p1.w === 480 && p1.h === 432, p1 && `${p1.w}x${p1.h}`);
  if (!p1) return;

  // The frontend leaves SameBoy's default GB_PALETTE_GREY in place, so a
  // DMG frame may contain ONLY the four grey shades — exact values, not a
  // histogram guess. The checkerboard uses at least 3 of them.
  const GREYS = new Set([0x000000, 0x555555, 0xAAAAAA, 0xFFFFFF]);
  const c1 = colorSet(b.stdout, p1);
  check('DMG frame uses >=3 of the 4 exact GB_PALETTE_GREY shades',
    c1.size >= 3, c1.size + ' colors');
  check('DMG frame contains ONLY grey-palette shades (real LCD render, not a fill)',
    [...c1].every(c => GREYS.has(c)),
    [...c1].map(c => c.toString(16)).join(','));

  const p2 = parsePPM(b.stdout, p1.end);
  check('DMG shot 2 parses at 480x432', p2 !== null && p2.w === 480 && p2.h === 432);
  if (p2) {
    let diff = 0;
    for (let i = 0; i < p1.end - p1.data; i++) {
      if (b.stdout[p1.data + i] !== b.stdout[p2.data + i]) diff++;
    }
    check('the test ROM animates (shots 2.5s apart differ — SCX scroll)',
      diff > 1000, diff + ' bytes differ');

    if (HAVE_GBC) {
      const p3 = parsePPM(b.stdout, p2.end);
      check('CGB shot parses at 480x432', p3 !== null && p3.w === 480 && p3.h === 432);
      if (p3) {
        const c3 = colorSet(b.stdout, p3);
        const nonGrey = [...c3].filter(c => !GREYS.has(c));
        check('CGB frame is colorful (>=6 distinct colors — real cgb_boot handoff)',
          c3.size >= 6, c3.size + ' colors');
        check('CGB frame has non-grey colors (CGB palettes live, not DMG compat greys)',
          nonGrey.length >= 3, nonGrey.slice(0, 5).map(c => c.toString(16)).join(','));
      }
    }
  }
}

sessionApps();
sessionFrames();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nsameboy e2e: ${failures} FAILED` : '\nsameboy e2e: PASS');
process.exit(failures ? 1 : 0);
