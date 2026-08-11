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
// 1024 x 704 at y 28 (BAR_H 36, TITLE_H 28); halves 512x704; quarters
// 512x338 (top y 28, bottom y 394 — the bottom row's own title bar fits).
//
// Run: node tests/kernel/test_snap_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage , readShots } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-snap-');

// Preview pixels (todos/0063 deterministic src-over, integer math): white
// fill a=80 over the teal desktop -> (80,168,168); the 2px border a=192 ->
// (192,224,224). Asserted host-side out of the shot PNG after the boot
// (#657): a compressed image has no fixed byte offset per pixel, and the
// decoded compare reports the ACTUAL rgb on a miss instead of a silent
// `cmp` mismatch.

const script = [
  'winbox &',
  'wmctl wait win winbox',
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'echo ==base',
  'wmctl list',
  // ---- drag-to-edge (the 0095 acceptance gesture): grab the title at
  // (100,26) — the window sits at 12,36, title band y 12..36 — and park
  // the pointer INSIDE the left edge zone before releasing.
  'wmctl sdown 100 26',
  'wmctl smove 400 300',                         // mid-screen: no zone yet
  'wmctl smove 4 300',                           // left zone -> preview up
  'wmctl wait win snappreview',
  'echo ==mid',
  'wmctl list',
  'wmctl shot screen /root/mid.png && echo mid-shot-ok',
  'wmctl sup 4 300',                             // drop -> snap left
  'wmctl wait nowin snappreview',
  'echo ==left',
  'wmctl list',
  // The preview pixels are asserted host-side from /root/mid.png below:
  // fill well inside the left half but clear of the dragged window (450,150),
  // border at x=1 (1,150).
  // ---- drag-off: dragging the snapped window away restores its floating
  // SIZE at the drop point (down on the snapped title: y 4..28).
  'wmctl sdrag 256 14 500 300',
  'sleep 1',                                     // timing subject: geometry round-trip (drag-off restore)
  'echo ==dragoff',
  'wmctl list',
  // ---- right-edge drag -> right half (the mirrored zone, edge 2; the
  // title now spans y 290..314 at x 244..484).
  'wmctl sdrag 300 306 1020 300',
  'sleep 1',                                     // timing subject: geometry round-trip (right-half snap)
  'echo ==rightdrag',
  'wmctl list',
  // ---- drag back off (title spans y 4..28 at x 512..1024; drop puts the
  // floating window at 212,314), then corner drag -> top-left quarter.
  'wmctl sdrag 700 14 400 300',
  'sleep 1',                                     // timing subject: geometry round-trip (drag back off)
  'wmctl sdown 300 306',
  'wmctl smove 3 3',
  'wmctl wait win snappreview',
  'wmctl sup 3 3',
  'wmctl wait nowin snappreview',
  'echo ==quarter',
  'wmctl list',
  // ---- the command path (= the Win+arrow chord event, todos/0095).
  'wmctl snap right && echo snap-right-ok',
  'sleep 1',                                     // timing subject: geometry round-trip (snap right)
  'echo ==right',
  'wmctl list',
  'wmctl snap right',                            // toward its own edge: wrap
  'sleep 1',                                     // timing subject: geometry round-trip (wrap across)
  'echo ==wrap',
  'wmctl list',
  'wmctl snap up',                               // maximize (the 0025 state)
  'sleep 1',                                     // timing subject: geometry round-trip (maximize)
  'echo ==max',
  'wmctl list',
  'wmctl snap down',                             // restore the floating rect
  'sleep 1',                                     // timing subject: geometry round-trip (restore floating)
  'echo ==floatback',
  'wmctl list',
  'wmctl snap down',                             // floating: minimize
  'wmctl wait flag $WSID m',
  'echo ==min',
  'wmctl list',
  'wmctl restore $WSID',
  'wmctl wait noflag $WSID m',
  // ---- fixed-size branch: letterbox into the half (aspect-fit SET_DST,
  // centered — the maximize dispatch exactly).
  'winbox fixed &',
  'wmctl wait win fixbox',
  'FSID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")',
  'wmctl focus $FSID',
  'wmctl wait flag $FSID f',
  'wmctl snap left',
  'sleep 0.7',                                   // timing subject: geometry round-trip (fixed-size letterbox)
  'echo ==fixleft',
  'wmctl list',
  'wmctl snap down',
  'sleep 0.7',                                   // timing subject: geometry round-trip (fixed-size restore)
  'echo ==fixrestore',
  'wmctl list',
  // ---- crashed-WM story: snap IS policy; plain drags stay kernel-chrome.
  'WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")',
  'kill $WMPID',
  'wmctl wait nowin taskbar',
  'wmctl snap left || echo snap-refused',
  'wmctl sdrag 300 306 4 300',                   // winbox title at y 290..314
  'sleep 0.5',                                   // timing subject: geometry round-trip (kernel-chrome drag, no WM)
  'echo ==nowm',
  'wmctl list',
  '',
].join('\n');

