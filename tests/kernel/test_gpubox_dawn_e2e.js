#!/usr/bin/env node
// 0016 tier-1 (Dawn) suite: /bin/gpubox — an SDL window rendered with direct
// webgpu.h calls — runs windowed in the headless OS with REAL GPU output.
// host.js's lazy Dawn probe (`webgpu` npm package, a devDependency) backs the
// per-process device; present is the canvas-less tail: copyTextureToBuffer
// readback -> the surface's shm SAB, so `wmctl shot` frames are exactly what
// any CPU app would produce (todos/WM.md "Headless testing tiers", tier 1).
//
// Assertions are TOLERANCE-diff, not bit-exact goldens: GPU output is
// per-platform stable, not cross-platform identical. The expected center color
// is computed from gpubox.c's shading math (MUST MATCH its shader): pose 0
// shows the red +Z face head-on, lambert-lit by l = normalize(0.3,0.4,0.9)
// with k = 0.25 + 0.75*dot(n,l).
//
// Also proves the S3-caveat discipline: gpubox quits via SDL_Quit and the
// runtime drains pending Dawn readbacks before the EXIT handshake — a close
// that aborted the Node process (worker.terminate with pending Dawn events)
// would fail this whole file, not just a check.
//
// SKIPS cleanly (exit 0) when the webgpu package is absent — stock Node stays
// tier 0 and nothing in compiler.js/host.js/kernel.js/os/ hard-imports it.
//
// Run: node tests/kernel/test_gpubox_dawn_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

