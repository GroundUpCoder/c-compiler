#!/usr/bin/env node
// 0057 acceptance, headless: the win32 gdi32 drawing subset (os/win32/,
// design todos/WIN32.md) renders a Petzold-style WM_PAINT scene into an shm
// surface, bit-exact, through os/boot.js. Covers:
//   - `gdidemo selftest`: memory-DC GDI semantics in-OS (right/bottom
//     exclusivity, LineTo endpoint exclusion, ROP2 XOR, clip, BitBlt overlap
//     staging, StretchBlt NN, PatBlt, DIB B<->R swizzle + bottom-up, text
//     extents/metrics, object rules) + the leak check (repeated paint
//     cycles return __gdi_object_count/__gdi_dc_count to baseline).
//   - windowed `gdidemo`: WM placement + title, resizable (R flag, #278),
//     and a `wmctl shot` frame probed against the scene's exact geometry
//     (coordinates mirror os/win32/gdidemo.c draw_scene — change together).
//   - resize (#278): `wmctl resize` + maximize/restore re-RENDER the scene
//     at the live client size (the shot parses at the NEW dims — a
//     SET_DST-scaled fixed-size surface never does, its buffer stays put);
//     scaled-geometry probes pin the design-grid re-derivation.
//   - bit-exactness: shots of two INDEPENDENT boots' paints are
//     byte-identical — the CPU rasterizer is deterministic.
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

