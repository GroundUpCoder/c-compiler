#!/usr/bin/env node
// EXPOSE (todos/EXPOSE-MISSION-CONTROL.md) acceptance, headless: the window
// overview / Exposé through the REAL /bin/wm + /bin/wmctl via os/boot.js.
// Covers: `wmctl overview` ENTERS (the kernel composites live miniatures, seen
// in `wmctl shot screen` — the deterministic CPU branch that makes this test
// honest), a PICK on a cell focuses+raises that window and EXITS, a background
// click dismisses (PICK{0}), relayout while active as windows come/go, N=1
// enters, N=0 refuses (no-op), and the crashed-WM story (overview refused —
// overview IS policy). Esc-dismiss rides wmKey (real keys), covered by the
// browser sweep os-overview.mjs.
//
// Geometry on the 1024x768 headless screen (wm.c metrics): work area = 1024 x
// 704 at y 28 (BAR_H 36, TITLE_H 28). winbox is 240x160 at 12,36 (orange fill
// 255,140,0 interior, white border; desktop teal 0,128,128). With N=1 the
// aspect-fit grid (OV_GAP 16, OV_CAPTION_H 24) puts the single miniature at
// 240x160+392+288 (scale clamped <=1), so the window's ORIGINAL interior pixel
// buffer(88,64) = screen(100,100) reappears in the miniature at screen(480,352).
//
// Run: node tests/kernel/test_overview_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-overview-');

// PPM header on 1024x768 is 16 bytes; tail -c is 1-based, so the first pixel
// byte is at offset 17 (the test_snap precedent).
const ppmOff = (x, y) => 17 + (y * 1024 + x) * 3;
const ORANGE = '\\377\\214\\000';   // 255,140,0  winbox interior fill
const TEAL   = '\\000\\200\\200';   // 0,128,128  the desktop

// Emit a "pixel at (x,y) in FILE equals EXPECT (octal-escaped RGB)" probe that
// echoes TAG-ok on a match — the test_snap cmp pattern.
function pixEq(file, x, y, expectOctal, tag) {
  return [
    `tail -c +${ppmOff(x, y)} ${file} | head -c 3 > /root/${tag}.bin`,
    `printf '${expectOctal}' > /root/${tag}.exp`,
    `cmp /root/${tag}.bin /root/${tag}.exp && echo ${tag}-ok`,
  ];
}

