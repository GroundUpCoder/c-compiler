#!/usr/bin/env node
// 0061 acceptance, headless: cairo (vendor/cairo, the platform's modern 2D
// vector API) renders into an shm window surface through os/boot.js.
//   - `cairodemo selftest`: the vector scene (gradients, AA, dashes, alpha,
//     cairo-ft text from the baked font) anchor-pixel-asserted in-OS.
//   - windowed `cairodemo`: WM placement + title, RESIZABLE (R flag),
//     `wmctl shot` probed at the scene's anchor coordinates (mirror
//     vendor/cairo/demo/main.c draw_scene/selftest — change together).
//   - KEYDOWN toggles the dark theme (an shm repaint through the swizzle
//     path), probed dark then back light.
//   - `wmctl resize` (it IS resizable): client re-derives the surface and
//     redraws the VECTOR scene at 600x450 — anchors at scaled coordinates.
//
// Run: node tests/kernel/test_cairo_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-cairo-');

/* ---- session A: selftest, then the windowed scene + shots ---- */
function sessionA() {
  const script = [
    'cairodemo selftest',
    'echo SELFTEST-EXIT=$?',
    'cairodemo &',
    'wmctl wait win cairodemo',                      // window spawn (0155)
    'sleep 2',                                       // timing subject: wasm boot + freetype + first vector paint render
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "cairodemo$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/c1.ppm && echo shot1-ok',
    'wmctl key $SID 7 100',                          // any KEYDOWN -> dark theme
    'sleep 2',                                       // timing subject: dark-theme vector redraw render
    'wmctl shot $SID /root/c2.ppm && echo shot2-ok',
    'wmctl key $SID 7 100',                          // toggle back
    'wmctl resize $SID 600 450 && echo resize-ok',
    'wmctl wait dim $SID 600x450',                   // resize ack landed (0155)
    'sleep 1',                                       // timing subject: post-resize vector redraw render
    'echo ==list2',
    'wmctl list',
    'wmctl shot $SID /root/c3.ppm && echo shot3-ok',
    '',
  ].join('\n');

  const a = driveBoot(script, { image });
  const out = a.stdout;

  check('selftest passes in-OS (9 anchors, incl. cairo-ft text)',
    out.includes('cairodemo selftest ok (9)'),
    (out.match(/FAIL [^\n]*/g) || []).join('; ') || out.slice(0, 300));
  check('selftest exits 0', out.includes('SELFTEST-EXIT=0'));

  const list1 = (out.split('==list1\n')[1] || '').split('==list2')[0];
  const row = list1.split('\n').find(l => l.endsWith('\tcairodemo')) || '';
  check('cairodemo opens a WM-placed window titled "cairodemo"', row !== '',
    JSON.stringify(list1));
  check('window is 480x360', row.includes('480x360'), row);
  check('window is RESIZABLE (R flag)', (row.split('\t')[5] || '').includes('R'), row);

  const list2 = (out.split('==list2\n')[1] || '');
  const row2 = list2.split('\n').find(l => l.endsWith('\tcairodemo')) || '';
  check('resize applied at the client ack', out.includes('resize-ok') &&
    row2.includes('600x450'), row2);
  check('all three shots written', out.includes('shot1-ok') &&
    out.includes('shot2-ok') && out.includes('shot3-ok'));
}

/* ---- session B: extract the PPMs and probe the scene ---- */
function sessionB() {
  const b = driveBoot('cat /root/c1.ppm /root/c2.ppm /root/c3.ppm\n', { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
  const buf = b.stdout;

  function parsePPM(off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  const mkpx = (p) => (x, y) => {
    const i = p.data + (y * p.w + x) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  const near = (p, r, g, bch, tol) =>
    Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - bch) <= tol;

  /* shot 1: the light scene at 480x360 — anchors mirror the selftest */
  const p1 = parsePPM(0);
  check('shot1 parses as P6 480x360', p1 !== null && p1.w === 480 && p1.h === 360,
    p1 && `${p1.w}x${p1.h}`);
  if (!p1) return;
  const px1 = mkpx(p1);
  const probe = (name, px, x, y, r, g, bch, tol) =>
    check(name, near(px(x, y), r, g, bch, tol), `(${x},${y}) = ${px(x, y)}`);

  probe('bg gradient top', px1, 240, 2, 0xef, 0xef, 0xf4, 4);
  probe('bg gradient bottom', px1, 240, 358, 0xc8, 0xc8, 0xdb, 4);
  probe('radial disc center', px1, 120, 120, 0xff, 0xdc, 0x4f, 4);
  probe('translucent star over gradient', px1, 340, 120, 0x44, 0xaf, 0x5d, 8);
  probe('bezier ribbon mid', px1, 240, 295, 0x26, 0x59, 0xe5, 12);
  let ink = false;
  for (let y = 300; y < 335 && !ink; y++)
    for (let x = 210; x < 460; x++)
      if (px1(x, y)[0] < 0x50) { ink = true; break; }
  check('cairo-ft label ink present', ink);

  /* shot 2: dark theme — bg flips dark, vector content stays */
  const p2 = parsePPM(p1.end);
  check('shot2 parses as P6 480x360', p2 !== null && p2.w === 480 && p2.h === 360,
    p2 && `${p2.w}x${p2.h}`);
  if (p2) {
    const px2 = mkpx(p2);
    probe('dark bg top', px2, 240, 2, 0x21, 0x21, 0x29, 6);
    probe('disc center unchanged in dark theme', px2, 120, 120, 0xff, 0xdc, 0x4f, 4);
  }

  /* shot 3: after resize to 600x450 (1.25x) — the VECTOR scene rescaled,
   * light theme again; scene-space anchors land at 1.25x coordinates */
  const p3 = parsePPM(p2 ? p2.end : p1.end);
  check('shot3 parses as P6 600x450', p3 !== null && p3.w === 600 && p3.h === 450,
    p3 && `${p3.w}x${p3.h}`);
  if (p3) {
    const px3 = mkpx(p3);
    probe('light bg top after two toggles', px3, 300, 3, 0xef, 0xef, 0xf4, 4);
    probe('disc center at 1.25x coords', px3, 150, 150, 0xff, 0xdc, 0x4f, 4);
    probe('star at 1.25x coords', px3, 425, 150, 0x44, 0xaf, 0x5d, 8);
  }
}

sessionA();
sessionB();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ncairo e2e: ${failures} FAILED` : '\ncairo e2e: PASS');
process.exit(failures ? 1 : 0);
