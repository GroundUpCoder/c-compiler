#!/usr/bin/env node
// 0275 acceptance, headless: the LISTBOX built-in WS_VSCROLL bar (the 0210
// EDIT pattern — drawn in the control's own WM_PAINT over a reserved
// gutter), driven through the REAL input path against ctldemo's listbox:
//   - show-when-needed: 3 items -> no bar (well interior stays white at the
//     gutter column); 8 items -> channel/arrows painted (COLOR_SCROLLBAR)
//   - arrows scroll one row, channel clicks page, the thumb DRAGS
//     (`wmctl drag` = down/move/move/up through user32's capture routing)
//   - wheel and keyboard ride the SAME clamp (lb_vscroll), so the thumb can
//     never desync from them — the acceptance's sync requirement
//   - every scroll is verified end-to-end by clicking a VISIBLE row and
//     reading the "ctldemo: sel=N top=M" print: the row hit-test maps
//     through the scrolled view, so sel pins both the view and the mapping
//
// Geometry notes (stock 20px sans, the C2 flag day): lb_row_h = 22 ->
// lb_rows(120px box) = 5; 8 items -> maxTop = 3 (the lb_rows() TRUNCATING
// clamp — a page-down from the top lands exactly there). The listbox rect
// is 12,44 244x120 in ctldemo client coords (no menu bar: client == surface
// coords). Bar gutter: x 238..254; up arrow y 46..62, channel 62..146,
// down arrow 146..162.
//
// Run: node tests/kernel/test_lb_vscroll_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-lbvs-');

const addItem = (n) => [
  `wmctl settext EDIT:0 it${n}`,
  'wmctl click Add',
];

const out = driveBoot([
  'ctldemo &',
  'wmctl wait label Greet 10000',
  'SID=$(wmctl list | grep "Control Demo$" | sed "s/[^0-9].*//")',
  ...[0, 1, 2].flatMap(addItem),
  'wmctl wait text LISTBOX:0 it2 4000',
  'sleep 1',                                     // paint settle before the shot (no repaint marker)
  'wmctl shot $SID /root/s1.png && echo s1-ok',
  ...[3, 4, 5, 6, 7].flatMap(addItem),
  'wmctl wait text LISTBOX:0 it7 4000',
  'sleep 1',                                     // paint settle before the shot (no repaint marker)
  'wmctl shot $SID /root/s2.png && echo s2-ok',
  // down arrow: one row. Row clicks after each step print "sel=N top=M" —
  // input injections serialize through the app's queue, so the print is
  // ordered evidence of the state the click saw.
  'wmctl click $SID 246 154',
  'wmctl click $SID 100 54',                     // first visible row -> sel=1 top=1
  // up arrow: back to the top
  'wmctl click $SID 246 54',
  'wmctl click $SID 100 54',                     // -> sel=0 top=0
  // channel below the thumb: page down, clamped at maxTop=3 (rows=5 > maxTop)
  'wmctl click $SID 246 130',
  'wmctl click $SID 100 54',                     // -> sel=3 top=3
  // thumb drag to the channel top (down/move/move/up on one connection)
  'wmctl drag $SID 246 100 246 40',
  'wmctl click $SID 100 76',                     // second visible row -> sel=1 top=0
  // wheel: one notch down = 3 rows, same clamp
  'wmctl hover $SID 100 100',
  'wmctl wheel $SID -1',
  'wmctl click $SID 100 76',                     // -> sel=4 top=3
  // keys: two UPs walk the caret up; crossing the top edge scrolls the view
  'wmctl key $SID 82 1073741906',                // -> sel=3 top=3
  'wmctl key $SID 82 1073741906',                // -> sel=2 top=2
  'sleep 1',                                     // paint settle before the shot (no repaint marker)
  'wmctl shot $SID /root/s3.png && echo s3-ok',
  // Sub-notch wheel (#346): trackpad events arrive as fractional notches;
  // 0.25 notch = 30/120 wheel units, below the 40-unit (WHEEL_DELTA/3)
  // one-line quantum — a single event must NOT scroll, the accumulated sum
  // must, and the remainder must carry into later events (signed, so
  // opposite-sign motion cancels). State entering: sel=2 top=2, carry 0.
  // LBN_SELCHANGE fires only when sel CHANGES, so the evidence clicks
  // alternate between rows 0 (y54) and 1 (y76) — every click below picks
  // an index different from the previous one and therefore prints.
  'wmctl hover $SID 100 100',
  'wmctl wheel $SID -0.25',                      // carry -30: below quantum
  'wmctl click $SID 100 76',                     // row 1 -> sel=3 top=2 (no move)
  'wmctl wheel $SID -0.25',                      // -60 -> 1 row down, rem -20
  'wmctl click $SID 100 76',                     // row 1 -> sel=4 top=3
  'wmctl wheel $SID 0.25',                       // -20+30=+10: no move either way
  'wmctl click $SID 100 54',                     // row 0 -> sel=3 top=3
  'wmctl wheel $SID 0.25',                       // +40 -> 1 row up, rem 0
  'wmctl click $SID 100 54',                     // row 0 -> sel=2 top=2
  'wmctl wheel $SID 0.25',                       // +30: rem was consumed exactly
  'wmctl click $SID 100 76',                     // row 1 -> sel=3 top=2 (no move)
  'wmctl wheel $SID 0.25',                       // +60 -> 1 row up, rem +20
  'wmctl click $SID 100 54',                     // row 0 -> sel=1 top=1
  'wmctl click Quit',                            // clean exit flushes stdout
  'wmctl wait nolabel Greet 6000',
  '',
].join('\n'), { image, maxBuffer: 64 * 1024 * 1024 }).stdout;

