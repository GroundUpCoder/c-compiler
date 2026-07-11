#!/usr/bin/env node
// 0095 acceptance, headless: Aero Snap through the REAL /bin/wm + /bin/wmctl
// via os/boot.js. Covers: drag-to-edge tiling (wmctl sdown/smove/sup — the
// new screen-coordinate injection through the kernel's full hit-test/chrome
// path), the translucent snap preview mid-drag (window record + exact 0063
// src-over pixels out of `wmctl shot screen`), drag-off restore (floating
// SIZE back at the drop point), corner quarters, the wmctl-snap command path
// (= the Win+arrow chord event: halves, wrap-across, maximize, restore,
// minimize), the fixed-size letterbox branch (aspect-fit SET_DST centered in
// the half), and the crashed-WM story (snap refused — snap IS policy — while
// plain drags keep working).
//
// Geometry on the 1024x768 headless screen (wm.c metrics): work area =
// 1024 x 712 at y 28 (BAR_H 28, TITLE_H 28); halves 512x712; quarters
// 512x342 (top y 28, bottom y 398 — the bottom row's own title bar fits).
//
// Run: node tests/kernel/test_snap_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-snap-'));
const image = path.join(tmp, 'os.img');

// Preview pixels (todos/0063 deterministic src-over, integer math): white
// fill a=80 over the teal desktop -> (80,168,168); the 2px border a=192 ->
// (192,224,224). PPM header on 1024x768 is 16 bytes; tail -c is 1-based.
const ppmOff = (x, y) => 17 + (y * 1024 + x) * 3;

const script = [
  'winbox &',
  'sleep 2.5',                                   // wasm instantiation is real time
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'echo ==base',
  'wmctl list',
  // ---- drag-to-edge (the 0095 acceptance gesture): grab the title at
  // (100,26) — the window sits at 12,36, title band y 12..36 — and park
  // the pointer INSIDE the left edge zone before releasing.
  'wmctl sdown 100 26',
  'wmctl smove 400 300',                         // mid-screen: no zone yet
  'wmctl smove 4 300',                           // left zone -> preview up
  'sleep 0.7',
  'echo ==mid',
  'wmctl list',
  'wmctl shot screen /root/mid.ppm && echo mid-shot-ok',
  'wmctl sup 4 300',                             // drop -> snap left
  'sleep 1',
  'echo ==left',
  'wmctl list',
  // The preview pixels, read from the mid-drag shot: fill well inside the
  // left half but clear of the dragged window; border at x=1.
  `tail -c +${ppmOff(450, 150)} /root/mid.ppm | head -c 3 > /root/p1.bin`,
  "printf '\\120\\250\\250' > /root/e1.bin",     // 80,168,168
  'cmp /root/p1.bin /root/e1.bin && echo prev-fill-ok',
  `tail -c +${ppmOff(1, 150)} /root/mid.ppm | head -c 3 > /root/p2.bin`,
  "printf '\\300\\340\\340' > /root/e2.bin",     // 192,224,224
  'cmp /root/p2.bin /root/e2.bin && echo prev-border-ok',
  // ---- drag-off: dragging the snapped window away restores its floating
  // SIZE at the drop point (down on the snapped title: y 4..28).
  'wmctl sdrag 256 14 500 300',
  'sleep 1',
  'echo ==dragoff',
  'wmctl list',
  // ---- corner drag -> top-left quarter (title now spans y 290..314).
  'wmctl sdown 300 306',
  'wmctl smove 3 3',
  'sleep 0.3',
  'wmctl sup 3 3',
  'sleep 1',
  'echo ==quarter',
  'wmctl list',
  // ---- the command path (= the Win+arrow chord event, todos/0095).
  'wmctl snap right && echo snap-right-ok',
  'sleep 1',
  'echo ==right',
  'wmctl list',
  'wmctl snap right',                            // toward its own edge: wrap
  'sleep 1',
  'echo ==wrap',
  'wmctl list',
  'wmctl snap up',                               // maximize (the 0025 state)
  'sleep 1',
  'echo ==max',
  'wmctl list',
  'wmctl snap down',                             // restore the floating rect
  'sleep 1',
  'echo ==floatback',
  'wmctl list',
  'wmctl snap down',                             // floating: minimize
  'sleep 0.5',
  'echo ==min',
  'wmctl list',
  'wmctl restore $WSID',
  'sleep 0.5',
  // ---- fixed-size branch: letterbox into the half (aspect-fit SET_DST,
  // centered — the maximize dispatch exactly).
  'winbox fixed &',
  'sleep 2.5',
  'FSID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")',
  'wmctl focus $FSID',
  'sleep 0.3',
  'wmctl snap left',
  'sleep 0.7',
  'echo ==fixleft',
  'wmctl list',
  'wmctl snap down',
  'sleep 0.7',
  'echo ==fixrestore',
  'wmctl list',
  // ---- crashed-WM story: snap IS policy; plain drags stay kernel-chrome.
  'WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")',
  'kill $WMPID',
  'sleep 0.5',
  'wmctl snap left || echo snap-refused',
  'wmctl sdrag 300 306 4 300',                   // winbox title at y 290..314
  'sleep 0.5',
  'echo ==nowm',
  'wmctl list',
  '',
].join('\n');

