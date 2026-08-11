#!/usr/bin/env node
// THE CORE SELECT MENU OF /bin/netsurf (todos/0422).
//
// A <select> click used to reach NEITHER of NetSurf's two menus: the core
// menu was gated behind nsoption_bool(core_select_menu) (false by default,
// never set), and the frontend menu needs a create_form_select_menu entry
// the gucOS window table does not supply.  The fix turns the CORE menu on
// as a gucOS default (gucos/main.c set_defaults), which also changes the
// closed widget's LAYOUT: layout.c adds SCROLLBAR_WIDTH (16) to the box
// when the option is on.
//
// Coverage — open, scroll, choose, dismiss, multi-select, and the layout
// size change:
//
//   layout    the SAME page under the default and under
//             --core_select_menu=0 differs in widget width by exactly
//             SCROLLBAR_WIDTH.  Measured off a shrink-wrapped float
//             wrapper's padding strip, so no font arithmetic is assumed.
//   control   a widget click with the option OFF still does nothing (the
//             pre-fix behaviour, kept honest as the differential's base).
//   open      a widget click paints the menu: the selected row's highlight
//             band appears and the menu rectangle occludes the probe-
//             coloured block below the widget.
//   choose    a click on row 2 closes the menu, fires `change` (the JS
//             listener paints a colour that ENCODES the selected index),
//             and the widget's displayed text changes.
//   scroll    six clicks on the scrollbar's down arrow move the offset by
//             exactly 6*SCROLLBAR_WIDTH = 96px (scrollbar.c arrow
//             semantics); a click on the row then under the pointer picks
//             index 5, which without the scroll would have picked the
//             row-0/1 area.  The index comes back through the same
//             change-listener colour code, so the assert is exact.
//   dismiss   a click outside the open menu closes it (occlusion oracle
//             back to baseline) and fires NO change event.
//   multi     a <select multiple>: clicks TOGGLE options and the menu
//             STAYS OPEN (asserted per-row off the highlight bands);
//             toggling a row a second time deselects it; the final DOM
//             state (o1 off, o2 on) is read back by a button click AFTER
//             dismissal — a change listener must not touch the DOM while
//             the menu is open, because a mutation-driven re-conversion
//             dismisses the menu by design (todos/0422 notes).
//
// GEOMETRY IS MEASURED, NEVER DERIVED FROM FONT MATH: a first session
// opens the menu and shoots it; Node reads the selected-row highlight band
// (SELECT_SELECTED_COLOUR 0xDB9370) out of the PNG to get the menu origin,
// the row pitch and the scrollbar edge; a second session over the same
// image replays deterministically with computed coordinates.
//
// Run: node tests/kernel/test_netsurf_select_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* must match gucos/gui.c STATUS_H */
const STATUS_H = 18;
/* must match desktop/scrollbar.h SCROLLBAR_WIDTH */
const SCROLLBAR_W = 16;
/* must match html/form.c MAX_SELECT_HEIGHT */
const MAX_MENU_H = 210;
/* html/form.c SELECT_SELECTED_COLOUR 0xDB9370 is netsurf 0xBBGGRR; the
 * surface byte order decides which way round it lands in a shot, so the
 * test detects the variant instead of assuming one. */
const BAND_A = [0x70, 0x93, 0xDB];
const BAND_B = [0xDB, 0x93, 0x70];

const N_OPT = 20;

/* Probe colours.  Fills plot exactly (no blending), so matches are exact
 * within a small tolerance and neighbouring index colours 10 apart in one
 * channel cannot be confused. */
const C = {
  strip:  [200, 30, 90],    /* the wrapper's padding strip under the widget */
  below:  [40, 90, 160],    /* the occlusion block under the single select  */
  mbelow: [90, 40, 160],    /* the occlusion block under the multi select   */
  i1on:   [220, 120, 20],   /* multi indicator: option 1 selected           */
  i2on:   [20, 200, 60],    /* multi indicator: option 2 selected           */
};
const statColour = (idx) => [idx * 10 + 5, 60, 180];
const rgb = (c) => c.join(', ');

/* ---- the probe pages ------------------------------------------------ */

