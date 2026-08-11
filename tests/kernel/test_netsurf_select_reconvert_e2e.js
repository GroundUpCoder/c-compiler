#!/usr/bin/env node
// AN OPEN CORE SELECT MENU SURVIVES A LIVE RE-CONVERSION (todos/0434).
//
// Before 0434, html__reconvert freed the open menu at every window start,
// and box_select's option-list refill destroyed the menu object with the
// list (form_select_clear_options).  Since 0434 the menu object's lifetime
// is the CONTROL's, `visible_select_menu` rides the window, and a settle
// rule at the window's end decides re-attach vs dismiss.  The rule
// (ticket ## Design): dismiss when the gadget lost its screen box, when
// the option list is empty, or when the anchor — the current option's DOM
// node, snapshot at the window start — is absent from the rebuilt list.
// Otherwise re-attach with geometry re-measured and the scroll offset
// kept in pixels.
//
// The trigger in every leg is DETERMINISTIC: a multi-select row click
// keeps the menu open (todos/0422) and fires `change` synchronously; the
// change listener performs the JS mutation while the menu is open.  The
// listener also flips a #mark strip, which only paints through the
// re-conversion — the settled shot must show the flip, so a shot that
// somehow settled before the re-conversion fails LOUD instead of passing
// vacuously.  A #readbtn click after dismissal paints the change-event
// COUNT, so "the dismissal fires no change event" is asserted exactly.
//
//   survive   (acceptance 1) menu open on select A, scrolled 96px, a row
//             toggle makes the listener write `option.selected` on select
//             B.  The settled shot: menu still open, the toggled row's
//             band at its 96px-scrolled position (one sample asserts BOTH
//             the highlight and the exact scroll offset), the mark
//             flipped, and exactly one change event.
//   remove    (acceptance 2) the listener removes the just-toggled option
//             (the menu's anchor).  The settled shot: menu CLOSED
//             (occlusion oracle back to baseline), mark flipped, and the
//             count still 1 — the dismissal fired no change.
//   append    (acceptance 3) the listener appends a selected option to
//             the OPEN 20-item list.  The settled shot: menu still open.
//             Scroll-to-clamp then shows the appended option's band on
//             the menu's bottom row — a position only reachable if the
//             scroll range grew to 21 items (a 20-item clamp puts the
//             unselected item 19 there).
//
// GEOMETRY IS MEASURED, NEVER DERIVED FROM FONT MATH (the 0422 pattern):
// a first session opens each menu and shoots it; Node reads the
// selected-row highlight band out of the PNG; a second session replays
// with computed client coordinates.
//
// Run: node tests/kernel/test_netsurf_select_reconvert_e2e.js
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
/* html/form.c SELECT_SELECTED_COLOUR 0xDB9370 — byte-order variant
 * detected, not assumed (the 0422 pattern) */
const BAND_A = [0x70, 0x93, 0xDB];
const BAND_B = [0xDB, 0x93, 0x70];

const N_OPT = 20;

/* Probe colours (exact fills, tolerance 6) */
const C = {
  below:  [40, 90, 160],    /* occlusion block under the select          */
  markon: [230, 40, 200],   /* #mark after the listener ran (reconvert)  */
  markoff: [238, 238, 238],
  cnt1:   [55, 200, 40],    /* #cntbox after exactly one change event    */
  cnt2:   [95, 200, 40],    /* two events = the dismissal fired one: BUG */
};
const rgb = (c) => c.join(', ');

/* ---- the probe pages ------------------------------------------------ */

function options(prefix, n, selectedIdx) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const nn = String(i).padStart(2, '0');
    s += `<option id="${prefix}${i}" value="v${i}"${i === selectedIdx ? ' selected' : ''}>Item number ${nn}</option>\n`;
  }
  return s;
}

/* Shared page shell: a float-wrapped multi select at the origin, an
 * occlusion block under it, then mark / count / read strips.  The change
 * LISTENER is the tested mutation and differs per page. */