check('all three shots written', out.includes('s1-ok') && out.includes('s2-ok')
  && out.includes('s3-ok'));
check('8 items added', out.includes("ctldemo: added 'it7'"));

/* The ordered sel/top evidence chain: each entry must appear AFTER the
 * previous one (identical pairs can legally repeat across steps — e.g. the
 * key-nav's first print equals the page-down's — so indexOf walks forward
 * instead of counting). */
const seq = [
  ['down arrow scrolls one row', 'ctldemo: sel=1 top=1'],
  ['up arrow scrolls back', 'ctldemo: sel=0 top=0'],
  ['channel click pages, clamped at maxTop (the lb_rows truncation)', 'ctldemo: sel=3 top=3'],
  ['thumb drag to the channel top', 'ctldemo: sel=1 top=0'],
  ['wheel rides the same clamp', 'ctldemo: sel=4 top=3'],
  ['key UP walks the caret in the scrolled view', 'ctldemo: sel=3 top=3'],
  ['key UP across the top edge scrolls the view', 'ctldemo: sel=2 top=2'],
  // Sub-notch wheel (#346) — the six ordered probes above; every click
  // changes sel (rows alternate), so each state below is a fresh print.
  ['sub-notch: one -0.25-notch event cannot scroll', 'ctldemo: sel=3 top=2'],
  ['sub-notch: the second -0.25 crosses the quantum (one row down)', 'ctldemo: sel=4 top=3'],
  ['sub-notch: opposite sign cancels the remainder (no move)', 'ctldemo: sel=3 top=3'],
  ['sub-notch: +0.25 completes the up quantum (one row up)', 'ctldemo: sel=2 top=2'],
  ['sub-notch: an exactly-consumed remainder does not linger', 'ctldemo: sel=3 top=2'],
  ['sub-notch: the +30 remainder carries into the next event', 'ctldemo: sel=1 top=1'],
];
let at = 0;
for (const [name, marker] of seq) {
  const i = out.indexOf(marker, at);
  check(name, i >= 0, `expected "${marker}" after offset ${at}`);
  if (i >= 0) at = i + marker.length;
}

/* ---- pixel legs: extract the shots, probe the gutter ---- */
const b = driveBoot('cat /root/s1.png /root/s2.png /root/s3.png\n',
  { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
const buf = b.stdout;

// One PNG shot out of the concatenated cat-back stream (#657);
// null on a missing/short shot, so the callers' `if (!p)` guards hold.
function parseShot(off) {
  try { return parsePng(buf, off); } catch (e) { return null; }
}
const mkpx = (p) => (x, y) => {
  const i = (y * p.w + x) * 4;
  return [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2]];
};
const gray = (px) => px[0] === 0xC0 && px[1] === 0xC0 && px[2] === 0xC0;
const white = (px) => px[0] === 0xFF && px[1] === 0xFF && px[2] === 0xFF;

const p1 = parseShot(0);
check('shot1 parses as PNG', p1 !== null, buf.slice(0, 16).toString('latin1'));
if (p1) {
  const px = mkpx(p1);
  check('3 items: no bar — gutter column is the white well interior',
    white(px(246, 100)) && white(px(246, 54)), `${px(246, 100)} ${px(246, 54)}`);
}
const p2 = p1 && parseShot(p1.next);
check('shot2 parses as PNG', p2 !== null && p2 !== undefined);
if (p2) {
  const px = mkpx(p2);
  /* top=0: thumb spans y 62..114 (btnface), channel 114..146 (scrollbar
   * color) — both 0xC0C0C0 flat; the arrows carry black sb_tri ink. */
  check('8 items: bar painted — thumb/channel gray at the gutter column',
    gray(px(246, 100)) && gray(px(246, 130)), `${px(246, 100)} ${px(246, 130)}`);
  check('up-arrow triangle ink present', (() => {
    for (let y = 48; y < 62; y++) if (px(246, y)[0] < 0x40) return true;
    return false;
  })());
  check('rows narrowed to the gutter, well edge intact', white(px(234, 100)),
    `${px(234, 100)}`);
}
const p3 = p2 && parseShot(p2.next);
check('shot3 parses as PNG', p3 !== null && p3 !== undefined);
if (p3) {
  const px = mkpx(p3);
  /* top=2 after the key nav: thumbY = 18 + 32*2/3 = 39 lb-local -> client
   * y 83; the thumb's raised top bevel is the first WHITE row below the up
   * arrow. Scanning pins the thumb POSITION to the key-driven top — the
   * "wheel/keys stay in sync with the thumb" acceptance, in pixels. */
  let bevel = -1;
  for (let y = 66; y < 146 && bevel < 0; y++)
    if (white(px(246, y))) bevel = y;
  check('thumb tracks the key-scrolled view (top bevel near y=83)',
    bevel >= 79 && bevel <= 87, `bevel=${bevel}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