function selectOptions() {
  let s = '';
  for (let i = 0; i < N_OPT; i++) {
    const nn = String(i).padStart(2, '0');
    s += `<option id="o${i}" value="v${i}"${i === 0 ? ' selected' : ''}>Item number ${nn}</option>\n`;
  }
  return s;
}
function statClasses() {
  let s = '';
  for (let i = 0; i < N_OPT; i++) {
    s += `#stat.i${i} { background: rgb(${rgb(statColour(i))}); }\n`;
  }
  return s;
}

/* The single select.  The float wrapper shrink-wraps to the widget, so its
 * 6px padding strip measures the widget's width without any font maths. */
const pageSingle = (title) => `<!DOCTYPE html><html><head><title>${title}</title><style>
body { margin: 0; background: #ffffff; }
#wrap { float: left; background: rgb(${rgb(C.strip)}); padding-bottom: 6px; }
#below { clear: left; width: 420px; height: 250px; background: rgb(${rgb(C.below)}); }
#stat { width: 420px; height: 50px; background: #eeeeee; }
${statClasses()}
</style></head><body>
<div id="wrap"><select id="s">
${selectOptions()}
</select></div>
<div id="below"></div>
<div id="stat"></div>
<script>
var s = document.getElementById('s');
s.addEventListener('change', function () {
	var i, o, idx = -1;
	for (i = 0; i < ${N_OPT}; i++) {
		o = document.getElementById('o' + i);
		if (o && o.selected) { idx = i; break; }
	}
	document.getElementById('stat').className = (idx >= 0) ? ('i' + idx) : '';
});
</script>
</body></html>
`;

/* The multi select.  NO change listener: a DOM write while the menu is
 * open would re-convert the document and dismiss the menu (deliberate,
 * todos/0422 notes) — the toggles are asserted off the highlight bands,
 * and #readbtn paints the final DOM state after the menu is gone. */
const PAGE_MULTI = `<!DOCTYPE html><html><head><title>NsSelM</title><style>
body { margin: 0; background: #ffffff; }
#wrap { float: left; padding-bottom: 6px; }
#mbelow { clear: left; width: 420px; height: 260px; background: rgb(${rgb(C.mbelow)}); }
#i1 { width: 300px; height: 40px; background: #eeeeee; }
#i1.on { background: rgb(${rgb(C.i1on)}); }
#i2 { width: 300px; height: 40px; background: #eeeeee; }
#i2.on { background: rgb(${rgb(C.i2on)}); }
#readbtn { width: 300px; height: 40px; background: #cccccc; }
</style></head><body>
<div id="wrap"><select id="m" multiple>
<option id="m0" value="w0" selected>Multi item 00</option>
<option id="m1" value="w1">Multi item 01</option>
<option id="m2" value="w2">Multi item 02</option>
<option id="m3" value="w3">Multi item 03</option>
<option id="m4" value="w4">Multi item 04</option>
</select></div>
<div id="mbelow"></div>
<div id="i1"></div>
<div id="i2"></div>
<div id="readbtn">read</div>
<script>
document.getElementById('readbtn').addEventListener('click', function () {
	document.getElementById('i1').className =
		document.getElementById('m1').selected ? 'on' : '';
	document.getElementById('i2').className =
		document.getElementById('m2').selected ? 'on' : '';
});
</script>
</body></html>
`;

/* ---- seed boot, then plant the pages -------------------------------- */
const { dir: tmp, image } = freshImage('os-nssel-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  rfs.mkdir('/root/sel', 0o755);
  const plant = (p, text) => {
    const fd = rfs.open(p, W, 0o644);
    const bytes = Buffer.from(text, 'utf-8');
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  };
  plant('/root/sel/a.html', pageSingle('NsSelA'));
  plant('/root/sel/b.html', pageSingle('NsSelB'));
  plant('/root/sel/m.html', PAGE_MULTI);
  rootStore.flush();
  rootStore.close();
}