const page = (title, selectHtml, extraHtml, listenerBody) => `<!DOCTYPE html><html><head><title>${title}</title><style>
body { margin: 0; background: #ffffff; }
#wrap { float: left; padding-bottom: 6px; }
#below { clear: left; width: 420px; height: 250px; background: rgb(${rgb(C.below)}); }
#mark { width: 420px; height: 40px; background: rgb(${rgb(C.markoff)}); }
#mark.on { background: rgb(${rgb(C.markon)}); }
#cntbox { width: 420px; height: 40px; background: rgb(${rgb(C.markoff)}); }
#cntbox.k1 { background: rgb(${rgb(C.cnt1)}); }
#cntbox.k2 { background: rgb(${rgb(C.cnt2)}); }
#readbtn { width: 420px; height: 40px; background: #cccccc; }
</style></head><body>
<div id="wrap">${selectHtml}</div>
${extraHtml}
<div id="below"></div>
<div id="mark"></div>
<div id="cntbox"></div>
<div id="readbtn">read</div>
<script>
var cnt = 0;
document.getElementById('m').addEventListener('change', function () {
	cnt++;
	${listenerBody}
	document.getElementById('mark').className = 'on';
});
document.getElementById('readbtn').addEventListener('click', function () {
	document.getElementById('cntbox').className = 'k' + cnt;
});
</script>
</body></html>
`;

/* survive: the listener's mutation is a write to option.selected on a
 * DIFFERENT element (the closed single select #b, parked clear of the
 * menu at left 300px).  The #mark flip rides the same handler purely as
 * the reconvert-completion marker. */
const PAGE_A = page('NsRcA',
  `<select id="m" multiple>\n${options('a', N_OPT, 0)}</select>`,
  `<div style="position: absolute; left: 300px; top: 0;"><select id="b">
<option id="b0" value="w0" selected>Bee 00</option>
<option id="b1" value="w1">Bee 01</option>
<option id="b2" value="w2">Bee 02</option>
<option id="b3" value="w3">Bee 03</option>
</select></div>`,
  `if (cnt === 1) { document.getElementById('b3').selected = true; }`);

/* remove: the listener removes the option the click just toggled — the
 * menu's anchor — from the open list */
const PAGE_R = page('NsRcR',
  `<select id="m" multiple>\n${options('r', 5, 0)}</select>`,
  '',
  `var o = document.getElementById('r3');
	if (o) { document.getElementById('m').removeChild(o); }`);

/* append: the listener appends a SELECTED option to the open list */
const PAGE_C = page('NsRcC',
  `<select id="m" multiple>\n${options('c', N_OPT, 0)}</select>`,
  '',
  `if (cnt === 1) {
		var s = document.getElementById('m');
		var o = document.createElement('option');
		o.textContent = 'Item appended';
		s.appendChild(o);
		o.selected = true;
	}`);

