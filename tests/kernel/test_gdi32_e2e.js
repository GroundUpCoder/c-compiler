#!/usr/bin/env node
// 0057 acceptance, headless: the win32 gdi32 drawing subset (os/win32/,
// design todos/WIN32.md) renders a Petzold-style WM_PAINT scene into an shm
// surface, bit-exact, through os/boot.js. Covers:
//   - `gdidemo selftest`: memory-DC GDI semantics in-OS (right/bottom
//     exclusivity, LineTo endpoint exclusion, ROP2 XOR, clip, BitBlt overlap
//     staging, StretchBlt NN, PatBlt, DIB B<->R swizzle + bottom-up, text
//     extents/metrics, object rules) + the leak check (repeated paint
//     cycles return __gdi_object_count/__gdi_dc_count to baseline).
//   - windowed `gdidemo`: WM placement + title, fixed size (no R flag),
//     and a `wmctl shot` frame probed against the scene's exact geometry
//     (coordinates mirror os/win32/gdidemo.c draw_scene — change together).
//   - bit-exactness: two shots a second apart (the app repaints every
//     frame) are byte-identical — the CPU rasterizer is deterministic.
//
// Run: node tests/kernel/test_gdi32_e2e.js
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

const { dir: tmp, image } = freshImage('os-gdi32-');

/* ---- session A: selftest, then the windowed scene + two shots ---- */
function sessionA() {
  const script = [
    'gdidemo selftest',
    'echo SELFTEST-EXIT=$?',
    'gdidemo &',
    'sleep 4',                                       // wasm boot + freetype + paint
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "GDI Demo$" | sed "s/[^0-9].*//")',
    'wmctl shot $SID /root/gdi1.ppm && echo shot1-ok',
    'sleep 1',                                       // more frames presented
    'wmctl shot $SID /root/gdi2.ppm && echo shot2-ok',
    '',
  ].join('\n');

  const a = driveBoot(script, { image });
  const out = a.stdout;

  check('selftest passes in-OS', /SELFTEST: \d+\/\d+ PASS/.test(out),
    (out.match(/FAIL [^\n]*/g) || []).join('; ') || out.slice(0, 300));
  check('selftest exits 0', out.includes('SELFTEST-EXIT=0'));
  check('selftest has no failing checks', !/\nFAIL /.test(out));

  const list1 = (out.split('==list1\n')[1] || '');
  const row = list1.split('\n').find(l => l.endsWith('\tGDI Demo')) || '';
  check('gdidemo opens a WM-placed window titled "GDI Demo"', row !== '',
    JSON.stringify(list1));
  check('gdidemo window is 480x360', row.includes('480x360'), row);
  check('gdidemo is fixed-size (no R flag — scaled, not configured)',
    !(row.split('\t')[5] || '').includes('R'), row);
  check('painted marker reached stdout', out.includes('gdidemo: painted'));
  check('both shots written', out.includes('shot1-ok') && out.includes('shot2-ok'));
}

/* ---- session B: extract the PPMs and probe the scene ---- */
function sessionB() {
  const b = driveBoot('cat /root/gdi1.ppm /root/gdi2.ppm\n',
    { image, encoding: null, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const buf = b.stdout;

  function parsePPM(off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  const p1 = parsePPM(0);
  check('shot parses as P6 at full client size 480x360',
    p1 !== null && p1.w === 480 && p1.h === 360, p1 && `${p1.w}x${p1.h}`);
  if (!p1) return;

  const px = (x, y) => {
    const i = p1.data + (y * p1.w + x) * 3;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  const eq = (p, r, g, bch) => p[0] === r && p[1] === g && p[2] === bch;
  const probe = (name, x, y, r, g, bch) =>
    check(name, eq(px(x, y), r, g, bch), `(${x},${y}) = ${px(x, y)}`);

  /* Row 1: shapes (coordinates from draw_scene) */
  probe('Rectangle interior red', 80, 60, 220, 40, 40);
  probe('Rectangle border black (3px pen)', 20, 60, 0, 0, 0);
  probe('Rectangle right edge exclusive (white past the pen)', 145, 60, 255, 255, 255);
  probe('Ellipse interior blue', 220, 60, 40, 80, 220);
  probe('Ellipse bbox corner untouched', 165, 25, 255, 255, 255);
  probe('RoundRect interior green', 370, 60, 40, 180, 90);
  probe('RoundRect corner rounded off', 302, 22, 255, 255, 255);

  /* Row 2: polygon, hatch, thick lines */
  probe('Polygon interior yellow', 80, 197, 250, 200, 40);
  probe('Polygon outside untouched', 30, 140, 255, 255, 255);
  let hatchInk = false, hatchGap = false;
  for (let y = 135; y < 225; y++)
    for (let x = 165; x < 275; x++) {
      const p = px(x, y);
      if (eq(p, 150, 40, 150)) hatchInk = true;
      else if (eq(p, 255, 255, 255)) hatchGap = true;
      if (hatchInk && hatchGap) break;
    }
  check('HS_DIAGCROSS hatch has purple lines and white (OPAQUE bk) gaps',
    hatchInk && hatchGap, `ink=${hatchInk} gap=${hatchGap}`);
  probe('thick-pen X crossing', 370, 180, 180, 30, 30);

  /* Row 3: text */
  let ink1 = false;
  for (let y = 245; y < 270 && !ink1; y++)
    for (let x = 20; x < 140; x++)
      if (!eq(px(x, y), 255, 255, 255)) { ink1 = true; break; }
  check('TextOut "Hello, GDI!" left ink', ink1);
  let bkYellow = false, blueInk = false;
  for (let y = 275; y < 296; y++)
    for (let x = 20; x < 90; x++) {
      const p = px(x, y);
      if (eq(p, 255, 255, 0)) bkYellow = true;
      else if (!eq(p, 255, 255, 255)) blueInk = true;
    }
  check('OPAQUE TextOut fills the cell yellow with ink over it',
    bkYellow && blueInk, `bk=${bkYellow} ink=${blueInk}`);
  let ink3 = false;
  for (let y = 245; y < 300 && !ink3; y++)
    for (let x = 300; x < 460; x++)
      if (!eq(px(x, y), 255, 255, 255)) { ink3 = true; break; }
  check('DrawText centered ink present', ink3);

  /* Row 4: blits (checker quadrants are 20px, BitBlt at (20,310), 2x
   * horizontal StretchBlt at (80,310)) */
  probe('BitBlt checker top-left blue', 30, 320, 0, 120, 215);
  probe('BitBlt checker top-right white', 50, 320, 255, 255, 255);
  probe('BitBlt checker bottom-left white', 30, 340, 255, 255, 255);
  probe('BitBlt checker bottom-right blue', 50, 340, 0, 120, 215);
  probe('StretchBlt 2x top-left blue', 90, 320, 0, 120, 215);
  probe('StretchBlt 2x top-right white', 130, 320, 255, 255, 255);
  probe('StretchBlt 2x bottom-right blue', 130, 340, 0, 120, 215);

  /* Bit-exactness: two shots of the repainted scene are byte-identical. */
  const p2 = parsePPM(p1.end);
  check('second shot parses at 480x360',
    p2 !== null && p2.w === 480 && p2.h === 360, p2 && `${p2.w}x${p2.h}`);
  if (p2) {
    check('repeated paints are bit-exact (shot1 == shot2)',
      buf.subarray(p1.data, p1.end).equals(buf.subarray(p2.data, p2.end)));
  }
}

sessionA();
sessionB();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ngdi32 e2e: ${failures} FAILED` : '\ngdi32 e2e: PASS');
process.exit(failures ? 1 : 0);