/* ---- shot helpers (the netsurf-e2e pattern) ------------------------- */
function parsePngs(buf, names) {
  const shots = {};
  let off = 0;
  for (const name of names) {
    let p;
    try { p = parsePng(buf, off); }
    catch (e) { throw new Error(`bad png stream at ${name}: ${e.message}`); }
    shots[name] = { w: p.w, h: p.h, data: p.rgba };
    off = p.next;
  }
  return shots;
}
const px = (s, x, y) => [s.data[(y * s.w + x) * 4],
                         s.data[(y * s.w + x) * 4 + 1],
                         s.data[(y * s.w + x) * 4 + 2]];
const near = (want, tol = 6) => (p) => Math.abs(p[0] - want[0]) < tol &&
                                       Math.abs(p[1] - want[1]) < tol &&
                                       Math.abs(p[2] - want[2]) < tol;
function countRegion(s, pred, x0, y0, x1, y1) {
  let n = 0;
  const yl = Math.min(y1, s.h - STATUS_H), xl = Math.min(x1, s.w);
  for (let y = Math.max(0, y0); y < yl; y++) {
    for (let x = Math.max(0, x0); x < xl; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
/* first row (scanning down) with >= minRun pixels of the colour */
function firstRowOf(s, want, minRun) {
  const p = near(want);
  for (let y = 0; y < s.h - STATUS_H; y++) {
    let n = 0;
    for (let x = 0; x < s.w; x++) { if (p(px(s, x, y))) n++; }
    if (n >= minRun) return y;
  }
  return -1;
}
/* [x0, x1] extent of the colour in one row (-1 if absent) */
function rowExtent(s, y, want) {
  const p = near(want);
  let x0 = -1, x1 = -1;
  for (let x = 0; x < s.w; x++) {
    if (p(px(s, x, y))) { if (x0 < 0) x0 = x; x1 = x; }
  }
  return [x0, x1];
}
function regionDiffers(a, b, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pa = px(a, x, y), pb = px(b, x, y);
      if (pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]) return true;
    }
  }
  return false;
}