/* ---- seed boot, then plant the pages -------------------------------- */
const { dir: tmp, image } = freshImage('os-nsrc-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  rfs.mkdir('/root/rc', 0o755);
  const plant = (p, text) => {
    const fd = rfs.open(p, W, 0o644);
    const bytes = Buffer.from(text, 'utf-8');
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  };
  plant('/root/rc/a.html', PAGE_A);
  plant('/root/rc/r.html', PAGE_R);
  plant('/root/rc/c.html', PAGE_C);
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
function firstRowOf(s, want, minRun) {
  const p = near(want);
  for (let y = 0; y < s.h - STATUS_H; y++) {
    let n = 0;
    for (let x = 0; x < s.w; x++) { if (p(px(s, x, y))) n++; }
    if (n >= minRun) return y;
  }
  return -1;
}
function rowExtent(s, y, want) {
  const p = near(want);
  let x0 = -1, x1 = -1;
  for (let x = 0; x < s.w; x++) {
    if (p(px(s, x, y))) { if (x0 < 0) x0 = x; x1 = x; }
  }
  return [x0, x1];
}

const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${out} && break; cp /root/poll.png ${out}; done`,
];
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${ref} || break; sleep 0.1; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* ---- session 1: measure the three menus ----------------------------- */
const measureOut = driveBoot([].concat(...[
  ['a', 'NsRcA'], ['r', 'NsRcR'], ['c', 'NsRcC'],
].map(([tag, title]) => [
  `netsurf /root/rc/${tag}.html &`,
  `wmctl wait win ${title} 30000`,
  sidOf('K', title),
  ...pollStable('$K', `/root/${tag}0.png`),
  `echo shot-${tag}0-ok`,
  'wmctl click $K 12 8',
  ...pollChange('$K', `/root/${tag}0.png`),
  ...pollStable('$K', `/root/${tag}open.png`),
  `echo shot-${tag}open-ok`,
  `wmctl close $K && wmctl wait gone $K 8000 && echo ${tag}-closed`,
])), { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['a0', 'aopen', 'r0', 'ropen', 'c0', 'copen']) {
  check(`shot ${tag} taken`, measureOut.includes(`shot-${tag}-ok`));
}
check('measure windows closed',
      ['a', 'r', 'c'].every((t) => measureOut.includes(`${t}-closed`)));

const back1 = driveBoot('cat /root/a0.png /root/aopen.png /root/r0.png /root/ropen.png /root/c0.png /root/copen.png\n',
                        { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const M = parsePngs(back1.stdout, ['a0', 'aopen', 'r0', 'ropen', 'c0', 'copen']);

/* band-variant detection off the first open shot */
let BAND = BAND_A;
if (firstRowOf(M.aopen, BAND_A, 30) < 0) { BAND = BAND_B; }

/* per-page geometry from the row-0 selected band (the 0422 derivation:
 * menu origin, row pitch, scrollbar edge) */
function menuGeom(shot, nOpt, label) {
  const bandTop = firstRowOf(shot, BAND, 30);
  check(`${label}: the selected-row band is on screen (menu open)`,
        bandTop > 0, `bandTop ${bandTop}`);
  if (bandTop < 0) return null;
  const p = near(BAND);
  const [ex0, ex1] = rowExtent(shot, bandTop, BAND);
  let bandH = 0;
  let y = bandTop;
  while (y < shot.h && p(px(shot, ex0 + 2, y))) { bandH++; y++; }
  const g = {
    menuX: ex0 - 1,
    menuTop: bandTop - 1,
    rowH: bandH + 1,
    sbX: ex1 - 1,
  };
  g.menuW = g.sbX + SCROLLBAR_W - g.menuX;
  g.menuH = Math.min(nOpt * g.rowH, MAX_MENU_H);
  check(`${label}: band geometry is sane`,
        g.menuX >= 0 && g.menuTop > 4 && g.rowH >= 14 && g.rowH <= 40 &&
        g.menuW > 60 && g.menuW < 300,
        `menuX ${g.menuX}, menuTop ${g.menuTop}, rowH ${g.rowH}, menuW ${g.menuW}`);
  return g;
}
const GA = menuGeom(M.aopen, N_OPT, 'aopen');
const GR = menuGeom(M.ropen, 5, 'ropen');
const GC = menuGeom(M.copen, N_OPT, 'copen');
if (!GA || !GR || !GC) {
  console.log(`\nFAILED (${failures}) — no geometry, replay skipped`);
  process.exit(1);
}
check('aopen: the 20-item menu is height-clamped (scrollable)',
      N_OPT * GA.rowH > MAX_MENU_H, `rowH ${GA.rowH}`);

/* strip anchors (page shell geometry, identical on all three pages) */
const belowTop = firstRowOf(M.a0, C.below, 100);
check('a0: the occlusion block is on screen', belowTop > 0, `belowTop ${belowTop}`);
const markY = belowTop + 250 + 20;
const cntY = belowTop + 250 + 40 + 20;
const readY = belowTop + 250 + 80 + 20;
const markAt = (s) => px(s, 210, markY);
const cntAt = (s) => px(s, 210, cntY);

/* occlusion oracle per page */
const occl = (s, g) =>
  countRegion(s, near(C.below), g.menuX, belowTop, g.menuX + g.menuW, g.menuTop + g.menuH);
const baseA = occl(M.a0, GA), baseR = occl(M.r0, GR), baseC = occl(M.c0, GC);
check('baseline occlusion counts are large',
      baseA > 8000 && baseR > 3000 && baseC > 8000,
      `A ${baseA}, R ${baseR}, C ${baseC}`);

/* row sampling and click points */
const bandColOf = (g) => g.sbX - 5;
const rowYOf = (g, k, scroll) => g.menuTop + 1 + k * g.rowH - scroll + 2;
const isBandAt = (s, g, k, scroll) => near(BAND)(px(s, bandColOf(g), rowYOf(g, k, scroll)));
const rowClick = (g, k, scroll) =>
  `wmctl click $K ${g.menuX + 10} ${g.menuTop + 1 + Math.round((k + 0.5) * g.rowH) - scroll}`;
const arrowClick = (g) =>
  `wmctl click $K ${g.menuX + g.menuW - 8} ${g.menuTop + g.menuH - 8}`;
const outsideClick = (g) =>
  `wmctl click $K ${g.menuX + g.menuW + 90} ${g.menuTop + 30}`;

/* survive-leg arithmetic: after six down-arrow clicks (exactly
 * 6*SCROLLBAR_WIDTH = 96px, the 0422-proven oracle) the toggle lands on
 * row PICK, whose band position then encodes the preserved offset */
const SCROLL = 6 * SCROLLBAR_W;
const PICK = 6;
const yPickMid = Math.round((PICK + 0.5) * GA.rowH) - SCROLL;
check('survive: the pick row is inside the scrolled menu',
      yPickMid > 4 && yPickMid < GA.menuH - 4 && PICK * GA.rowH - SCROLL >= 0,
      `yPickMid ${yPickMid}`);

/* append-leg arithmetic: enough arrow clicks to clamp a 21-item range */
const clampClicks = Math.ceil((21 * GC.rowH - MAX_MENU_H) / SCROLLBAR_W) + 2;
/* the appended item (index 20) band row at full clamp:
 * y = menuTop + 1 + 20*rowH - (21*rowH - MAX_MENU_H) */
const appendBandY = GC.menuTop + 1 + MAX_MENU_H - GC.rowH + 2;

/* ---- session 2: the three legs, replayed ---------------------------- */
const legOut = driveBoot([
  /* -- survive -- */
  'netsurf /root/rc/a.html &',
  'wmctl wait win NsRcA 30000',
  sidOf('K', 'NsRcA'),
  ...pollStable('$K', '/root/s0.png'),
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/s0.png'),
  ...pollStable('$K', '/root/sopen.png'),
  'echo shot-sopen-ok',
  ...Array(6).fill(arrowClick(GA)),
  ...pollChange('$K', '/root/sopen.png'),
  ...pollStable('$K', '/root/sscroll.png'),
  'echo shot-sscroll-ok',
  rowClick(GA, PICK, SCROLL),
  ...pollChange('$K', '/root/sscroll.png'),
  ...pollStable('$K', '/root/ssurv.png'),
  'echo shot-ssurv-ok',
  outsideClick(GA),
  ...pollChange('$K', '/root/ssurv.png'),
  ...pollStable('$K', '/root/sdism.png'),
  'echo shot-sdism-ok',
  `wmctl click $K 210 ${readY}`,
  ...pollChange('$K', '/root/sdism.png'),
  ...pollStable('$K', '/root/sread.png'),
  'echo shot-sread-ok',
  'wmctl close $K && wmctl wait gone $K 8000 && echo s-closed',

  /* -- remove -- */
  'netsurf /root/rc/r.html &',
  'wmctl wait win NsRcR 30000',
  sidOf('K', 'NsRcR'),
  ...pollStable('$K', '/root/t0.png'),
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/t0.png'),
  ...pollStable('$K', '/root/topen.png'),
  'echo shot-topen-ok',
  rowClick(GR, 3, 0),
  ...pollChange('$K', '/root/topen.png'),
  ...pollStable('$K', '/root/tsurv.png'),
  'echo shot-tsurv-ok',
  `wmctl click $K 210 ${readY}`,
  ...pollChange('$K', '/root/tsurv.png'),
  ...pollStable('$K', '/root/tread.png'),
  'echo shot-tread-ok',
  'wmctl close $K && wmctl wait gone $K 8000 && echo t-closed',

  /* -- append -- */
  'netsurf /root/rc/c.html &',
  'wmctl wait win NsRcC 30000',
  sidOf('K', 'NsRcC'),
  ...pollStable('$K', '/root/u0.png'),
  'wmctl click $K 12 8',
  ...pollChange('$K', '/root/u0.png'),
  ...pollStable('$K', '/root/uopen.png'),
  'echo shot-uopen-ok',
  rowClick(GC, 1, 0),
  ...pollChange('$K', '/root/uopen.png'),
  ...pollStable('$K', '/root/usurv.png'),
  'echo shot-usurv-ok',
  ...Array(clampClicks).fill(arrowClick(GC)),
  ...pollChange('$K', '/root/usurv.png'),
  ...pollStable('$K', '/root/uclamp.png'),
  'echo shot-uclamp-ok',
  outsideClick(GC),
  ...pollChange('$K', '/root/uclamp.png'),
  ...pollStable('$K', '/root/udism.png'),
  `wmctl click $K 210 ${readY}`,
  ...pollChange('$K', '/root/udism.png'),
  ...pollStable('$K', '/root/uread.png'),
  'echo shot-uread-ok',
  'wmctl close $K && wmctl wait gone $K 8000 && echo u-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['sopen', 'sscroll', 'ssurv', 'sdism', 'sread',
                   'topen', 'tsurv', 'tread',
                   'uopen', 'usurv', 'uclamp', 'uread']) {
  check(`shot ${tag} taken`, legOut.includes(`shot-${tag}-ok`));
}
check('leg windows closed',
      ['s', 't', 'u'].every((t) => legOut.includes(`${t}-closed`)));

const NAMES = ['sopen', 'sscroll', 'ssurv', 'sdism', 'sread',
               'topen', 'tsurv', 'tread',
               'uopen', 'usurv', 'uclamp', 'uread'];
const back2 = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.png`).join(' ') + '\n',
                        { image, encoding: null, maxBuffer: 256 * 1024 * 1024 });
