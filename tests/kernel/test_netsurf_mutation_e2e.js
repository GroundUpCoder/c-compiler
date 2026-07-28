#!/usr/bin/env node
// NetSurf's mutation -> re-box -> reflow -> repaint bridge, IN THE OS
// (todos/NETSURF-JS.md Lane B).  The monkey gate
// (vendor/netsurf/smoke-js.mjs legs 6-8) proves the bridge against the plot
// stream, including an A/B baseline with the bridge compiled out; this
// proves the three things only the real gucOS frontend can speak for:
//
//   - a timer-driven `textContent` write reaches REAL PIXELS.  demos/
//     pages/stopwatch/ is loaded unmodified and nothing is typed or clicked:
//     the only thing that can change the screen is the page's own
//     setInterval, and the change has to survive re-box -> reflow ->
//     invalidate -> damage -> blit to be visible at all.
//   - a real SDL pointer click driving createElement/appendChild and
//     removeChild paints and unpaints a block.
//   - SCROLL POSITION SURVIVES A RE-CONVERSION.  The spike only code-read
//     this ("frontend-owned, document-relative, preserved by construction")
//     and explicitly deferred the live check to this lane.  Here the scroll
//     offset is DECODED FROM THE PIXELS either side of a reconvert and the
//     two must be equal — and non-zero, or the check would be vacuous.
//   - TYPING AND FOCUS SURVIVE RE-CONVERSION (todos/0386, todos/0402).
//     The static/ticky A/B asserts EXACT settled-ink equality, and the
//     forced-window arms (a 3000-element page whose re-conversion window
//     spans the whole tick period) prove no keystroke and no click is
//     lost even when the page is mid-re-box essentially always.  Every
//     gating shot is a SETTLED one (the pages' ticks are finite): an
//     un-settled sample can catch a mid-window render (the recreated
//     widget draws pre-layout until the swap's reformat) and is printed
//     as a diagnostic only.
//
// Pixel probes are colour counts and colour-coded block boundaries, never
// fixed screen coordinates for assertions: the one clicked coordinate
// (200,50) is a purpose-built block whose geometry the page itself pins,
// the test_netsurf_js_e2e convention.
//
// Run: node tests/kernel/test_netsurf_mutation_e2e.js
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
/* must match gucos/gui.c SCROLL_STEP */
const SCROLL_STEP = 100;

/* ---- the two purpose-built pages ---- */

/* A ruler: 50 solid blocks of BLOCK_H px whose colour ENCODES their index,
 * so any screenshot can be decoded back to an exact scroll offset (find a
 * colour boundary, and the document y of that boundary is known).  One
 * green block in the middle is the only thing that ever changes: a timer
 * rewrites its text, which re-boxes the whole document.  If a re-conversion
 * disturbed the scroll offset, every block boundary would move. */
const BLOCK_H = 40;
const NBLOCK = 50;
const TICK_AT = 20;           /* the mutating block sits after this many */
const blockColour = (i) => [4 * i, 0, 200];
function rulerPage() {
  const rows = [];
  for (let i = 0; i < NBLOCK; i++) {
    if (i === TICK_AT) {
      rows.push('<div id="tick" class="tick">tick 0</div>');
    }
    const [r, g, b] = blockColour(i);
    rows.push(`<div class="b" style="background: rgb(${r}, ${g}, ${b})"></div>`);
  }
  return `<html>
<head><title>NsRuler</title>
<style>
body { margin: 0; background: #ffffff; }
.b { height: ${BLOCK_H}px; }
.tick { height: ${BLOCK_H}px; background: #00ff00; color: #000000; font-size: 20px; }
</style>
</head>
<body>
${rows.join('\n')}
<script>
var tickBox = document.getElementById('tick');
var n = 0;
setInterval(function () {
	n = n + 1;
	/* the whole-document re-box under test, fired with no user input */
	tickBox.textContent = 'tick ' + n;
}, 200);
console.log('ruler ready');
</script>
</body></html>
`;
}