/* ---- session A: selftest, then the windowed scene + a shot ---- */
function sessionA() {
  const script = [
    // stderr via file + cat, the user32-e2e pattern: app stderr does not
    // reliably interleave into the piped tty stream (#318 pin needs it)
    'gdidemo selftest 2>/tmp/st.err',
    'echo SELFTEST-EXIT=$?',
    'cat /tmp/st.err',
    // windowed stderr to its OWN file (never /tmp/st.err — the selftest leg
    // deliberately emits a win32: report and the #318 pin asserts it)
    'gdidemo 2>/tmp/win.err &',
    // Boot barrier (todos/0154): wait for the window to be listed, then for a
    // presented frame (seq>=1) so the shot captures a painted scene, not a blank
    // surface — replaces the `sleep 4` guess at wasm boot + freetype + first paint.
    'wmctl wait win "GDI Demo" 10000',
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "GDI Demo$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $SID 1 6000',
    'wmctl shot $SID /root/gdi1.ppm && echo shot1-ok',
    // ---- #278 resize legs. WS_THICKFRAME makes this a REAL kernel resize
    // (SURFACE_RESIZE -> WM_SIZE -> invalidate -> re-render at the new
    // client size), not a SET_DST bitmap scale — the shots below parse at
    // the NEW dims, which a scaled fixed-size buffer never does.
    'wmctl resize $SID 640 480 && echo resize-ok',
    'wmctl wait dim $SID 640x480',
    'sleep 1',       // timing subject: post-resize re-render present (the cairo idiom)
    'wmctl shot $SID /root/gdi3.ppm && echo shot3-ok',
    // maximize: wm.c MOVE+RESIZEs a resizable window to the work area
    // (screen-derived — no fixed dim to wait on; annotated settle).
    'wmctl max $SID && echo max-ok',
    'sleep 1.2',     // timing subject: maximize MOVE+RESIZE + re-render present
    'echo ==maxlist',
    'wmctl list',
    'echo ==cut',
    'wmctl shot $SID /root/gdi4.ppm && echo shot4-ok',
    // restore: the toggle returns to the saved floating rect — a REAL wait
    // target (driveBoot fails loud on a wait timeout).
    'wmctl max $SID',
    'wmctl wait dim $SID 640x480',
    'echo ==winerr-begin',
    'cat /tmp/win.err',
    'echo ==winerr-end',
    '',
  ].join('\n');

  const a = driveBoot(script, { image });
  const out = a.stdout;

  check('selftest passes in-OS', /SELFTEST: \d+\/\d+ PASS/.test(out),
    (out.match(/FAIL [^\n]*/g) || []).join('; ') || out.slice(0, 300));
  check('selftest exits 0', out.includes('SELFTEST-EXIT=0'));
  check('selftest has no failing checks', !/\nFAIL /.test(out));
  check('fail-loud: refused SetMapMode says so on stderr (#318)',
    /win32: unsupported SetMapMode\(2\) \(MM_TEXT only\)/.test(out),
    (out.match(/win32: unsupported [^\n]*/g) || []).join(' | '));

  const list1 = (out.split('==list1\n')[1] || '');
  const row = list1.split('\n').find(l => l.endsWith('\tGDI Demo')) || '';
  check('gdidemo opens a WM-placed window titled "GDI Demo"', row !== '',
    JSON.stringify(list1));
  check('gdidemo window is 480x360', row.includes('480x360'), row);
  check('gdidemo is resizable (R flag — #278 resize sweep)',
    (row.split('\t')[5] || '').includes('R'), row);
  check('painted marker reached stdout', out.includes('gdidemo: painted'));
  check('first shot written', out.includes('shot1-ok'));

  /* #278: the resize legs' shell-level acks */
  check('wmctl resize accepted (resizable surface)', out.includes('resize-ok'));
  check('resized shot written', out.includes('shot3-ok'));
  check('wmctl max accepted', out.includes('max-ok'));
  check('maximized shot written', out.includes('shot4-ok'));
  const maxlist = (out.split('==maxlist\n')[1] || '').split('==cut')[0];
  const maxRow = maxlist.split('\n').find(l => l.endsWith('\tGDI Demo')) || '';
  const maxDim = maxRow.split('\t')[2] ? maxRow.split('\t')[2].match(/^(\d+)x(\d+)\+/) : null;
  check('maximize grew the window past 640x480 (work-area resize, not scale)',
    maxDim !== null && (+maxDim[1] > 640 || +maxDim[2] > 480), maxRow);

  // #342: the windowed scene keeps 0211 leak discipline — its stderr is
  // EMPTY (pen5 was deleted while selected: refused + leaked). Scoped to
  // /tmp/win.err only; the selftest leg's win32: report is pinned above.
  // Since #278 the scene also re-rendered through resize/maximize/restore
  // above, so this now asserts the RESIZE paths stay report-free too.
  const winErr = ((out.split('==winerr-begin\n')[1] || '').split('==winerr-end')[0]).trim();
  check('windowed gdidemo stderr is clean — zero win32 reports (#342)',
    winErr === '', JSON.stringify(winErr));

  return maxDim ? { w: +maxDim[1], h: +maxDim[2] } : null;
}

/* ---- session A2: a SECOND boot paints the scene again for the determinism
 * shot. gdidemo paints once per instance (WM_PAINT when the queue is dry,
 * nothing ever re-invalidates it), so an in-boot `wait seq $SID 2` was a dead
 * wait and a same-boot second shot just re-read the SAME present. A fresh boot
 * is a genuinely independent paint — a STRONGER bit-exactness claim. ---- */
function sessionA2() {
  const out = driveBoot([
    'gdidemo &',
    'wmctl wait win "GDI Demo" 10000',
    'SID=$(wmctl list | grep "GDI Demo$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $SID 1 6000',
    'wmctl shot $SID /root/gdi2.ppm && echo shot2-ok',
    '',
  ].join('\n'), { image }).stdout;
  check('second boot shot written', out.includes('shot2-ok'));
}