const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
  { input: script, encoding: 'utf8', timeout: 300000 });
if (r.error) throw r.error;

const out = r.stdout;
function section(name) {
  const m = out.split('==' + name + '\n');
  return m.length > 1 ? m[1].split('==')[0] : '';
}
const row = (sec, title) =>
  sec.split('\n').find(l => l.endsWith('\t' + title)) || '';
const geom = (line) => line.split('\t')[2] || '';   // the GEOMETRY column
const dst = (line) => line.split('\t')[3] || '';    // the DST column
const flags = (line) => line.split('\t')[5] || '';

// ---- baseline ----
check('winbox placed by the WM (240x160+12+36)',
  geom(row(section('base'), 'winbox')) === '240x160+12+36',
  row(section('base'), 'winbox'));

// ---- mid-drag: the translucent preview over the left half ----
{
  const mid = section('mid');
  const prev = row(mid, 'snappreview');
  check('mid-drag: snappreview window covers the left half + title band (512x740+0+0)',
    geom(prev) === '512x740+0+0', JSON.stringify(mid));
  check('preview is borderless + per-pixel alpha + top layer (b, A, T flags)',
    flags(prev).includes('b') && flags(prev).includes('A') && flags(prev).includes('T'),
    prev);
  check('the dragged window keeps focus (preview hand-back)',
    flags(row(mid, 'winbox'))[0] === 'f', row(mid, 'winbox'));
  check('mid-drag screen shot written', out.includes('mid-shot-ok'));
  check('preview fill blends the exact 0063 src-over (80,168,168 over teal)',
    out.includes('prev-fill-ok'));
  check('preview border blends the exact src-over (192,224,224)',
    out.includes('prev-border-ok'));
}

// ---- the drop: left half; preview gone ----
{
  const left = section('left');
  check('drop on the left edge snaps to the left half (512x712+0+28)',
    geom(row(left, 'winbox')) === '512x712+0+28', row(left, 'winbox'));
  check('the preview is gone at the drop', row(left, 'snappreview') === '',
    JSON.stringify(left));
}

// ---- drag-off restore ----
check('dragging the snapped window off restores its floating size at the drop (240x160+244+314)',
  geom(row(section('dragoff'), 'winbox')) === '240x160+244+314',
  row(section('dragoff'), 'winbox'));

// ---- corner quarter ----
check('corner drop snaps to the top-left quarter (512x342+0+28)',
  geom(row(section('quarter'), 'winbox')) === '512x342+0+28',
  row(section('quarter'), 'winbox'));

// ---- the command path (= Win+arrow) ----
check('wmctl snap right accepted', out.includes('snap-right-ok'));
check('snap right: the right half (512x712+512+28)',
  geom(row(section('right'), 'winbox')) === '512x712+512+28',
  row(section('right'), 'winbox'));
check('snap right again wraps across to the left half',
  geom(row(section('wrap'), 'winbox')) === '512x712+0+28',
  row(section('wrap'), 'winbox'));
check('snap up maximizes to the work area (1024x712+0+28)',
  geom(row(section('max'), 'winbox')) === '1024x712+0+28',
  row(section('max'), 'winbox'));
check('snap down restores the floating rect saved at the FIRST snap-out (240x160+244+314)',
  geom(row(section('floatback'), 'winbox')) === '240x160+244+314',
  row(section('floatback'), 'winbox'));
check('snap down on a floating window minimizes it',
  flags(row(section('min'), 'winbox')).includes('m'),
  row(section('min'), 'winbox'));

// ---- fixed-size branch: letterboxed halves ----
{
  const fx = row(section('fixleft'), 'fixbox');
  check('fixed-size snap left: buffer untouched, aspect-fit dst centered in the half (240x160+16+224, DST 480x320)',
    geom(fx) === '240x160+16+224' && dst(fx) === '480x320', fx);
  const fr = row(section('fixrestore'), 'fixbox');
  check('fixed-size snap down restores the pre-snap dst and spot (240x160+40+60, DST -)',
    geom(fr) === '240x160+40+60' && dst(fr) === '-', fr);
}

// ---- no WM: snap refused, kernel-chrome drags intact ----
check('wmctl snap with no WM is refused (snap IS policy)',
  out.includes('snap-refused'));
check('plain screen-injected drag still works with no WM (moved, size kept — no snap)',
  geom(row(section('nowm'), 'winbox')) === '240x160+-52+308',
  row(section('nowm'), 'winbox'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nsnap e2e: ${failures} FAILED` : '\nsnap e2e: PASS');
process.exit(failures ? 1 : 0);