/* A click target of pinned geometry whose DOM listener TOGGLES a created
 * element in and out of the document.  Red pixels appearing (then
 * vanishing) is the whole assertion: real SDL click -> JS -> createElement/
 * appendChild -> re-box -> repaint, and back again via removeChild. */
const TOGGLE_PAGE = `<html>
<head><title>NsToggle</title>
<style>
body { margin: 0; background: #ffffff; }
#hit { width: 400px; height: 100px; background: #0000ff; }
.slab { width: 400px; height: 100px; background: #ff0000; }
</style>
</head>
<body>
<div id="hit"></div>
<div id="tray"></div>
<script>
var tray = document.getElementById('tray');
document.getElementById('hit').addEventListener('click', function () {
	if (tray.firstChild) {
		tray.removeChild(tray.firstChild);
		console.log('toggle off');
	} else {
		var slab = document.createElement('div');
		slab.className = 'slab';
		tray.appendChild(slab);
		console.log('toggle on');
	}
});
</script>
</body></html>
`;

/* A text field plus — optionally — a timer that mutates an unrelated
 * element.  Typing the same string into both is an A/B for the ONE piece
 * of interaction state that points into the box tree and is not obviously
 * anyone else's job: the focus owner.  Without re-binding it, the first
 * re-conversion silently steals the caret and every later keystroke is
 * dropped; the static page then out-types the ticking one. */
const typingPage = (ticking) => `<html>
<head><title>${ticking ? 'NsTicky' : 'NsStatic'}</title>
<style>body { margin: 0; background: #ffffff; } #i { font-size: 20px; }</style>
</head>
<body>
<input id="i" type="text" size="20" value="">
<div id="d">tick 0</div>
<script>
${ticking ? `var n = 0;
var box = document.getElementById('d');
var tick = setInterval(function () {
	n = n + 1;
	box.textContent = 'tick ' + n;
	/* FINITE (todos/0386): typing overlaps ticks 1..~15, then the page
	 * really settles, so the leg can assert its exact final state — an
	 * everlasting tick would leave every shot un-barrierable (a shot
	 * can land inside a re-conversion window, where the field renders
	 * the recreated widget's pre-layout state). */
	if (n >= 25) clearInterval(tick);
}, 300);` : ''}
console.log('typing page ready');
</script>
</body></html>
`;

/* 0386 D2: the same typing page with n 1-px filler divs appended AFTER
 * <div id="d"> (the input's geometry — and so the §1 ink budget — is
 * untouched).  convert_xml_to_box yields to the scheduler every 10
 * elements and each yield costs a loop iteration, so n=3000 widens the
 * live re-conversion window to ~the whole tick period: the page is
 * continuously mid-re-conversion while ticking.  The tick starts DELAYED
 * (3 s) so a leg can focus the field on a quiet page first.  periodMs=0
 * means no timer at all (the size control). */
const typingPageBig = (title, n, periodMs) => `<html>
<head><title>${title}</title>
<style>body { margin: 0; background: #ffffff; } #i { font-size: 20px; } .p { height: 1px; }</style>
</head>
<body>
<input id="i" type="text" size="20" value="">
<div id="d">tick 0</div>
<div id="me" style="color: #007700;"></div>
<div id="mp" style="color: #0000cc;"></div>
${'<div class="p"></div>\n'.repeat(n)}<script>
var fld = document.getElementById('i');
var mirE = document.getElementById('me');
var mirP = document.getElementById('mp');
/* Two VALUE mirrors, both over the proven textContent bridge and told
 * apart by text colour (decoded by full-frame colour count, so no
 * geometry assumptions):  mirE echoes the field on every 'input' event;
 * mirP is an event-independent poller (guarded, so an unchanged value
 * causes no mutation).  The poller stops with the tick so the page has
 * a true settled state. */
fld.addEventListener('input', function () {
	mirE.textContent = 'V:' + fld.value;
});
var polls = 0;
var poller = setInterval(function () {
	var v = 'V:' + fld.value;
	if (mirP.textContent !== v) mirP.textContent = v;
	polls = polls + 1;
	if (polls >= 60) clearInterval(poller);
}, 200);
${periodMs ? `var n = 0;
var box = document.getElementById('d');
setTimeout(function () {
	var tick = setInterval(function () {
		n = n + 1;
		box.textContent = 'tick ' + n;
		/* finite: the page must eventually settle so the leg can
		 * assert its true final state */
		if (n >= 25) clearInterval(tick);
	}, ${periodMs});
}, 3000);` : ''}
console.log('big page ready');
</script>
</body></html>
`;

