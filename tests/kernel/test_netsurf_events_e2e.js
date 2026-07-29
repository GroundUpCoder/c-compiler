#!/usr/bin/env node
// NetSurf's UI event coverage, IN THE OS (todos/0289, NETSURF-JS.md Lane C).
//
// The monkey gate (vendor/netsurf/smoke-js.mjs legs 9-11) proves the event
// surface against the plot stream, including an A/B baseline built with
// -DNETSURF_NO_UI_EVENTS in which the same pages receive nothing.  This
// proves the parts only the real gucOS frontend can speak for, because they
// run through its SDL input map rather than through a test-only command:
//
//   - A REAL press-drag-release paints where the pointer went.  The `paint`
//     demo is loaded unmodified: its opening scene proves the script
//     painted at load, its Clear button (coordinate derived from the
//     demo's own INTERACTIONS table) empties the pad, and the drag is then
//     accounted on the white pad with `wmctl drag`; the ink has
//     to survive SDL -> gucos_mouse_button/motion -> browser_window ->
//     html_mouse_action -> a MouseEvent carrying pageX/pageY -> the page's
//     own rasteriser -> putImageData -> invalidate -> blit.  If the
//     coordinates were absent or wrong the pad would stay scene-only or
//     the ink would land somewhere else, and both are checked.
//   - A REAL key RELEASE reaches the page.  keyup exists only because the
//     frontend now forwards SDL_EVENT_KEY_UP into a new core path
//     (browser_window_key_release); nothing else in the estate exercises
//     that edge.
//   - A CAPTURE-phase listener fires on a real click.
//
// Everything is asserted from pixels: each probe is a slab whose colour a
// listener changes, counted over the window, never a fixed coordinate.
//
// Run: node tests/kernel/test_netsurf_events_e2e.js
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

/* ---- the probe page ------------------------------------------------- */

/* Four canvases, each grey until the event it is named for arrives, then a
 * colour no other one uses.  Counting a colour over the whole window is the
 * assertion: it needs no coordinate to be right, only the event to have
 * happened.
 *
 * They are CANVASES rather than styled <div>s on purpose.  putImageData is
 * this engine's most direct repaint channel (it marks the bitmap modified
 * and redraws the node), so a grey pad means "the event did not arrive"
 * and nothing else — whereas a class-driven restyle would put the CSS
 * re-selection path between the event and the pixels and make a red run
 * ambiguous about which half failed.  This test is about the events. */
const PAD_W = 300;
const PAD_H = 40;
const LIT = {
  down: [0, 200, 0],        /* keydown  */
  up: [0, 0, 200],          /* keyup    */
  cap: [200, 0, 200],       /* a capture-phase click */
  chg: [200, 120, 0],       /* change, on blur after an edit */
};
const PROBE_PAGE = `<html>
<head><title>NsEvents</title>
<style>
body { margin: 0; background: #ffffff; font-size: 16px; }
#i { font-size: 16px; }
canvas { display: block; }
#outer { padding: 10px; }
#inner { width: 200px; height: 40px; background: #c0c0c0; }
</style>
</head>
<body>
<input id="i" type="text" size="20" value="edit">
<canvas id="dn" width="${PAD_W}" height="${PAD_H}"></canvas>
<canvas id="up" width="${PAD_W}" height="${PAD_H}"></canvas>
<canvas id="cap" width="${PAD_W}" height="${PAD_H}"></canvas>
<canvas id="chg" width="${PAD_W}" height="${PAD_H}"></canvas>
<div id="outer"><div id="inner"></div></div>
<script>
function fill(id, r, g, b) {
	var c = document.getElementById(id).getContext('2d');
	var m = c.createImageData(${PAD_W}, ${PAD_H});
	for (var i = 0; i < ${PAD_W} * ${PAD_H} * 4; i += 4) {
		m.data[i] = r; m.data[i + 1] = g; m.data[i + 2] = b;
		m.data[i + 3] = 255;
	}
	c.putImageData(m, 0, 0);
}
fill('dn', 128, 128, 128);
fill('up', 128, 128, 128);
fill('cap', 128, 128, 128);
fill('chg', 128, 128, 128);

var field = document.getElementById('i');
/* On the FIELD, not on document: keydown goes to the focused element now.
 * A listener here never ran before todos/0289 — keydown was dispatched at
 * the document root whatever had focus. */
field.addEventListener('keydown', function () {
	fill('dn', ${LIT.down.join(', ')});
});
/* keyup did not exist at all: nothing told the core a key came up. */
field.addEventListener('keyup', function () {
	fill('up', ${LIT.up.join(', ')});
});
field.addEventListener('change', function () {
	fill('chg', ${LIT.chg.join(', ')});
});
/* CAPTURE on the outer box, for a click whose target is the inner one. */
document.getElementById('outer').addEventListener('click', function (e) {
	if (e.eventPhase === 1) {
		fill('cap', ${LIT.cap.join(', ')});
	}
}, true);
</script>
</body></html>
`;