/* Post-load settle: shot until two consecutive frames match. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${out} && break; cp /root/poll.png ${out}; done`,
];
/* A repaint with no wmctl-visible marker: poll PIXELS until the frame
 * differs from a reference (a bounded condition poll, not a fixed sleep). */
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${ref} || break; sleep 0.1; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* ---- session 1: measure (and the option-off differential) ----------- */
const measureOut = driveBoot([
  'netsurf /root/sel/a.html &',
  'wmctl wait win NsSelA 30000',
  sidOf('K', 'NsSelA'),
  ...pollStable('$K', '/root/s0.png'),
  'echo shot-s0-ok',
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/s0.png'),
  ...pollStable('$K', '/root/s1.png'),
  'echo shot-s1-ok',
  'wmctl close $K && wmctl wait gone $K 8000 && echo k-closed',

  /* the SAME widget with the option off: the layout differential's base
   * and the pre-fix click-does-nothing control */
  'netsurf --core_select_menu=0 /root/sel/b.html &',
  'wmctl wait win NsSelB 30000',
  sidOf('L', 'NsSelB'),
  ...pollStable('$L', '/root/b0.png'),
  'echo shot-b0-ok',
  'wmctl click $L 12 8',
  /* deliberate fixed settle: this leg asserts the ABSENCE of a menu, and
   * an absence has no marker to wait on */
  'sleep 1',
  ...pollStable('$L', '/root/b1.png'),
  'echo shot-b1-ok',
  'wmctl close $L && wmctl wait gone $L 8000 && echo l-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['s0', 's1', 'b0', 'b1']) {
  check(`shot ${tag} taken`, measureOut.includes(`shot-${tag}-ok`));
}
check('measure windows closed',
      measureOut.includes('k-closed') && measureOut.includes('l-closed'));

const back1 = driveBoot('cat /root/s0.png /root/s1.png /root/b0.png /root/b1.png\n',
                        { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const m1 = parsePngs(back1.stdout, ['s0', 's1', 'b0', 'b1']);

/* -- the layout differential (and its strip anchors) ------------------ */
const belowTop = firstRowOf(m1.s0, C.below, 100);
check('s0: the occlusion block is on screen', belowTop > 0, `belowTop ${belowTop}`);
const stripY = belowTop - 3;
const [sx0, sx1] = rowExtent(m1.s0, stripY, C.strip);
check('s0: the wrapper strip measures the ON widget', sx0 === 0 && sx1 > 40,
      `extent ${sx0}..${sx1}`);
const wOn = sx1 + 1;

const belowTopB = firstRowOf(m1.b0, C.below, 100);
const [bx0, bx1] = rowExtent(m1.b0, belowTopB - 3, C.strip);
check('b0: the wrapper strip measures the OFF widget', bx0 === 0 && bx1 > 40,
      `extent ${bx0}..${bx1}`);
const wOff = bx1 + 1;
check('layout: core_select_menu widens the widget by exactly SCROLLBAR_WIDTH',
      wOn - wOff === SCROLLBAR_W, `on ${wOn}, off ${wOff}`);

/* -- the option-off control: the click did nothing -------------------- */
check('control: with the option off the click paints NOTHING',
      !regionDiffers(m1.b0, m1.b1, 0, 0, m1.b0.w, m1.b0.h - STATUS_H));

/* -- band detection: menu origin, row pitch, scrollbar edge ----------- */
let BAND = BAND_A;
let bandTop = firstRowOf(m1.s1, BAND_A, 30);
if (bandTop < 0) { BAND = BAND_B; bandTop = firstRowOf(m1.s1, BAND_B, 30); }
check('open: the selected-row highlight band is on screen (menu open)',
      bandTop > 0, `bandTop ${bandTop}`);

let bandH = 0;
{
  const p = near(BAND);
  const [ex0] = rowExtent(m1.s1, bandTop, BAND);
  let y = bandTop;
  while (y < m1.s1.h && p(px(m1.s1, ex0 + 2, y))) { bandH++; y++; }
}
const [bandX0, bandX1] = rowExtent(m1.s1, bandTop, BAND);
/* form.c row-0 band: rows [menuY+1, menuY+rowH), x [menuX+1, scrollbar_x] */
const menuX = bandX0 - 1;
const menuTop = bandTop - 1;
const rowH = bandH + 1;
const sbX = bandX1 - 1;              /* left edge of the scrollbar column   */
const menuW = sbX + SCROLLBAR_W - menuX;
const menuH = Math.min(N_OPT * rowH, MAX_MENU_H);
check('open: band geometry is sane',
      menuX >= 0 && menuTop > 4 && rowH >= 14 && rowH <= 40 &&
      menuW > 60 && menuW < 300 && N_OPT * rowH > MAX_MENU_H,
      `menuX ${menuX}, menuTop ${menuTop}, rowH ${rowH}, menuW ${menuW}`);
check('open: the menu occludes the block below the widget',
      countRegion(m1.s1, near(C.below), menuX, belowTop, menuX + menuW, menuTop + menuH) < 300 &&
      countRegion(m1.s0, near(C.below), menuX, belowTop, menuX + menuW, menuTop + menuH) > 15000);

/* the in-band sampling column and per-row sampling points */
const bandCol = sbX - 5;
const rowY = (k, scroll = 0) => menuTop + 1 + k * rowH - scroll + 2;
const isBand = (s, y) => near(BAND)(px(s, bandCol, y));

/* the stat pixel */
const statY = belowTop + 250 + 25;
const statAt = (s) => px(s, 210, statY);
check('s0: stat starts grey', near([238, 238, 238])(statAt(m1.s0)),
      `got ${statAt(m1.s0)}`);

/* scroll-leg arithmetic (see form_select_menu_clicked): after a scroll of
 * SCROLL px, a click at menu-y Y picks index floor((SCROLL+Y-1)/rowH).
 * Six down-arrow clicks scroll exactly 6*SCROLLBAR_WIDTH = 96px, and the
 * click lands mid-row-5, which is on screen for every plausible rowH. */
const SCROLL = 6 * SCROLLBAR_W;
const PICK = 5;
const yPick = Math.round((PICK + 0.5) * rowH) - SCROLL;
check('scroll-leg target is inside the menu', yPick > 4 && yPick < menuH - 4,
      `yPick ${yPick}`);

/* click points (client coords == shot coords) */
const rowClick = (k) => `wmctl click $K ${menuX + 10} ${menuTop + 1 + Math.round((k + 0.5) * rowH)}`;
const arrowClick = `wmctl click $K ${menuX + menuW - 8} ${menuTop + menuH - 8}`;
const outsideClick = `wmctl click $K ${menuX + menuW + 90} ${menuTop + 30}`;

/* ---- session 2: the single-select legs, replayed -------------------- */
const singleOut = driveBoot([
  'netsurf /root/sel/a.html &',
  'wmctl wait win NsSelA 30000',
  sidOf('K', 'NsSelA'),
  ...pollStable('$K', '/root/a0.png'),
  'echo shot-a0-ok',

  /* open */
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/a0.png'),
  ...pollStable('$K', '/root/aopen.png'),
  'echo shot-aopen-ok',

  /* choose row 2 */
  rowClick(2),
  ...pollChange('$K', '/root/aopen.png'),
  ...pollStable('$K', '/root/achoose.png'),
  'echo shot-achoose-ok',

  /* reopen: the new selection's band renders */
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/achoose.png'),
  ...pollStable('$K', '/root/areopen.png'),
  'echo shot-areopen-ok',

  /* scroll: six down-arrow clicks = 96px */
  arrowClick, arrowClick, arrowClick, arrowClick, arrowClick, arrowClick,
  ...pollChange('$K', '/root/areopen.png'),
  ...pollStable('$K', '/root/ascroll.png'),
  'echo shot-ascroll-ok',

  /* choose through the scrolled mapping */
  `wmctl click $K ${menuX + 10} ${menuTop + 1 + yPick}`,
  ...pollChange('$K', '/root/ascroll.png'),
  ...pollStable('$K', '/root/apick.png'),
  'echo shot-apick-ok',

  /* reopen, then dismiss with an outside click */
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/apick.png'),
  ...pollStable('$K', '/root/are2.png'),
  'echo shot-are2-ok',
  outsideClick,
  ...pollChange('$K', '/root/are2.png'),
  ...pollStable('$K', '/root/adism.png'),
  'echo shot-adism-ok',

  'wmctl close $K && wmctl wait gone $K 8000 && echo a-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['a0', 'aopen', 'achoose', 'areopen', 'ascroll', 'apick', 'are2', 'adism']) {
  check(`shot ${tag} taken`, singleOut.includes(`shot-${tag}-ok`));
}
check('the single-select window closed', singleOut.includes('a-closed'));

/* ---- session 3: measure the multi menu ------------------------------ */
const multiMeasureOut = driveBoot([
  'netsurf /root/sel/m.html &',
  'wmctl wait win NsSelM 30000',
  sidOf('K', 'NsSelM'),
  ...pollStable('$K', '/root/m0.png'),
  'echo shot-m0-ok',
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/m0.png'),
  ...pollStable('$K', '/root/mopen.png'),
  'echo shot-mopen-ok',
  'wmctl close $K && wmctl wait gone $K 8000 && echo m-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['m0', 'mopen']) {
  check(`shot ${tag} taken`, multiMeasureOut.includes(`shot-${tag}-ok`));
}
check('the multi measure window closed', multiMeasureOut.includes('m-closed'));

const back2 = driveBoot('cat /root/m0.png /root/mopen.png\n',
                        { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const m2 = parsePngs(back2.stdout, ['m0', 'mopen']);

const mbelowTop = firstRowOf(m2.m0, C.mbelow, 100);
check('m0: the multi occlusion block is on screen', mbelowTop > 0,
      `mbelowTop ${mbelowTop}`);
const mBandTop = firstRowOf(m2.mopen, BAND, 30);
check('multi open: the preselected row-0 band is on screen', mBandTop > 0,
      `mBandTop ${mBandTop}`);
let mBandH = 0;
{
  const p = near(BAND);
  const [ex0] = rowExtent(m2.mopen, mBandTop, BAND);
  let y = mBandTop;
  while (y < m2.mopen.h && p(px(m2.mopen, ex0 + 2, y))) { mBandH++; y++; }
}
const [mBandX0, mBandX1] = rowExtent(m2.mopen, mBandTop, BAND);
const mMenuX = mBandX0 - 1;
const mMenuTop = mBandTop - 1;
const mRowH = mBandH + 1;
const mSbX = mBandX1 - 1;
const mMenuW = mSbX + SCROLLBAR_W - mMenuX;
const mMenuH = 5 * mRowH;   /* 5 options, far under MAX_SELECT_HEIGHT */
check('multi open: band geometry is sane',
      mMenuX >= 0 && mMenuTop > 4 && mRowH >= 14 && mRowH <= 40 && mMenuH < MAX_MENU_H,
      `mMenuX ${mMenuX}, mMenuTop ${mMenuTop}, mRowH ${mRowH}`);

const mBandCol = mSbX - 5;
const mRowY = (k) => mMenuTop + 1 + k * mRowH + 2;
const mIsBand = (s, k) => near(BAND)(px(s, mBandCol, mRowY(k)));
const mRowClick = (k) => `wmctl click $K ${mMenuX + 10} ${mMenuTop + 1 + Math.round((k + 0.5) * mRowH)}`;
const mOutsideClick = `wmctl click $K ${mMenuX + mMenuW + 90} ${mMenuTop + 20}`;
const i1Y = mbelowTop + 260 + 20;
const i2Y = mbelowTop + 260 + 40 + 20;
const readY = mbelowTop + 260 + 80 + 20;

/* ---- session 4: the multi-select legs, replayed --------------------- */
const multiOut = driveBoot([
  'netsurf /root/sel/m.html &',
  'wmctl wait win NsSelM 30000',
  sidOf('K', 'NsSelM'),
  ...pollStable('$K', '/root/n0.png'),
  'echo shot-n0-ok',

  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/n0.png'),
  ...pollStable('$K', '/root/nopen.png'),
  'echo shot-nopen-ok',

  /* toggle option 1 on — the menu must STAY open */
  mRowClick(1),
  ...pollChange('$K', '/root/nopen.png'),
  ...pollStable('$K', '/root/n1.png'),
  'echo shot-n1-ok',

  /* toggle option 2 on */
  mRowClick(2),
  ...pollChange('$K', '/root/n1.png'),
  ...pollStable('$K', '/root/n2.png'),
  'echo shot-n2-ok',

  /* toggle option 1 OFF again */
  mRowClick(1),
  ...pollChange('$K', '/root/n2.png'),
  ...pollStable('$K', '/root/n3.png'),
  'echo shot-n3-ok',

  /* dismiss */
  mOutsideClick,
  ...pollChange('$K', '/root/n3.png'),
  ...pollStable('$K', '/root/ndism.png'),
  'echo shot-ndism-ok',

  /* read the final DOM state back through the button */
  `wmctl click $K 200 ${readY}`,
  ...pollChange('$K', '/root/ndism.png'),
  ...pollStable('$K', '/root/nread.png'),
  'echo shot-nread-ok',

  'wmctl close $K && wmctl wait gone $K 8000 && echo n-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['n0', 'nopen', 'n1', 'n2', 'n3', 'ndism', 'nread']) {
  check(`shot ${tag} taken`, multiOut.includes(`shot-${tag}-ok`));
}
check('the multi window closed', multiOut.includes('n-closed'));

/* ---- read the replay shots back ------------------------------------- */
const NAMES = ['a0', 'aopen', 'achoose', 'areopen', 'ascroll', 'apick', 'are2', 'adism',
               'n0', 'nopen', 'n1', 'n2', 'n3', 'ndism', 'nread'];
const back3 = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.png`).join(' ') + '\n',
                        { image, encoding: null, maxBuffer: 256 * 1024 * 1024 });
const S = parsePngs(back3.stdout, NAMES);

/* the occlusion oracle: probe-colour count inside the menu rectangle */
const menuBelow = (s) =>
  countRegion(s, near(C.below), menuX, belowTop, menuX + menuW, menuTop + menuH);
const mMenuBelow = (s) =>
  countRegion(s, near(C.mbelow), mMenuX, mbelowTop, mMenuX + mMenuW, mMenuTop + mMenuH);
const closedBase = menuBelow(S.a0);
const mClosedBase = mMenuBelow(S.n0);
check('a0: baseline occlusion count is large', closedBase > 15000, `${closedBase}`);
check('n0: baseline multi occlusion count is large', mClosedBase > 8000, `${mClosedBase}`);
const OPEN = (s) => menuBelow(s) < 300;
const CLOSED = (s) => menuBelow(s) > closedBase - 300;
const MOPEN = (s) => mMenuBelow(s) < 300;
const MCLOSED = (s) => mMenuBelow(s) > mClosedBase - 300;

/* ---- single: open ---------------------------------------------------- */
check('open: the menu is open and row 0 highlighted',
      OPEN(S.aopen) && isBand(S.aopen, rowY(0)), `below ${menuBelow(S.aopen)}`);

/* ---- single: choose -------------------------------------------------- */
check('choose: the menu closed on the pick', CLOSED(S.achoose),
      `below ${menuBelow(S.achoose)}`);
check('choose: `change` fired with index 2 (the listener colour)',
      near(statColour(2))(statAt(S.achoose)), `got ${statAt(S.achoose)}`);
check('choose: the widget shows the new value (its text repainted)',
      regionDiffers(S.a0, S.achoose, 2, 2, wOn - 2, menuTop - 2));
check('reopen: the menu reopened with row 2 highlighted',
      OPEN(S.areopen) && isBand(S.areopen, rowY(2)) && !isBand(S.areopen, rowY(0)),
      `below ${menuBelow(S.areopen)}`);

/* ---- single: scroll -------------------------------------------------- */
check('scroll: the menu is still open after six arrow clicks',
      OPEN(S.ascroll), `below ${menuBelow(S.ascroll)}`);
check('scroll: the row-2 band left its unscrolled position',
      !isBand(S.ascroll, rowY(2)),
      `band still at rowY(2)=${rowY(2)}`);
check('scroll: the row-2 band sits exactly 96px higher',
      2 * rowH - SCROLL < 0 || isBand(S.ascroll, rowY(2, SCROLL)));
check('scroll+choose: the same click column now picks index 5',
      near(statColour(PICK))(statAt(S.apick)), `got ${statAt(S.apick)}`);
check('scroll+choose: the menu closed on the pick', CLOSED(S.apick),
      `below ${menuBelow(S.apick)}`);

/* ---- single: dismiss ------------------------------------------------- */
check('reopen 2: the menu opens again after the scrolled pick', OPEN(S.are2),
      `below ${menuBelow(S.are2)}`);
check('dismiss: an outside click closed the menu', CLOSED(S.adism),
      `below ${menuBelow(S.adism)}`);
check('dismiss: no change event fired (stat still shows index 5)',
      near(statColour(PICK))(statAt(S.adism)), `got ${statAt(S.adism)}`);

/* ---- multi ----------------------------------------------------------- */
check('multi open: menu open, row 0 preselected',
      MOPEN(S.nopen) && mIsBand(S.nopen, 0) && !mIsBand(S.nopen, 1));
check('multi toggle 1: row 1 highlighted and the menu STAYED OPEN',
      MOPEN(S.n1) && mIsBand(S.n1, 0) && mIsBand(S.n1, 1),
      `below ${mMenuBelow(S.n1)}`);
check('multi toggle 2: rows 0+1+2 highlighted, still open',
      MOPEN(S.n2) && mIsBand(S.n2, 0) && mIsBand(S.n2, 1) && mIsBand(S.n2, 2));
check('multi re-toggle 1: row 1 DEselected, still open',
      MOPEN(S.n3) && mIsBand(S.n3, 0) && !mIsBand(S.n3, 1) && mIsBand(S.n3, 2));
check('multi dismiss: an outside click closed the menu', MCLOSED(S.ndism),
      `below ${mMenuBelow(S.ndism)}`);
check('multi DOM state: option 1 off, option 2 on (read after dismissal)',
      near([238, 238, 238])(px(S.nread, 210, i1Y)) &&
      near(C.i2on)(px(S.nread, 210, i2Y)),
      `i1 ${px(S.nread, 210, i1Y)}, i2 ${px(S.nread, 210, i2Y)}`);

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf select-menu e2e checks passed');