/* ---- seed boot, then plant the pages ---- */
const { dir: tmp, image } = freshImage('os-nsmut-');
driveBoot('true', { image });

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
  /* the REAL demo, byte for byte — this leg is the demo working.  A demo is
   * a FOLDER (markup + its own stylesheet + its own script), so plant the
   * whole thing: planting only the .html would quietly drop both
   * subresources and test a differently-shaped page. */
  {
    const NSDEMOS = require(path.join(ROOT, 'vendor', 'netsurf', 'demos', 'demos.js'));
    rfs.mkdir('/root/stopwatch', 0o755);
    for (const f of NSDEMOS.demoFiles('stopwatch')) {
      put('/root/stopwatch/' + f.rel, fs.readFileSync(f.abs));
    }
  }
  put('/root/ruler.html', Buffer.from(rulerPage(), 'utf-8'));
  put('/root/toggle.html', Buffer.from(TOGGLE_PAGE, 'utf-8'));
  put('/root/static.html', Buffer.from(typingPage(false), 'utf-8'));
  put('/root/ticky.html', Buffer.from(typingPage(true), 'utf-8'));
  put('/root/big-t.html', Buffer.from(typingPageBig('NsBigT', 3000, 300), 'utf-8'));
  put('/root/big-c1.html', Buffer.from(typingPageBig('NsBigC1', 3000, 0), 'utf-8'));
  put('/root/big-c2.html', Buffer.from(typingPageBig('NsBigC2', 3000, 5000), 'utf-8'));
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
const isRed = (p) => p[0] > 180 && p[1] < 80 && p[2] < 80;
function countContent(s, pred) {
  let n = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
/* Which content ROWS differ at all, and by how many pixels in total. */
function diffRows(a, b) {
  const rows = [];
  let total = 0;
  for (let y = 0; y < a.h - STATUS_H; y++) {
    let n = 0;
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 3;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]) n++;
    }
    if (n > 0) { rows.push(y); total += n; }
  }
  return { rows, total };
}

/* Decode the ruler page's scroll offset out of a screenshot.  Sample the
 * far-right column (the blocks are full width; their text, if any, is at
 * the left), find the first boundary between block i and block i+1, and the
 * document y of that boundary is known exactly: (i+1) * BLOCK_H.  Returns
 * null if no boundary is legible. */
function rulerScroll(s) {
  const x = s.w - 4;
  const idxAt = (y) => {
    const p = px(s, x, y);
    if (p[1] !== 0 || p[2] !== 200 || p[0] % 4 !== 0) return null;   /* not a ruler block */
    const i = p[0] / 4;
    return (i >= 0 && i < NBLOCK) ? i : null;
  };
  const contentH = s.h - STATUS_H;
  let prev = idxAt(0);
  for (let y = 1; y < contentH; y++) {
    const cur = idxAt(y);
    if (prev !== null && cur !== null && cur === prev + 1) {
      /* screen row y is the TOP of block `cur`; the tick block sits before
       * block TICK_AT and displaces it and everything after it by one
       * block height */
      const docY = cur * BLOCK_H + (cur >= TICK_AT ? BLOCK_H : 0);
      return docY - y;
    }
    prev = cur;
  }
  return null;
}

/* Post-title-barrier settle: shot until two consecutive frames match.  Only
 * for pages that DO settle. */
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