try { require.resolve('webgpu'); }
catch (e) {
  console.log('gpubox dawn e2e: SKIP (webgpu package not installed — tier 0; `pnpm add -D webgpu` for tier 1)');
  process.exit(0);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-gpubox-');

/* Expected pose-0 center color — MUST MATCH gpubox.c's shader + face colors. */
const L = [0.3, 0.4, 0.9];
const LLEN = Math.sqrt(L[0] * L[0] + L[1] * L[1] + L[2] * L[2]);
const K0 = 0.25 + 0.75 * (L[2] / LLEN);            /* n = +Z */
const CENTER0 = [0.90, 0.12, 0.12].map((c) => Math.round(255 * c * K0));
const CLEAR = [Math.round(255 * 0.08), Math.round(255 * 0.08), Math.round(255 * 0.25)];

/* ---- session A: two frozen poses, shot + graceful close each ---- */
function sessionRender() {
  const script = [
    'gpubox -f 0 &',
    'wmctl wait win gpubox',                         // window spawn (0155)
    'echo ==list1',
    'wmctl list',
    'SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $SID 1',                         // first Dawn frame presented (device+surface ready) (0155)
    'wmctl shot $SID /root/g0.png && echo shot0-ok',
    // Client resize (todos/0019): configure -> gpubox reconfigures its Dawn
    // surface + depth at 320x200 -> readback ack swaps the kernel buffer.
    'wmctl resize $SID 320 200 && echo resize-ok',
    'wmctl wait dim $SID 320x200',                   // reconfigure ack: readback swapped the kernel buffer (0155)
    'echo ==list1b',
    'wmctl list',
    'wmctl shot $SID /root/gr.png && echo shotr-ok',
    'wmctl close $SID',
    'wmctl wait nowin gpubox',                       // SDL_Quit -> Dawn drain -> exit -> window gone (0155)
    'echo ==list2',
    'wmctl list',
    'gpubox -f 45 &',
    'wmctl wait win gpubox',                         // window spawn (0155)
    'SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $SID 1',                         // first Dawn frame presented (0155)
    'wmctl shot $SID /root/g45.png && echo shot45-ok',
    'wmctl close $SID',
    'wmctl wait nowin gpubox',                       // window gone (0155)
    'echo ==list3',
    'wmctl list',
    '',
  ].join('\n');
  const a = driveBoot(script, { image });
  const out = a.stdout;
  const section = (tag) => (out.split('==' + tag + '\n')[1] || '').split('==')[0];

  check('gpubox comes up under Dawn (device + surface configured)',
    out.includes('gpubox: ready 256x256'), JSON.stringify(out.slice(0, 300)));
  const row1 = section('list1').split('\n').find((l) => l.endsWith('\tgpubox')) || '';
  check('gpubox opens a WM-placed 256x256 window', row1.includes('256x256'), row1);
  check('both poses shot to PNG', out.includes('shot0-ok') && out.includes('shot45-ok'));
  const row1b = section('list1b').split('\n').find((l) => l.endsWith('\tgpubox')) || '';
  check('wmctl resize renegotiates: window is 320x200 after the ack',
    out.includes('resize-ok') && row1b.includes('320x200'), row1b);
  check('resized pose shot to PNG', out.includes('shotr-ok'));
  // A ghost window would show as a list ROW (title column); the next launch's
  // "gpubox: ready" stdout may interleave into the section — ignore non-rows.
  const hasRow = (sec) => sec.split('\n').some((l) => l.endsWith('\tgpubox'));
  check('wmctl close quits it cleanly — no ghost window, no Dawn abort (pose 0)',
    !hasRow(section('list2')), JSON.stringify(section('list2')));
  check('...and again at pose 45', !hasRow(section('list3')));
}

/* ---- session B: extract the PNG shots byte-clean and tolerance-check ---- */
function sessionPixels() {
  const b = driveBoot('cat /root/g0.png /root/gr.png /root/g45.png\n', { image, timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: null });

  // One PNG shot out of the concatenated cat-back stream (#657);
  // null on a missing/short shot, so the callers' `if (!p)` guards hold.
  function parseShot(buf, off) {
    try { return parsePng(buf, off); } catch (e) { return null; }
  }
  const px = (shot, x, y) => {
    const i = (y * shot.w + x) * 4;
    return [shot.rgba[i], shot.rgba[i + 1], shot.rgba[i + 2]];
  };
  const near = (got, want, tol) => got.every((v, i) => Math.abs(v - want[i]) <= tol);
  const colorCount = (shot) => {
    const colors = new Set();
    for (let y = 0; y < shot.h; y += 3)
      for (let x = 0; x < shot.w; x += 3) {
        const p = px(shot, x, y);
        colors.add((p[0] << 16) | (p[1] << 8) | p[2]);
      }
    return colors;
  };

  const g0 = parseShot(b.stdout, 0);
  check('pose-0 shot parses as PNG at full client size 256x256',
    g0 !== null && g0.w === 256 && g0.h === 256, g0 && `${g0.w}x${g0.h}`);
  if (!g0) return;
  const c0 = px(b.stdout, g0, 128, 128);
  check(`pose-0 center is the lit red +Z face (~${CENTER0}, tol 30)`,
    near(c0, CENTER0, 30), c0.join(','));
  check('pose-0 corners are the clear color (' + CLEAR + ', tol 12)',
    near(px(b.stdout, g0, 4, 4), CLEAR, 12) && near(px(b.stdout, g0, 251, 251), CLEAR, 12),
    px(b.stdout, g0, 4, 4).join(','));

  const gr = parseShot(b.stdout, g0.next);
  check('resized shot parses as PNG at the NEW client size 320x200',
    gr !== null && gr.w === 320 && gr.h === 200, gr && `${gr.w}x${gr.h}`);
  if (!gr) return;
  check('resized center is still the lit red +Z face (re-rendered, not scaled)',
    near(px(b.stdout, gr, 160, 100), CENTER0, 30), px(b.stdout, gr, 160, 100).join(','));
  check('resized corners are the clear color (depth/color targets match)',
    near(px(b.stdout, gr, 4, 4), CLEAR, 12) && near(px(b.stdout, gr, 315, 195), CLEAR, 12),
    px(b.stdout, gr, 315, 195).join(','));

  const g45 = parseShot(b.stdout, gr.next);
  check('pose-45 shot parses as PNG 256x256',
    g45 !== null && g45.w === 256 && g45.h === 256, g45 && `${g45.w}x${g45.h}`);
  if (!g45) return;
  const colors45 = colorCount(g45);
  check('pose-45 shows a rotated cube (>=3 flat-lit colors: faces + clear)',
    colors45.size >= 3, colors45.size + ' distinct colors');
  const c45 = px(b.stdout, g45, 128, 128);
  check('poses differ (the rotation actually rotated)',
    !near(c45, c0, 20), `center ${c45} vs ${c0}`);
}

sessionRender();
sessionPixels();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ngpubox dawn e2e: ${failures} FAILED` : '\ngpubox dawn e2e: PASS');
process.exit(failures ? 1 : 0);