/* ---- seed boot, then plant the pages -------------------------------- */
const { dir: tmp, image } = freshImage('os-nsevt-');
driveBoot('true', { image });

let PAINT_W = 0;
let PAINT_H = 0;
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
  /* The REAL demo, byte for byte — this leg IS the demo working.  A demo is
   * a FOLDER, so plant the whole thing: planting only the .html would
   * quietly drop the stylesheet that pins the canvas to the document
   * origin, which is the page's one layout assumption. */
  {
    const NSDEMOS = require(path.join(ROOT, 'vendor', 'netsurf', 'demos', 'demos.js'));
    rfs.mkdir('/root/paint', 0o755);
    for (const f of NSDEMOS.demoFiles('paint')) {
      put('/root/paint/' + f.rel, fs.readFileSync(f.abs));
    }
    /* Derive the pad size from the demo's own markup rather than repeating
     * it here: a demo that resizes its canvas must not silently invalidate
     * this test's idea of where the ink can be. */
    const html = fs.readFileSync(NSDEMOS.demo('paint').html, 'utf-8');
    PAINT_W = Number((html.match(/id="pad"[^>]*width="(\d+)"/) || [])[1]);
    PAINT_H = Number((html.match(/id="pad"[^>]*height="(\d+)"/) || [])[1]);
  }
  put('/root/probe.html', Buffer.from(PROBE_PAGE, 'utf-8'));
  rootStore.flush();
  rootStore.close();
}
if (!PAINT_W || !PAINT_H) {
  console.log('  FAIL could not read the paint demo canvas size from its markup');
  process.exit(1);
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
const near = (p, want, tol = 40) =>
  Math.abs(p[0] - want[0]) <= tol &&
  Math.abs(p[1] - want[1]) <= tol &&
  Math.abs(p[2] - want[2]) <= tol;
function countContent(s, pred) {
  let n = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
/* Ink inside a rectangle of the pad: anything that is not the pad's white. */
function inkIn(s, x0, y0, x1, y1) {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(y1, s.h - STATUS_H); y++) {
    for (let x = Math.max(0, x0); x < Math.min(x1, s.w); x++) {
      const p = px(s, x, y);
      if (p[0] < 200 && p[1] < 200 && p[2] < 200) n++;
    }
  }
  return n;
}

/* Repaints with no wmctl-visible marker: poll PIXELS until the frame differs
 * from the reference (bounded condition poll, not a fixed sleep). */
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${ref} || break; sleep 0.1; done`,
];
/* Post-title-barrier settle: shot until two consecutive frames match. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* The stroke: a diagonal well inside the pad, and far enough from the pad's
 * own edges that the brush cannot spill outside it. */
const STROKE = { x0: 40, y0: 30, x1: PAINT_W - 60, y1: PAINT_H - 40 };

/* The pad opens with the demo's generated scene, so the ink accounting
 * below needs the Clear button first.  Its coordinate comes from the
 * demo's own interaction table — the ONE place that layout is spelled. */
const CLEAR_AT = (() => {
  const NSDEMOS = require(path.join(ROOT, 'vendor', 'netsurf', 'demos', 'demos.js'));
  const ph = NSDEMOS.INTERACTIONS.paint.phases.find((p) => p.name === 'clear');
  return ph.do[0].click;
})();

const out = driveBoot([
  /* --- leg 1: a real drag paints where the pointer went --- */
  'netsurf /root/paint/index.html &',
  'wmctl wait win Paint 30000',
  sidOf('PA', 'Paint'),
  ...pollStable('$PA', '/root/p0.ppm'),
  'echo shot-p0-ok',
  /* Clear: scene -> white pad, so ink counting starts from zero.  The
   * click doubles as a liveness step — a dead script clears nothing. */
  `wmctl click $PA ${CLEAR_AT[0]} ${CLEAR_AT[1]}`,
  ...pollChange('$PA', '/root/p0.ppm'),
  ...pollStable('$PA', '/root/p1.ppm'),
  'echo shot-p1-ok',
  `wmctl drag $PA ${STROKE.x0} ${STROKE.y0} ${STROKE.x1} ${STROKE.y1}`,
  ...pollChange('$PA', '/root/p1.ppm'),
  'wmctl shot $PA /root/p2.ppm && echo shot-p2-ok',
  'wmctl close $PA && wmctl wait nowin Paint 8000 && echo paint-closed',

  /* --- leg 2: real key press AND release, capture, change --- */
  'netsurf /root/probe.html &',
  'wmctl wait win NsEvents 30000',
  sidOf('EV', 'NsEvents'),
  ...pollStable('$EV', '/root/e1.ppm'),
  'echo shot-e1-ok',
  /* focus the field, then ONE keystroke: wmctl key sends the down AND the
   * up, so both slabs must light. */
  'wmctl click $EV 40 10',
  `wmctl key $EV 4 97`,
  ...pollChange('$EV', '/root/e1.ppm'),
  ...pollStable('$EV', '/root/e2.ppm'),
  'echo shot-e2-ok',
  /* click the inner box: its CAPTURE listener sits on the outer one, and
   * clicking away from the field also blurs it, which commits `change`. */
  `wmctl click $EV 60 ${4 * PAD_H + 60}`,
  ...pollChange('$EV', '/root/e2.ppm'),
  ...pollStable('$EV', '/root/e3.ppm'),
  'echo shot-e3-ok',
  'wmctl close $EV && wmctl wait nowin NsEvents 8000 && echo probe-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

const NAMES = ['p0', 'p1', 'p2', 'e1', 'e2', 'e3'];
for (const tag of NAMES) {
  check(`shot ${tag} taken`, out.includes(`shot-${tag}-ok`));
}
for (const tag of ['paint', 'probe']) {
  check(`${tag} window closed`, out.includes(`${tag}-closed`));
}
/* NB the gucOS frontend routes console.log to NSLOG, not to stdout, so
 * "did the script run" is asserted from PIXELS below (a blank pad and an
 * unlit probe are what a dead script looks like), never from the log. */

/* --- read the shots back --- */
const back = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.ppm`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 128 * 1024 * 1024 });
const shots = parsePPMs(back.stdout, NAMES);