/* Type "abcdef" a key at a time, slowly enough that the ticking page gets
 * several re-conversions in between — that is the point of the leg.  [USB
 * HID scancode, ASCII keysym]. */
const TYPED = [[4, 97], [5, 98], [6, 99], [7, 100], [8, 101], [9, 102]];
const TYPE_KEYS = (sid) => TYPED.map(([sc, ks]) => `wmctl key ${sid} ${sc} ${ks}; sleep 0.25`);

/* ---- session A: drive all three pages ---- */
const SCROLL_NOTCHES = 7;   /* 7 * SCROLL_STEP = 700px down the ruler */

const out = driveBoot([
  /* --- leg 1: the real stopwatch demo, no input at all --- */
  'netsurf /root/stopwatch/index.html &',
  'wmctl wait win Stopwatch 30000',
  sidOf('SW', 'Stopwatch'),
  'wmctl shot $SW /root/m1.ppm && echo shot-m1-ok',
  ...pollChange('$SW', '/root/m1.ppm'),
  'wmctl shot $SW /root/m2.ppm && echo shot-m2-ok',
  'wmctl close $SW && wmctl wait nowin Stopwatch 8000 && echo stopwatch-closed',

  /* --- leg 2: scroll survives a re-conversion --- */
  'netsurf /root/ruler.html &',
  'wmctl wait win NsRuler 30000',
  sidOf('RU', 'NsRuler'),
  'wmctl shot $RU /root/r1.ppm && echo shot-r1-ok',
  `wmctl wheel $RU -${SCROLL_NOTCHES}`,
  ...pollChange('$RU', '/root/r1.ppm'),
  /* r2 is the scrolled reference.  The tick timer is still running, so the
   * NEXT differing frame is a re-conversion landing on top of that scroll. */
  'wmctl shot $RU /root/r2.ppm && echo shot-r2-ok',
  ...pollChange('$RU', '/root/r2.ppm'),
  'wmctl shot $RU /root/r3.ppm && echo shot-r3-ok',
  ...pollChange('$RU', '/root/r3.ppm'),
  'wmctl shot $RU /root/r4.ppm && echo shot-r4-ok',
  'wmctl close $RU && wmctl wait nowin NsRuler 8000 && echo ruler-closed',

  /* --- leg 3: a real click inserting and removing an element --- */
  'netsurf /root/toggle.html &',
  'wmctl wait win NsToggle 30000',
  sidOf('TG', 'NsToggle'),
  ...pollStable('$TG', '/root/t1.ppm'),
  'echo shot-t1-ok',
  'wmctl click $TG 200 50',
  ...pollChange('$TG', '/root/t1.ppm'),
  'wmctl shot $TG /root/t2.ppm && echo shot-t2-ok',
  'wmctl click $TG 200 50',
  ...pollChange('$TG', '/root/t2.ppm'),
  'wmctl shot $TG /root/t3.ppm && echo shot-t3-ok',
  'wmctl close $TG && wmctl wait nowin NsToggle 8000 && echo toggle-closed',

  /* --- leg 4: typing survives re-conversion (static control vs ticking) --- */
  'netsurf /root/static.html &',
  'wmctl wait win NsStatic 30000',
  sidOf('ST', 'NsStatic'),
  ...pollStable('$ST', '/root/x0.ppm'),
  'wmctl click $ST 60 12',        /* focus the field (its own pinned geometry) */
  /* 0386 D3: shot after each key — the six deltas are the per-glyph ink
   * table that retro-explains any missing-glyph count */
  ...TYPED.flatMap(([sc, ks], i) =>
    [`wmctl key $ST ${sc} ${ks}; sleep 0.25`,
     `wmctl shot $ST /root/s${i + 1}.ppm && echo shot-s${i + 1}-ok`]),
  ...pollStable('$ST', '/root/x1.ppm'),
  'echo shot-x1-ok',
  'wmctl close $ST && wmctl wait nowin NsStatic 8000 && echo static-closed',

  'netsurf /root/ticky.html &',
  'wmctl wait win NsTicky 30000',
  sidOf('TK', 'NsTicky'),
  'wmctl click $TK 60 12',
  /* D3 on the ticky leg: the step that fails to grow names the lost key */
  ...TYPED.flatMap(([sc, ks], i) =>
    [`wmctl key $TK ${sc} ${ks}; sleep 0.25`,
     `wmctl shot $TK /root/k${i + 1}.ppm && echo shot-k${i + 1}-ok`]),
  'wmctl shot $TK /root/x2.ppm && echo shot-x2-ok',
  /* the SETTLED shot: past the finite tick's end (25 x 300 ms), so the
   * page has genuinely stopped re-boxing and the field shows its true
   * final state.  x2 (immediate) stays diagnostic-only: an un-barriered
   * sample can catch a mid-window render and must not gate. */
  'sleep 6',
  'wmctl shot $TK /root/x3.ppm && echo shot-x3-ok',
  'wmctl close $TK && wmctl wait nowin NsTicky 8000 && echo ticky-closed',

  /* --- 0386 D4: the direct M2 probe — same small ticky page, 20 ms key
   * cadence.  If ink drops here, the leg genuinely samples before the
   * paint lands; if not, M2 needs a 250 ms paint lag to be true. --- */
  'netsurf /root/ticky.html &',
  'wmctl wait win NsTicky 30000',
  sidOf('TF', 'NsTicky'),
  'wmctl click $TF 60 12',
  ...TYPED.map(([sc, ks]) => `wmctl key $TF ${sc} ${ks}; sleep 0.02`),
  'wmctl shot $TF /root/x4.ppm && echo shot-x4-ok',
  'sleep 8',                      /* past the finite tick's end */
  'wmctl shot $TF /root/x5.ppm && echo shot-x5-ok',
  'wmctl close $TF && wmctl wait nowin NsTicky 8000 && echo tickyfast-closed',

  /* --- 0386 D2 arm T: focus FIRST (page still quiet — the tick starts at
   * +3 s), then type WHILE the wide re-conversion window is open ~100% of
   * the time.  M1 real ⇒ ink collapses toward 52; M1 wrong ⇒ 285. --- */
  'netsurf /root/big-t.html &',
  'wmctl wait win NsBigT 30000',
  'sleep 1.5',
  sidOf('BT', 'NsBigT'),
  'wmctl click $BT 60 12',
  'sleep 2',                      /* ticking is now underway */
  ...TYPED.flatMap(([sc, ks], i) =>
    [`wmctl key $BT ${sc} ${ks}; sleep 0.25`,
     `wmctl shot $BT /root/tk${i + 1}.ppm && echo shot-tk${i + 1}-ok`]),
  'wmctl shot $BT /root/bt1.ppm && echo shot-bt1-ok',
  'sleep 6',                      /* past the finite tick's end: TRUE settle */
  'wmctl shot $BT /root/bt2.ppm && echo shot-bt2-ok',
  'wmctl close $BT && wmctl wait nowin NsBigT 8000 && echo bigt-closed',

  /* --- D2 arm T2 (the todos/0402 shape): the CLICK itself lands mid
   * re-conversion, with nothing previously focused, then typing. --- */
  'netsurf /root/big-t.html &',
  'wmctl wait win NsBigT 30000',
  'sleep 4',                      /* ticking underway before the click */
  sidOf('BU', 'NsBigT'),
  'wmctl click $BU 60 12',
  ...TYPE_KEYS('$BU'),
  'wmctl shot $BU /root/bu1.ppm && echo shot-bu1-ok',
  'sleep 6',                      /* past the finite tick's end: TRUE settle */
  'wmctl shot $BU /root/bu2.ppm && echo shot-bu2-ok',
  'wmctl close $BU && wmctl wait nowin NsBigT 8000 && echo bigt2-closed',

  /* --- D2 arm C1 (size control): same 3000-element page, NO timer. --- */
  'netsurf /root/big-c1.html &',
  'wmctl wait win NsBigC1 30000',
  'sleep 1.5',
  sidOf('BC', 'NsBigC1'),
  'wmctl click $BC 60 12',
  ...TYPE_KEYS('$BC'),
  'wmctl shot $BC /root/bc11.ppm && echo shot-bc11-ok',
  'sleep 2',
  'wmctl shot $BC /root/bc12.ppm && echo shot-bc12-ok',
  'wmctl close $BC && wmctl wait nowin NsBigC1 8000 && echo bigc1-closed',

  /* --- D2 arm C2 (period control): first tick at +8 s, typing done by
   * ~+5.5 s, so the timer exists but never fires during typing. --- */
  'netsurf /root/big-c2.html &',
  'wmctl wait win NsBigC2 30000',
  'sleep 1.5',
  sidOf('BD', 'NsBigC2'),
  'wmctl click $BD 60 12',
  'sleep 2',
  ...TYPE_KEYS('$BD'),
  'wmctl shot $BD /root/bc21.ppm && echo shot-bc21-ok',
  /* the settled shot must land BETWEEN tick 1 (+8 s from load) and tick
   * 2 (+13 s): after the one post-typing re-conversion completes, before
   * the next opens a window */
  'sleep 4.5',
  'wmctl shot $BD /root/bc22.ppm && echo shot-bc22-ok',
  'wmctl close $BD && wmctl wait nowin NsBigC2 8000 && echo bigc2-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

const NAMES = ['m1', 'm2', 'r1', 'r2', 'r3', 'r4', 't1', 't2', 't3',
               's1', 's2', 's3', 's4', 's5', 's6', 'x1',
               'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'x2', 'x3',
               'x4', 'x5',
               'tk1', 'tk2', 'tk3', 'tk4', 'tk5', 'tk6',
               'bt1', 'bt2', 'bu1', 'bu2', 'bc11', 'bc12', 'bc21', 'bc22'];
for (const tag of NAMES) {
  check(`shot ${tag} taken`, out.includes(`shot-${tag}-ok`));
}
for (const tag of ['stopwatch', 'ruler', 'toggle', 'static', 'ticky',
                   'tickyfast', 'bigt', 'bigt2', 'bigc1', 'bigc2']) {
  check(`${tag} window closed`, out.includes(`${tag}-closed`));
}

/* ---- session B: read the shots back ---- */
const back = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.ppm`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 128 * 1024 * 1024 });
const shots = parsePPMs(back.stdout, NAMES);

/* --- leg 1: a timer-driven textContent write reaches real pixels --- */
{
  const d = diffRows(shots.m1, shots.m2);
  check('stopwatch: the screen CHANGED with zero user input',
        d.total > 0, `pixels changed: ${d.total}`);
  /* The readout is the only mutating element, and it is one line of a
   * 2.6em block — so the change must be confined to a single contiguous
   * band.  A whole-page difference would mean something else moved. */
  const span = d.rows.length ? d.rows[d.rows.length - 1] - d.rows[0] + 1 : 0;
  check('stopwatch: the change is confined to the readout band',
        d.rows.length > 0 && span <= 80,
        `rows ${d.rows[0]}..${d.rows[d.rows.length - 1]} (span ${span}px, ${d.rows.length} rows)`);
}

/* --- leg 2: the scroll offset survives re-conversion --- */
{
  const s1 = rulerScroll(shots.r1);
  const s2 = rulerScroll(shots.r2);
  const s3 = rulerScroll(shots.r3);
  const s4 = rulerScroll(shots.r4);
  check('ruler: the unscrolled page decodes to offset 0', s1 === 0, `decoded: ${s1}`);
  check('ruler: the wheel really scrolled',
        s2 === SCROLL_NOTCHES * SCROLL_STEP,
        `decoded: ${s2} (wanted ${SCROLL_NOTCHES * SCROLL_STEP})`);
  /* THE Lane B check the spike deferred: r3 and r4 are frames taken after
   * re-conversions landed on top of that scroll. */
  check('ruler: scroll offset SURVIVED a re-conversion', s3 === s2,
        `before ${s2}, after ${s3}`);
  check('ruler: and survives a second one', s4 === s2,
        `before ${s2}, after ${s4}`);
  check('ruler: the check is not vacuous (the page really was scrolled)',
        s2 !== null && s2 > 0, `offset: ${s2}`);

  /* ...and the re-conversions really did repaint, confined to the one
   * mutating block — otherwise "the offset did not move" could just mean
   * nothing happened at all. */
  const d = diffRows(shots.r2, shots.r3);
  const span = d.rows.length ? d.rows[d.rows.length - 1] - d.rows[0] + 1 : 0;
  check('ruler: a re-conversion DID repaint', d.total > 0, `pixels changed: ${d.total}`);
  check('ruler: and only inside the one mutating block',
        d.rows.length > 0 && span <= BLOCK_H,
        `rows ${d.rows[0]}..${d.rows[d.rows.length - 1]} (span ${span}px, block is ${BLOCK_H}px)`);
}

/* --- leg 3: click -> createElement/appendChild -> repaint, and back --- */
{
  const r1 = countContent(shots.t1, isRed);
  const r2 = countContent(shots.t2, isRed);
  const r3 = countContent(shots.t3, isRed);
  check('toggle: nothing red before the click', r1 < 200, `red pixels: ${r1}`);
  check('toggle: a real SDL click INSERTED a visible element',
        r2 > 35000, `red pixels after the click: ${r2} (the slab is 400x100 = 40000)`);
  check('toggle: a second click REMOVED it again', r3 < 200,
        `red pixels after the second click: ${r3}`);
}

/* --- leg 4: focus + caret survive re-conversion --- */
{
  /* Dark ink inside the text field's own band: six typed glyphs make a
   * characteristic amount of it, and a page that dropped its keystrokes
   * makes almost none. */
  const fieldInk = (s) => {
    let n = 0;
    for (let y = 2; y < 28; y++) {
      for (let x = 0; x < Math.min(s.w, 260); x++) {
        const p = px(s, x, y);
        if (p[0] < 100 && p[1] < 100 && p[2] < 100) n++;
      }
    }
    return n;
  };
  const staticInk = fieldInk(shots.x1);
  const tickyInk = fieldInk(shots.x2);
  check('typing: the static control page really accepted the keystrokes',
        staticInk > 150, `ink in the field: ${staticInk}`);

  /* ---- regression readout (todos/0386): every number printed unconditionally ---- */
  const inks = (tags) => tags.map((t) => fieldInk(shots[t]));
  const sSteps = inks(['s1', 's2', 's3', 's4', 's5', 's6']);
  const kSteps = inks(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
  console.log('D3-STATIC per-key ink: ' + sSteps.join(' ') +
              '  (deltas: ' + sSteps.map((v, i) => v - (i ? sSteps[i - 1] : 52)).join(' ') + ')');
  console.log('D3-TICKY  per-key ink: ' + kSteps.join(' ') +
              '  (deltas: ' + kSteps.map((v, i) => v - (i ? kSteps[i - 1] : 52)).join(' ') + ')');
  console.log(`D1-TICKY x2(immediate)=${tickyInk} x3(settled)=${fieldInk(shots.x3)} static=${staticInk}`);
  console.log(`D4-FAST20MS x4(immediate)=${fieldInk(shots.x4)} x5(settled)=${fieldInk(shots.x5)}`);
  /* Value-level decode for the big pages: the two textContent mirrors,
   * told apart by text colour and counted over the whole frame.  Equal
   * counts across arms mean equal mirrored VALUES (same string, same
   * font, same renderer). */
  const mirEInk = (tag) => countContent(shots[tag],
    (p) => p[0] < 60 && p[1] > 90 && p[1] < 180 && p[2] < 60);
  const mirPInk = (tag) => countContent(shots[tag],
    (p) => p[0] < 80 && p[1] < 80 && p[2] > 150);
  const vprobe = (tag) => `mirE=${mirEInk(tag)} mirP=${mirPInk(tag)}`;
  console.log('D3-BIGT per-key ink: ' + inks(['tk1', 'tk2', 'tk3', 'tk4', 'tk5', 'tk6']).join(' '));
  console.log(`D2-T   immediate=${fieldInk(shots.bt1)} settled=${fieldInk(shots.bt2)} value[${vprobe('bt2')}]`);
  console.log(`D2-T2  immediate=${fieldInk(shots.bu1)} settled=${fieldInk(shots.bu2)} value[${vprobe('bu2')}] (click landed mid-ticking, todos/0402 shape)`);
  console.log(`D2-C1  immediate=${fieldInk(shots.bc11)} settled=${fieldInk(shots.bc12)} value[${vprobe('bc12')}] (size control, no timer)`);
  console.log(`D2-C2  immediate=${fieldInk(shots.bc21)} settled=${fieldInk(shots.bc22)} value[${vprobe('bc22')}] (period control, 5 s)`);

  /* The A/B: a mutating page must type EXACTLY as well as a still one —
   * asserted on the SETTLED shot at EXACT equality (todos/0386).  The old
   * `>= staticInk * 0.9` slack silently accepted a dropped x-height
   * keystroke; the deterministic answer is byte-identical fields, so the
   * tolerance is gone, not widened.  Before focus survived the swap this
   * read 52-234 vs 285. */
  check('typing: a page re-boxing under the caret types just as well',
        fieldInk(shots.x3) === staticInk,
        `static ${staticInk} vs ticking settled ${fieldInk(shots.x3)} (immediate ${tickyInk}) ink pixels`);
  check('typing: 20ms-cadence typing on the ticking page loses nothing',
        fieldInk(shots.x5) === staticInk,
        `static ${staticInk} vs fast-typed settled ${fieldInk(shots.x5)} ink pixels`);

  /* The forced-window arms (todos/0386 D2): a 3000-element page whose
   * re-conversion window spans ~the whole tick period.  Typing DURING
   * continuous re-boxing (T), and clicking INTO the storm with nothing
   * previously focused first (T2 — the todos/0402 regression: pre-fix
   * both read 52 = every key swallowed).  C1/C2 are the size-only and
   * period-only controls. */
  check('typing: forced-wide window (T) types exactly as well as static',
        fieldInk(shots.bt2) === staticInk,
        `static ${staticInk} vs T settled ${fieldInk(shots.bt2)} ink pixels`);
  check('typing: click mid-re-conversion keeps its focus (T2, todos/0402)',
        fieldInk(shots.bu2) === staticInk,
        `static ${staticInk} vs T2 settled ${fieldInk(shots.bu2)} ink pixels`);
  check('typing: size control (C1) unaffected',
        fieldInk(shots.bc12) === staticInk,
        `static ${staticInk} vs C1 settled ${fieldInk(shots.bc12)} ink pixels`);
  check('typing: period control (C2) unaffected',
        fieldInk(shots.bc22) === staticInk,
        `static ${staticInk} vs C2 settled ${fieldInk(shots.bc22)} ink pixels`);

  /* Value-level closure: both mirrors on every big arm must equal the
   * known-good C1's — same count = same mirrored string — and C1's must
   * be non-empty or the whole comparison is vacuous. */
  check('typing: C1 mirrors are non-vacuous',
        mirEInk('bc12') > 100 && mirPInk('bc12') > 100,
        `mirE=${mirEInk('bc12')} mirP=${mirPInk('bc12')}`);
  for (const [tag, name] of [['bt2', 'T'], ['bu2', 'T2'], ['bc22', 'C2']]) {
    check(`typing: ${name} mirrored VALUE equals the control's`,
          mirEInk(tag) === mirEInk('bc12') && mirPInk(tag) === mirPInk('bc12'),
          `mirE ${mirEInk(tag)} vs ${mirEInk('bc12')}, mirP ${mirPInk(tag)} vs ${mirPInk('bc12')}`);
  }
}

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf mutation-bridge e2e checks passed');