/* ---- session B: extract the PPMs and probe the scene ---- */
function sessionB(maxDims) {
  const b = driveBoot('cat /root/gdi1.ppm /root/gdi2.ppm /root/gdi3.ppm /root/gdi4.ppm\n',
    { image, encoding: null, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
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

  /* Bit-exactness: two independent boots' paints are byte-identical. */
  const p2 = parsePPM(p1.end);
  check('second shot parses at 480x360',
    p2 !== null && p2.w === 480 && p2.h === 360, p2 && `${p2.w}x${p2.h}`);
  if (p2) {
    check('independent boots paint bit-exact (shot1 == shot2)',
      buf.subarray(p1.data, p1.end).equals(buf.subarray(p2.data, p2.end)));
  }

  /* ---- #278: the resized shots re-RENDER the 480x360 design grid at the
   * live client size. Probes mirror draw_scene's SX/SY = MulDiv(v, cw|ch,
   * 480|360) scaling; all points sit >=5px inside their region so +/-1
   * rounding can never flip them. */
  if (!p2) return;
  const p3 = parsePPM(p2.end);
  check('resized shot parses at the NEW client size 640x480 (re-render, not scale)',
    p3 !== null && p3.w === 640 && p3.h === 480, p3 && `${p3.w}x${p3.h}`);
  if (p3) {
    const px3 = (x, y) => {
      const i = p3.data + (y * p3.w + x) * 3;
      return [buf[i], buf[i + 1], buf[i + 2]];
    };
    const probe3 = (name, x, y, r, g, bch) =>
      check(name, eq(px3(x, y), r, g, bch), `(${x},${y}) = ${px3(x, y)}`);
    /* design (80,60) -> (107,80); (220,60) -> (293,80); (370,60) -> (493,80) */
    probe3('640x480: Rectangle interior red at scaled position', 107, 80, 220, 40, 40);
    probe3('640x480: Ellipse interior blue at scaled position', 293, 80, 40, 80, 220);
    probe3('640x480: RoundRect interior green at scaled position', 493, 80, 40, 180, 90);
    probe3('640x480: Polygon interior yellow at scaled position', 107, 267, 250, 200, 40);
    probe3('640x480: background right of the scene stays white', 620, 20, 255, 255, 255);
    /* the 1:1 BitBlt checker stays UNSCALED 40x40 at the scaled position
     * (design (20,310) -> (27,413); quadrants stay 20px) — the unit-blit
     * half of the demo re-renders, it does not stretch */
    probe3('640x480: 1:1 checker top-left blue (unscaled quadrants)', 37, 423, 0, 120, 215);
    probe3('640x480: 1:1 checker top-right white', 57, 423, 255, 255, 255);
    probe3('640x480: 1:1 checker bottom-right blue', 57, 443, 0, 120, 215);
    /* the StretchBlt half scales with the grid: dest (107,413) 106x54 */
    probe3('640x480: StretchBlt dest top-left blue', 127, 423, 0, 120, 215);
    probe3('640x480: StretchBlt dest top-right white', 190, 423, 255, 255, 255);
    probe3('640x480: StretchBlt dest bottom-right blue', 190, 455, 0, 120, 215);
  }

  /* maximized shot: dims must equal the wmctl list row's, content at the
   * work-area scale (screen-derived — computed, not hardcoded) */
  const p4 = p3 ? parsePPM(p3.end) : null;
  check('maximized shot parses at the work-area size from wmctl list',
    p4 !== null && maxDims !== null && p4.w === maxDims.w && p4.h === maxDims.h,
    (p4 && `${p4.w}x${p4.h}`) + ' vs ' + JSON.stringify(maxDims));
  if (p4 && maxDims) {
    const px4 = (x, y) => {
      const i = p4.data + (y * p4.w + x) * 3;
      return [buf[i], buf[i + 1], buf[i + 2]];
    };
    const mx = (v) => Math.round(v * maxDims.w / 480);
    const my = (v) => Math.round(v * maxDims.h / 360);
    check('maximized: Rectangle interior red at scaled position',
      eq(px4(mx(80), my(60)), 220, 40, 40), `${px4(mx(80), my(60))}`);
    check('maximized: Ellipse interior blue at scaled position',
      eq(px4(mx(220), my(60)), 40, 80, 220), `${px4(mx(220), my(60))}`);
  }
}

const maxDims = sessionA();
sessionA2();
sessionB(maxDims);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ngdi32 e2e: ${failures} FAILED` : '\ngdi32 e2e: PASS');
process.exit(failures ? 1 : 0);