/* ---- leg 1: the ink -------------------------------------------------- */
{
  const scene = inkIn(shots.p0, 0, 0, PAINT_W, PAINT_H);
  const before = inkIn(shots.p1, 0, 0, PAINT_W, PAINT_H);
  const after = inkIn(shots.p2, 0, 0, PAINT_W, PAINT_H);
  check('the pad opens with the scene (the script painted at load)',
    scene > (PAINT_W * PAINT_H) / 2, `scene ink: ${scene}`);
  check('Clear leaves the pad blank (ink accounting starts from zero)',
    before === 0, `ink before: ${before}`);
  check('a real press-drag-release PAINTED the pad',
    after > 200, `ink after: ${after}`);

  /* …and it painted WHERE the pointer went, which is the whole point of
   * the lane: the coordinates have to arrive, not merely the events.  The
   * stroke runs top-left to bottom-right, so the corners off that diagonal
   * must stay clean. */
  const corner = 40;
  /* If the drag had scrolled the page instead of painting (which is what
   * happens with no mouse events: netsurf turns press-and-move over a
   * non-text box into a page-scroll drag), the heading below the pad would
   * ride up into this region and read as "ink".  The pad's own top-left,
   * BEFORE the stroke starts, is where that would land. */
  const preStroke = inkIn(shots.p2, 0, 0, STROKE.x0 - 12, STROKE.y0 - 12);
  check('the page did NOT scroll under the drag (the pad is still the pad)',
    preStroke === 0, `ink before the stroke start: ${preStroke}`);
  check('and the stroke is a stroke, not a flood',
    after < (PAINT_W * PAINT_H) / 2, `ink after: ${after}`);
  const topRight = inkIn(shots.p2, PAINT_W - corner, 0, PAINT_W, corner);
  const bottomLeft = inkIn(shots.p2, 0, PAINT_H - corner, corner, PAINT_H);
  const onDiagonal = inkIn(shots.p2,
    Math.floor((STROKE.x0 + STROKE.x1) / 2) - 8,
    Math.floor((STROKE.y0 + STROKE.y1) / 2) - 8,
    Math.floor((STROKE.x0 + STROKE.x1) / 2) + 8,
    Math.floor((STROKE.y0 + STROKE.y1) / 2) + 8);
  check('ink landed ON the dragged diagonal', onDiagonal > 50,
    `ink at the stroke midpoint: ${onDiagonal}`);
  check('and NOT in the corners the pointer never visited',
    topRight === 0 && bottomLeft === 0,
    `top-right: ${topRight}, bottom-left: ${bottomLeft}`);
}

