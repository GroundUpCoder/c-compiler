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
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-punes-');

/* ---- session A: launch, geometry, a shot, association ---- */
function sessionApps() {
  const script = [
    'punes &',
    'wmctl wait win puNES',                       // window spawn (0155)
    'sleep 4',                                    // timing subject: core init + emu_turn_on + PPU frames render (blue fill)
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "puNES$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/nes1.png && echo shot-1-ok',
    'kill %1',
    'wmctl wait nowin puNES',                     // window gone (0155)
    'echo ==assoc',
    'grep "^nes" /etc/openwith /usr/share/openwith 2>/dev/null',
    '',
  ].join('\n');

  const a = driveBoot(script, { image, timeout: 420000 });
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

/* ---- session B: pixel-level proof from the PNG shots ---- */
function sessionFrames() {
  const b = driveBoot('cat /root/nes1.png\n', { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });

  // One PNG shot out of the concatenated cat-back stream (#657);
  // null on a missing/short shot, so the callers' `if (!p)` guards hold.
  function parseShot(buf, off) {
    try { return parsePng(buf, off); } catch (e) { return null; }
  }

  const p = parseShot(b.stdout, 0);
  check('frame parses as PNG at full client size 512x480',
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
      const i = (y * p.w + x) * 4;
      const r = b.stdout[i], g = b.stdout[i + 1], bl = b.stdout[i + 2];
      sampled++;
      if (r < 0x80 && g > 0x60 && bl > 0xC0 && bl > r) blue++;
    }
  }
  check('frame is a solid palette-$21 blue fill (6502 ran + PPU painted)',
    blue > sampled * 0.9, `${blue}/${sampled} blue`);
}

/* ---- session C: controller input reaches the emulated CPU ---- */
// The built-in ROM's NMI handler polls controller 1 each frame and reads the
// shift register in the standard order: it tints the backdrop $2A (green) while
// Up is held, else $30 (white) while A is held, else $21 (blue). We inject each
// in turn and confirm the frame reacts:
//   - A (SDL keycode 'z' = 122 → BUT_A): a non-axis button → white.
//   - Up (SDLK_UP = 1073741906 → the UP D-pad axis): white/blue → green.
// This exercises the whole input path — INJECT_KEY → SDL event → set_button →
// input_data_set_standard_controller → raw[]+treated[] → standard-controller
// $4016 read. The Up leg is the todos/0213 regression guard: before the fix,
// set_button poked treated[] with raw[]==0, so the SOCD filter erased the D-pad
// on every read and Up never registered (only A/B/Start/Select, the non-axis
// indices, survived). A green Up frame proves the D-pad now sticks; if it stays
// white/blue the bug is back.
function sessionInput() {
  const script = [
    'punes &',
    'wmctl wait win puNES',                          // window spawn (0155)
    'sleep 4',                                       // timing subject: core init + emu_turn_on + PPU frames render (blue fill)
    'SID=$(wmctl list | grep "puNES$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/ni.png && echo ni-ok',   // no input: blue
    'wmctl keydown $SID 0 122 0',                    // hold A
    'sleep 1',                                       // timing subject: NMI polls the pad -> backdrop tints white over the next frames
    'wmctl shot $SID /root/ap.png && echo ap-ok',    // A held: white
    'wmctl keyup $SID 0 122 0',
    'sleep 1',                                       // timing subject: NMI sees the release -> backdrop returns to blue
    'wmctl shot $SID /root/ar.png && echo ar-ok',    // A released: blue again
    'wmctl keydown $SID 0 1073741906 0',             // hold Up (SDLK_UP; the D-pad axis 0213 fixed)
    'sleep 1',                                       // timing subject: NMI polls the pad -> backdrop tints green over the next frames
    'wmctl shot $SID /root/up.png && echo up-ok',    // Up held: green
    'wmctl keyup $SID 0 1073741906 0',
    'kill %1',
    'wmctl wait nowin puNES',                        // window gone (0155)
    'printf __NI__; cat /root/ni.png; printf __AP__; cat /root/ap.png; printf __AR__; cat /root/ar.png; printf __UP__; cat /root/up.png; printf __END__',
    '',
  ].join('\n');
  const c = driveBoot(script, { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
  const out = c.stdout;
  const text = out.toString('latin1');

  // dominant pixel of the PNG starting at the given byte offset (the shot's
  // signature may sit a few bytes past the marker; find it, decode, then
  // sample the same sparse grid).
  function domColor(off) {
    const start = out.indexOf(PNG_SIG, off);
    if (start < 0) return null;
    let shot = null;
    try { shot = parsePng(out, start); } catch (e) { return null; }
    const px = shot.rgba, end = shot.w * shot.h * 4;
    const counts = new Map();
    for (let p = 0; p + 2 < end; p += 4 * 97) {
      const key = (px[p] << 16) | (px[p + 1] << 8) | px[p + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = 0, bestn = -1;
    for (const [k, n] of counts) if (n > bestn) { bestn = n; best = k; }
    return best.toString(16).padStart(6, '0');
  }
  const domAt = (marker) => {
    const off = out.indexOf(Buffer.from(marker));
    return off >= 0 ? domColor(off) : null;
  };
  const ni = domAt('__NI__');
  const ap = domAt('__AP__');
  const ar = domAt('__AR__');
  const up = domAt('__UP__');

  check('all four input shots captured',
    ['ni-ok', 'ap-ok', 'ar-ok', 'up-ok'].every(t => text.includes(t)), text.slice(0, 160));
  check('no-input frame is the blue backdrop ($21 = 4c9aec)',
    ni === '4c9aec', ni);
  check('holding A tints the frame white ($30 = eceeec) — A button reached the CPU',
    ap === 'eceeec', ap);
  check('releasing A returns the frame to blue ($21 = 4c9aec)',
    ar === '4c9aec', ar);
  // The 0213 regression guard: a held D-pad direction must register. Green ($2A
  // = 4cd020) proves raw[UP] was populated and survived the SOCD $4016 read.
  check('holding Up (D-pad) tints the frame green ($2A = 4cd020) — todos/0213 D-pad reaches the CPU',
    up === '4cd020', up);
}

sessionApps();
sessionFrames();
sessionInput();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\npunes e2e: ${failures} FAILED` : '\npunes e2e: PASS');
process.exit(failures ? 1 : 0);