const S = parsePngs(back2.stdout, NAMES);

const OPEN_A = (s) => occl(s, GA) < 300;
const CLOSED_A = (s) => occl(s, GA) > baseA - 300;
const OPEN_R = (s) => occl(s, GR) < 300;
const CLOSED_R = (s) => occl(s, GR) > baseR - 300;
const OPEN_C = (s) => occl(s, GC) < 300;

/* ---- survive --------------------------------------------------------- */
check('survive: menu open with row 0 highlighted',
      OPEN_A(S.sopen) && isBandAt(S.sopen, GA, 0, 0), `below ${occl(S.sopen, GA)}`);
check('survive: six arrow clicks scrolled the open menu',
      OPEN_A(S.sscroll) && !isBandAt(S.sscroll, GA, 0, 0));
check('survive: the mutation really ran (the mark strip flipped)',
      near(C.markon)(markAt(S.ssurv)), `got ${markAt(S.ssurv)}`);
check('survive: the menu is STILL OPEN after the re-conversion',
      OPEN_A(S.ssurv), `below ${occl(S.ssurv, GA)}`);
check('survive: the toggled row is highlighted at its 96px-scrolled place',
      isBandAt(S.ssurv, GA, PICK, SCROLL));
check('survive: the scroll offset survived exactly (no band at the unscrolled place)',
      !isBandAt(S.ssurv, GA, PICK, 0));