/* ---- leg 2: the key, capture and change probes ----------------------- */
{
  const lit = (shot, colour) => countContent(shot, (p) => near(p, colour));
  const MIN = (PAD_W * PAD_H) / 2;

  check('no probe pad is lit before any input',
    lit(shots.e1, LIT.down) < MIN && lit(shots.e1, LIT.up) < MIN &&
    lit(shots.e1, LIT.cap) < MIN && lit(shots.e1, LIT.chg) < MIN,
    `down ${lit(shots.e1, LIT.down)} up ${lit(shots.e1, LIT.up)} ` +
    `cap ${lit(shots.e1, LIT.cap)} chg ${lit(shots.e1, LIT.chg)}`);

  check('a real key press reached the FOCUSED field (keydown)',
    lit(shots.e2, LIT.down) >= MIN, `green pixels: ${lit(shots.e2, LIT.down)}`);
  check('and its RELEASE did too (keyup — a path the core did not have)',
    lit(shots.e2, LIT.up) >= MIN, `blue pixels: ${lit(shots.e2, LIT.up)}`);

  check('a real click ran a CAPTURE-phase listener (eventPhase 1)',
    lit(shots.e3, LIT.cap) >= MIN, `magenta pixels: ${lit(shots.e3, LIT.cap)}`);
  check('and clicking away from the edited field fired `change`',
    lit(shots.e3, LIT.chg) >= MIN, `orange pixels: ${lit(shots.e3, LIT.chg)}`);
}

if (failures === 0) {
  console.log('\ntest_netsurf_events_e2e: PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
console.log(`\ntest_netsurf_events_e2e: FAIL (${failures})`);
console.log(`  image kept at ${tmp}`);
process.exit(1);
