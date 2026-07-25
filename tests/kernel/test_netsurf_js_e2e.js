#!/usr/bin/env node
// NetSurf JavaScript, IN THE OS (todos/NETSURF-JS.md Lane A).  The monkey
// gate (vendor/netsurf/smoke-js.mjs) proves the engine and the shared core;
// this proves the three things that are the gucOS FRONTEND's own and that
// monkey cannot speak for:
//
//   - `enable_javascript` is ON BY DEFAULT.  No flag, no Choices file: a
//     plain `netsurf page.html` runs the page's scripts.
//   - the frontend's scheduler + invalidate -> damage -> blit path really
//     repaints content-driven changes with NO user input: sketch.html's
//     setInterval rasterises into a canvas via putImageData and the window
//     keeps changing on its own.
//   - a real SDL pointer click reaches a DOM click listener and its
//     putImageData write repaints (the frontend's input map -> core
//     interaction.c -> dukky -> canvas -> damage round trip).
//
// ...and then that the admin off-switch still works: with
// `enable_javascript:0` in ${HOME}/.netsurf/Choices (the FIRST entry on the
// frontend's resource search path) the same page paints nothing at all.
//
// Pixel probes are colour COUNTS over the whole content area, never fixed
// coordinates: the canvas patterns are saturated, everything else on these
// pages is white/black, so "how many strongly-coloured pixels" is a robust
// JS-ran signal that no font or layout change can shift.  The one clicked
// coordinate (200,60) is the squares.html convention from
// test_netsurf_e2e.js — the gucOS window has no top chrome, so client
// coords are content coords.
//
// Run: node tests/kernel/test_netsurf_js_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* must match gucos/gui.c STATUS_H */
const STATUS_H = 18;

/* ---- seed boot, then plant the pages ---- */
const { dir: tmp, image } = freshImage('os-nsjs-');
driveBoot('true', { image });

/* A click target with known geometry (the squares.html shape: a sized block
 * with margin:0 body) whose DOM click listener paints a canvas green.  Green
 * appearing is the whole assertion: click -> JS -> putImageData -> repaint. */
const CLICK_PAGE = `<html>
<head><title>JsClick</title></head>
<body style="margin: 0; background: #ffffff">
<div id="hit" style="width: 400px; height: 120px; background: #0000ff"></div>
<canvas id="c" width="200" height="100"></canvas>
<script>
var ctx = document.getElementById('c').getContext('2d');
var img = ctx.createImageData(200, 100);
document.getElementById('hit').addEventListener('click', function () {
	var d = img.data, i;
	for (i = 0; i < d.length; i += 4) {
		d[i] = 0; d[i + 1] = 200; d[i + 2] = 0; d[i + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
});
</script>
</body></html>
`;

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  const put = (dst, bytes) => {
    const fd = rfs.open(dst, W, 0o644);
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  };
  put('/root/sketch.html',
      fs.readFileSync(path.join(ROOT, 'vendor', 'netsurf', 'demos', 'sketch.html')));
  put('/root/jsclick.html', Buffer.from(CLICK_PAGE, 'utf-8'));
  rootStore.flush();
  rootStore.close();
}

/* PPM helpers (the netsurf-e2e pattern) */
function parsePPMs(buf, names) {
  const shots = {};
  let off = 0;
  for (const name of names) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) throw new Error('bad ppm stream at ' + name + ': ' + JSON.stringify(head));
    const w = +m[1], h = +m[2];
    const data = off + m[0].length;
    shots[name] = { w, h, data: buf.slice(data, data + w * h * 3) };
    off = data + w * h * 3;
  }
  return shots;
}
const px = (s, x, y) => [s.data[(y * s.w + x) * 3],
                         s.data[(y * s.w + x) * 3 + 1],
                         s.data[(y * s.w + x) * 3 + 2]];
/* strongly coloured = a wide channel spread; white/grey/black chrome and text
 * antialiasing never qualify, so this counts "pixels only a script drew" */
const isColour = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) > 60;
const isGreenish = (p) => p[1] > 140 && p[0] < 90 && p[2] < 90;
function countContent(s, pred) {
  let n = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
function contentDiffers(a, b) {
  if (a.w !== b.w || a.h !== b.h) return true;
  let n = 0;
  for (let y = 0; y < a.h - STATUS_H; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 3;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]) n++;
    }
  }
  return n;
}