const script = [
  'winbox &',
  'wmctl wait win winbox',
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'wmctl shot screen /root/base.ppm && echo base-shot-ok',
  ...pixEq('/root/base.ppm', 100, 100, ORANGE, 'base'),   // window at its spot

  // ---- ENTER: `wmctl overview` -> EV_OVERVIEW -> wm.c layout -> OVERVIEW_SET.
  'wmctl overview && echo overview-cmd-ok',
  'sleep 1',   // genuine no-marker settle: EV_OVERVIEW -> OVERVIEW_SET is a wm.c
               // round-trip that creates NO window to wait on
  'wmctl shot screen /root/ov.ppm && echo ov-shot-ok',
  ...pixEq('/root/ov.ppm', 100, 100, TEAL, 'ovspot'),     // spot cleared
  ...pixEq('/root/ov.ppm', 480, 352, ORANGE, 'ovmini'),   // live miniature

  // ---- PICK a cell: focus+raise the window, exit. Inject a pointer-down
  // inside the miniature; the kernel routes it to EV_OVERVIEW_PICK{winbox}.
  'wmctl sdown 480 352',
  'sleep 1',   // genuine no-marker settle: PICK -> OVERVIEW_END + FOCUS round-trip
  'wmctl shot screen /root/pick.ppm && echo pick-shot-ok',
  ...pixEq('/root/pick.ppm', 100, 100, ORANGE, 'pickspot'),  // restored
  'echo ==afterpick',
  'wmctl list',

  // ---- BACKGROUND dismiss: enter again, click empty space -> PICK{0} -> exit.
  'wmctl overview && echo overview-cmd2-ok',
  'sleep 1',   // genuine no-marker settle (as above)
  'wmctl shot screen /root/ov2.ppm && echo ov2-shot-ok',
  ...pixEq('/root/ov2.ppm', 100, 100, TEAL, 'ov2spot'),
  'wmctl sdown 5 5',                     // far corner: no cell -> dismiss
  'sleep 1',   // genuine no-marker settle
  'wmctl shot screen /root/bg.ppm && echo bg-shot-ok',
  ...pixEq('/root/bg.ppm', 100, 100, ORANGE, 'bgspot'),     // restored

  // ---- RELAYOUT while active: a second window joins the grid; both remain
  // miniatures (the original spot stays cleared). Then killing all windows
  // force-exits the overview.
  'wmctl overview && echo overview-cmd3-ok',
  'sleep 1',   // genuine no-marker settle
  'winbox &',                            // a 2nd window -> EV_CREATED relayout
  'wmctl wait win winbox',
  'sleep 1',   // genuine no-marker settle: EV_CREATED -> OVERVIEW_SET relayout
  'wmctl shot screen /root/relay.ppm && echo relay-shot-ok',
  ...pixEq('/root/relay.ppm', 100, 100, TEAL, 'relayspot'), // still overview

  // ---- N=0 refuses: close both windows (overview force-exits at N=0), then a
  // bare `wmctl overview` is a no-op — a fresh window renders NORMALLY.
  'wmctl close $WSID',
  'W2=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'wmctl close $W2',
  'wmctl wait nowin winbox',
  'wmctl overview && echo overview-empty-ok',   // command succeeds (WM present)
  'sleep 1',   // genuine no-marker settle
  'winbox &',
  'wmctl wait win winbox',
  'wmctl shot screen /root/empty.ppm && echo empty-shot-ok',
  ...pixEq('/root/empty.ppm', 100, 100, ORANGE, 'emptyspot'),  // NOT a miniature

  // ---- crashed-WM story: overview IS policy, refused with no subscriber.
  'WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")',
  'kill $WMPID',
  'wmctl wait nowin taskbar',
  'wmctl overview || echo overview-refused',
  'echo ==done',
  '',
].join('\n');

const r = driveBoot(script, { image });
const out = r.stdout;

check('base screenshot written', out.includes('base-shot-ok'));
check('winbox renders at its spot before overview (orange interior)',
  out.includes('base-ok'));

check('`wmctl overview` accepted (WM subscribed)', out.includes('overview-cmd-ok'));
check('ENTER: the window\'s original spot is cleared to desktop teal',
  out.includes('ovspot-ok'));
check('ENTER: a LIVE miniature of winbox appears at its grid cell (orange)',
  out.includes('ovmini-ok'));

check('PICK: clicking the miniature restores the window to its spot (exit)',
  out.includes('pickspot-ok'));
check('PICK: winbox still exists after the pick (focused/raised, not closed)',
  /\twinbox$/m.test(out.split('==afterpick\n')[1] || ''));

check('BACKGROUND: re-enter clears the spot again', out.includes('ov2spot-ok'));
check('BACKGROUND: a click on empty space dismisses (PICK{0}) -> restored',
  out.includes('bgspot-ok'));

check('RELAYOUT: a window created while active re-lays the grid (still overview)',
  out.includes('relayspot-ok'));

check('N=0: a bare `wmctl overview` with no windows is a no-op (command ok)',
  out.includes('overview-empty-ok'));
check('N=0: a fresh window after the no-op renders NORMALLY (not a miniature)',
  out.includes('emptyspot-ok'));

check('crashed WM: `wmctl overview` refused with no subscriber (overview IS policy)',
  out.includes('overview-refused'));

console.log(failures ? `\nFAILED (${failures})` : '\nPASSED');
process.exit(failures ? 1 : 0);