const r = driveBoot(script, { image });

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
  check('mid-drag: snappreview window covers the left half + title band (512x732+0+0)',
    geom(prev) === '512x732+0+0', JSON.stringify(mid));
  check('preview is borderless + per-pixel alpha + top layer (b, A, T flags)',
    flags(prev).includes('b') && flags(prev).includes('A') && flags(prev).includes('T'),
    prev);
  check('the dragged window keeps focus (preview hand-back)',
    flags(row(mid, 'winbox'))[0] === 'f', row(mid, 'winbox'));
  check('mid-drag screen shot written', out.includes('mid-shot-ok'));
  const { mid: midShot } = readShots(tmp, { mid: 'mid.png' });
  check('mid-drag shot is the full 1024x768 screen',
    midShot.w === 1024 && midShot.h === 768, `${midShot.w}x${midShot.h}`);
  check('preview fill blends the exact 0063 src-over (80,168,168 over teal)',
    String(midShot.px(450, 150).slice(0, 3)) === '80,168,168',
    String(midShot.px(450, 150)));
  check('preview border blends the exact src-over (192,224,224)',
    String(midShot.px(1, 150).slice(0, 3)) === '192,224,224',
    String(midShot.px(1, 150)));
}

// ---- the drop: left half; preview gone ----
{
  const left = section('left');
  check('drop on the left edge snaps to the left half (512x704+0+28)',
    geom(row(left, 'winbox')) === '512x704+0+28', row(left, 'winbox'));
  check('the preview is gone at the drop', row(left, 'snappreview') === '',
    JSON.stringify(left));
}

// ---- drag-off restore ----
check('dragging the snapped window off restores its floating size at the drop (240x160+244+314)',
  geom(row(section('dragoff'), 'winbox')) === '240x160+244+314',
  row(section('dragoff'), 'winbox'));

// ---- right-edge drag (the mirrored zone) ----
check('right-edge drop snaps to the right half (512x704+512+28)',
  geom(row(section('rightdrag'), 'winbox')) === '512x704+512+28',
  row(section('rightdrag'), 'winbox'));

// ---- corner quarter ----
check('corner drop snaps to the top-left quarter (512x338+0+28)',
  geom(row(section('quarter'), 'winbox')) === '512x338+0+28',
  row(section('quarter'), 'winbox'));

// ---- the command path (= Win+arrow) ----
check('wmctl snap right accepted', out.includes('snap-right-ok'));
check('snap right: the right half (512x704+512+28)',
  geom(row(section('right'), 'winbox')) === '512x704+512+28',
  row(section('right'), 'winbox'));
check('snap right again wraps across to the left half',
  geom(row(section('wrap'), 'winbox')) === '512x704+0+28',
  row(section('wrap'), 'winbox'));
check('snap up maximizes to the work area (1024x704+0+28)',
  geom(row(section('max'), 'winbox')) === '1024x704+0+28',
  row(section('max'), 'winbox'));
check('snap down restores the floating rect saved at the last snap-out (240x160+212+314)',
  geom(row(section('floatback'), 'winbox')) === '240x160+212+314',
  row(section('floatback'), 'winbox'));
check('snap down on a floating window minimizes it',
  flags(row(section('min'), 'winbox')).includes('m'),
  row(section('min'), 'winbox'));

// ---- fixed-size branch: letterboxed halves ----
{
  const fx = row(section('fixleft'), 'fixbox');
  check('fixed-size snap left: buffer untouched, aspect-fit dst centered in the half (240x160+16+220, DST 480x320)',
    geom(fx) === '240x160+16+220' && dst(fx) === '480x320', fx);
  const fr = row(section('fixrestore'), 'fixbox');
  check('fixed-size snap down restores the pre-snap dst and spot (240x160+40+60, DST -)',
    geom(fr) === '240x160+40+60' && dst(fr) === '-', fr);
}

// ---- no WM: snap refused, kernel-chrome drags intact ----
check('wmctl snap with no WM is refused (snap IS policy)',
  out.includes('snap-refused'));
check('plain screen-injected drag still works with no WM (moved, size kept — no snap)',
  geom(row(section('nowm'), 'winbox')) === '240x160+-84+308',
  row(section('nowm'), 'winbox'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nsnap e2e: ${failures} FAILED` : '\nsnap e2e: PASS');
process.exit(failures ? 1 : 0);