/* Post-title-barrier settle: shot until two consecutive frames match.  Only
 * for pages that DO settle — an animating page would burn the whole clock
 * here, so the animation leg uses pollChange instead. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];
/* Repaints with no wmctl-visible marker: poll PIXELS until the frame differs
 * from the reference (bounded condition poll, not a fixed sleep). */
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${ref} || break; sleep 0.1; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* ---- session A: default-on, animation, click, then the off-switch ---- */
const out = driveBoot([
  /* --- JS on by default: no flag, no Choices --- */
  '[ -e /root/.netsurf/Choices ] && echo UNEXPECTED-CHOICES',
  'netsurf /root/sketch.html &',
  'wmctl wait win Sketch 30000',
  sidOf('SK', 'Sketch'),
  'wmctl shot $SK /root/j1.ppm && echo shot-j1-ok',
  /* the page animates itself: the next differing frame IS the marker that
   * the timer fired and putImageData repainted, with no input whatsoever */
  ...pollChange('$SK', '/root/j1.ppm'),
  'wmctl shot $SK /root/j2.ppm && echo shot-j2-ok',
  'wmctl close $SK && wmctl wait nowin Sketch 8000 && echo sketch-closed',

  /* --- a real pointer click reaching a DOM listener --- */
  'netsurf /root/jsclick.html &',
  'wmctl wait win JsClick 30000',
  sidOf('CK', 'JsClick'),
  ...pollStable('$CK', '/root/k1.ppm'),
  'echo shot-k1-ok',
  'wmctl click $CK 200 60',
  ...pollChange('$CK', '/root/k1.ppm'),
  'wmctl shot $CK /root/k2.ppm && echo shot-k2-ok',
  'wmctl close $CK && wmctl wait nowin JsClick 8000 && echo click-closed',

  /* --- the admin off-switch, in the real product --- */
  'mkdir -p /root/.netsurf',
  'echo enable_javascript:0 > /root/.netsurf/Choices',
  'cat /root/.netsurf/Choices',
  'netsurf /root/sketch.html &',
  'wmctl wait win Sketch 30000',
  sidOf('OF', 'Sketch'),
  ...pollStable('$OF', '/root/o1.ppm'),
  'echo shot-o1-ok',
  'wmctl close $OF && wmctl wait nowin Sketch 8000 && echo off-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

check('no stray Choices file in the fixture', !out.includes('UNEXPECTED-CHOICES'));
for (const tag of ['j1', 'j2', 'k1', 'k2', 'o1']) {
  check(`shot ${tag} taken`, out.includes(`shot-${tag}-ok`));
}
check('the Choices off-switch was written', out.includes('enable_javascript:0'));
for (const tag of ['sketch', 'click', 'off']) {
  check(`${tag} window closed`, out.includes(`${tag}-closed`));
}

/* ---- session B: read the shots back ---- */
const NAMES = ['j1', 'j2', 'k1', 'k2', 'o1'];
const back = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.ppm`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 128 * 1024 * 1024 });
const shots = parsePPMs(back.stdout, NAMES);

/* --- JS on by default + canvas painted --- */
const j1c = countContent(shots.j1, isColour);
const j2c = countContent(shots.j2, isColour);
check('JS runs by DEFAULT: sketch.html painted its canvas', j1c > 4000,
      `coloured pixels in the first frame: ${j1c} (canvas is 128x96 = 12288)`);
/* the animation advanced on its own — no input was sent between j1 and j2 */
const moved = contentDiffers(shots.j1, shots.j2);
check('content-driven repaint with ZERO input: the frame changed on a timer',
      moved > 500, `pixels changed between the two frames: ${moved}`);
check('the canvas is still painted after the tick', j2c > 4000, `coloured: ${j2c}`);

/* --- click -> DOM listener -> putImageData -> repaint --- */
const k1g = countContent(shots.k1, isGreenish);
const k2g = countContent(shots.k2, isGreenish);
check('nothing green before the click', k1g < 200, `green pixels: ${k1g}`);
check('a real pointer click reached the DOM listener and repainted the canvas',
      k2g > 15000, `green pixels after the click: ${k2g} (canvas is 200x100 = 20000)`);

/* --- the off-switch --- */
const o1c = countContent(shots.o1, isColour);
check('Choices enable_javascript:0 keeps the scripts from running',
      o1c < 200, `coloured pixels with JS off: ${o1c} (was ${j1c} with JS on)`);

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf-js e2e checks passed');