check('survive: an outside click still dismisses', CLOSED_A(S.sdism),
      `below ${occl(S.sdism, GA)}`);
check('survive: exactly one change event (the toggle; the write fired none)',
      near(C.cnt1)(cntAt(S.sread)), `got ${cntAt(S.sread)}`);

/* ---- remove ---------------------------------------------------------- */
check('remove: menu open with row 0 highlighted',
      OPEN_R(S.topen) && isBandAt(S.topen, GR, 0, 0), `below ${occl(S.topen, GR)}`);
check('remove: the mutation really ran (the mark strip flipped)',
      near(C.markon)(markAt(S.tsurv)), `got ${markAt(S.tsurv)}`);
check('remove: removing the anchor option DISMISSED the menu',
      CLOSED_R(S.tsurv), `below ${occl(S.tsurv, GR)}`);
check('remove: the dismissal fired NO change event (count is 1)',
      near(C.cnt1)(cntAt(S.tread)), `got ${cntAt(S.tread)}`);

/* ---- append ---------------------------------------------------------- */
check('append: menu open with row 0 highlighted',
      OPEN_C(S.uopen) && isBandAt(S.uopen, GC, 0, 0), `below ${occl(S.uopen, GC)}`);
check('append: the mutation really ran (the mark strip flipped)',
      near(C.markon)(markAt(S.usurv)), `got ${markAt(S.usurv)}`);
check('append: the menu is STILL OPEN after the append',
      OPEN_C(S.usurv), `below ${occl(S.usurv, GC)}`);
check('append: rows 0 and 1 highlighted at scroll 0 (toggle landed, offset kept)',
      isBandAt(S.usurv, GC, 0, 0) && isBandAt(S.usurv, GC, 1, 0));
check('append: scroll-to-clamp shows the appended option\'s band on the bottom row',
      near(BAND)(px(S.uclamp, bandColOf(GC), appendBandY)),
      `at y ${appendBandY}: ${px(S.uclamp, bandColOf(GC), appendBandY)}`);
check('append: the pre-append rows scrolled off (no band at the top row)',
      !isBandAt(S.uclamp, GC, 0, 0));
check('append: exactly one change event', near(C.cnt1)(cntAt(S.uread)),
      `got ${cntAt(S.uread)}`);

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf select-menu re-conversion e2e checks passed');
