#!/usr/bin/env node
// todos/0427 (P0) — a held button must not report as released before the
// motion clears DRAG_SLOP.
//
// gucos_mouse_state() computed the HOLDING_* bits INSIDE `if (gw->dragging)`,
// so they were gated on the DRAG_SLOP (5 px) promotion even though they
// describe `mouse_pressed`.  gucos_mouse_motion() ends with an unconditional
// browser_window_mouse_track(), so a press followed by a 1-5 px move handed
// the core a track with NO buttons held — and a track with nothing held after
// a press is exactly how html_fire_mouse_events synthesises a DOM `mouseup`
// (interaction.c).  Every drag on every page died inside the first 5 px: the
// paint demo's `drawing` flag dropped at the spurious up, and the whole
// stroke collapsed to the single mousedown dab.
//
// 🔴 Why this test lives HERE and not in smoke-js.mjs: smoke-js drives
// nsmonkey.wasm, the MONKEY frontend, which never executes gucos/gui.c.  Its
// drag() helper also jumps straight into the dragging state (PRESS -> DRAG ->
// TRACK(DRAG_ON|HOLDING)) and never exercises the sub-slop window.  Only an
// in-OS boot driving real SDL input through the gucOS frontend reaches the
// defective path.
//
// The probe page logs every mousedown/mousemove/mouseup to the console with
// coordinates and `e.buttons`; todos/0421 routes those lines to the boot's
// stderr, and the kernel input ring preserves injection order, so the LINE
// ORDER is the event order.  Three gestures:
//
//   leg 1  press (100,100) -> sub-slop move (103,102: 3 px) -> supra-slop
//          move (140,100) -> release.  The sub-slop move must arrive as a
//          mousemove with buttons=1 (the stroke survives), and the ONE
//          mouseup must come after both moves, at the release point.
//          Unfixed: the sub-slop move became a mouseup at (103,102) and no
//          buttons=1 move at 103 exists at all.
//   leg 2  press (200,200) -> release, no motion.  A plain click still
//          fires exactly one mouseup (guards the CLICK_1 release path).
//   leg 3  press (300,300) -> sub-slop move (303,300) -> release WITHOUT
//          ever crossing the slop.  Exactly one mouseup, after the move.
//          Unfixed: TWO mouseups (the spurious one, then the CLICK_1 one).
//
// A final sentinel move at (500,350) flips the sentinel div class, and the class
// restyle repaints (the todos/0316-proven path — NB document.title is NOT
// usable here: dukky's title setter is a stub, so a dynamic retitle never
// reaches the window).  Polling the pixels for that flip is the flush
// barrier: the page is deliberately TEXTLESS and style-free below the
// sentinel rule, so no earlier gesture paints anything, and the first
// frame that differs from the settled shot IS the sentinel.  Every earlier
// event was processed — and its console line written — before it.  The
// barrier is also asserted from the parsed log (the sentinel move must be
// present), so an early poll break cannot pass silently.
//
// Run: node tests/kernel/test_netsurf_dragslop_e2e.js
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

/* Every event in one prefixed line; the sentinel move flips the body
 * class, whose restyle repaint is the only pixel change the page can
 * produce (no text — so no selection highlight — and no other styles).
 * The <title> sits BELOW the script so the window-title wait cannot be
 * satisfied before the listeners are attached. */
const SLOP_PAGE = `<!DOCTYPE html><html><head>
<style>
#mark { width: 50px; height: 50px; background: #ffffff; }
#mark.done { background: rgb(0, 200, 50); }
</style>
<script>
var n = 0;
function log(t, e) {
	n++;
	console.log('PEV ' + n + ' ' + t + ' x' + e.clientX + ' y' + e.clientY +
		' b' + e.buttons);
}
/* preventDefault() exactly as a real drawing pad does (paint.js): without
 * it the DRAG_SLOP promotion starts a core page-scroll drag, and those
 * drag tracks are consumed at the browser-window level — they never reach
 * the DOM, so the post-promotion mousemove could not be asserted. */
document.addEventListener('mousedown', function (e) { log('down', e); e.preventDefault(); });
document.addEventListener('mouseup', function (e) { log('up', e); });
document.addEventListener('mousemove', function (e) {
	log('move', e);
	if (e.clientX === 500 && e.clientY === 350) {
		document.getElementById('mark').className = 'done';
	}
});
</script>
<title>NsSlop</title>
</head><body style="margin: 0; background: #ffffff"><div id="mark"></div></body></html>
`;

/* ---- seed boot, then plant the page --------------------------------- */
const { dir: tmp, image } = freshImage('os-nsslop-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  const bytes = Buffer.from(SLOP_PAGE, 'utf-8');
  const fd = rfs.open('/root/slop.html', W, 0o644);
  rfs.write(fd, bytes, bytes.length);
  rfs.close(fd);
  rootStore.flush();
  rootStore.close();
}

/* Post-load settle before injecting: shot until two consecutive frames
 * match, so the first paint (and with it the layout the DOM hit test
 * needs) has happened.  The netsurf-pointer-e2e pattern. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

const run = driveBoot([
  'netsurf /root/slop.html &',
  'wmctl wait win NsSlop 30000',
  sidOf('S', 'NsSlop'),
  ...pollStable('$S', '/root/s0.ppm'),
  'echo page-settled',

  /* leg 1: press, sub-slop move, supra-slop move, release */
  'wmctl down $S 100 100',
  'wmctl hover $S 103 102',
  'wmctl hover $S 140 100',
  'wmctl up $S 140 100',

  /* leg 2: a plain click, no motion */
  'wmctl down $S 200 200',
  'wmctl up $S 200 200',

  /* leg 3: press, sub-slop move only, release */
  'wmctl down $S 300 300',
  'wmctl hover $S 303 300',
  'wmctl up $S 303 300',

  /* the flush barrier: the sentinel move flips the sentinel div class, whose
   * restyle is the first frame that can differ from the settled shot —
   * and it can only be processed after every event injected above it */
  'wmctl hover $S 500 350',
  `for i in $(seq 1 100); do wmctl shot $S /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm /root/s0.ppm || break; sleep 0.1; done`,
  /* the loop exits on the flip OR on its budget: say which, loudly */
  'cmp -s /root/poll.ppm /root/s0.ppm || echo sentinel-painted',
  'wmctl close $S && wmctl wait gone $S 8000 && echo win-closed',
], { image, timeout: 300000, maxBuffer: 64 * 1024 * 1024 });

const out = run.stdout;
const err = String(run.stderr);
fs.rmSync(tmp, { recursive: true, force: true });

check('the page settled before injection', out.includes('page-settled'));
check('the sentinel restyle PAINTED (the flush barrier really fired)',
      out.includes('sentinel-painted'));
check('the window closed', out.includes('win-closed'));

/* ---- parse the event log off stderr --------------------------------- */
const evs = [];
const evRe = /js: console: log: PEV (\d+) (down|up|move) x(-?\d+) y(-?\d+) b(\d+)/g;
let m;
while ((m = evRe.exec(err)) !== null) {
  evs.push({ n: +m[1], t: m[2], x: +m[3], y: +m[4], b: +m[5] });
}
check('the page logged events at all', evs.length > 0, `stderr bytes: ${err.length}`);
check('the sentinel move itself is in the log (nothing was lost at teardown)',
      evs.some((e) => e.t === 'move' && e.x === 500 && e.y === 350));
check('the event counter is strictly increasing (no reorder, no loss inside a line)',
      evs.every((e, i) => i === 0 || e.n > evs[i - 1].n));

const downs = evs.filter((e) => e.t === 'down');
check('three mousedowns, one per press',
      downs.length === 3 &&
      downs[0].x === 100 && downs[0].y === 100 &&
      downs[1].x === 200 && downs[1].y === 200 &&
      downs[2].x === 300 && downs[2].y === 300,
      JSON.stringify(downs));

/* slice the stream into the three gestures at the mousedowns */
const at = (d) => evs.indexOf(d);
const leg1 = downs.length === 3 ? evs.slice(at(downs[0]), at(downs[1])) : [];
const leg2 = downs.length === 3 ? evs.slice(at(downs[1]), at(downs[2])) : [];
const leg3 = downs.length === 3 ? evs.slice(at(downs[2])) : [];
const ups = (leg) => leg.filter((e) => e.t === 'up');
const move = (leg, x, y) => leg.find((e) => e.t === 'move' && e.x === x && e.y === y);

/* ---- leg 1: the drag that crosses the slop -------------------------- */
{
  const sub = move(leg1, 103, 102);
  const supra = move(leg1, 140, 100);
  const u = ups(leg1);
  check('leg1: the SUB-SLOP move arrived as a mousemove with the button held (buttons=1)',
        sub !== undefined && sub.b === 1,
        sub === undefined ? 'no move at (103,102) — the stroke died in the slop window'
                          : `buttons=${sub.b}`);
  check('leg1: the post-promotion drag move holds the button too',
        supra !== undefined && supra.b === 1,
        supra === undefined ? 'no move at (140,100)' : `buttons=${supra.b}`);
  check('leg1: exactly one mouseup', u.length === 1, `${u.length} ups: ${JSON.stringify(u)}`);
  check('leg1: the mouseup is AT THE RELEASE, not inside the slop window',
        u.length === 1 && u[0].x === 140 && u[0].y === 100 &&
        sub !== undefined && supra !== undefined &&
        u[0].n > sub.n && u[0].n > supra.n,
        JSON.stringify(u));
}

/* ---- leg 2: a motionless click still ups exactly once ---------------- */
{
  const u = ups(leg2);
  check('leg2: a plain click fires exactly one mouseup, at the click point',
        u.length === 1 && u[0].x === 200 && u[0].y === 200,
        JSON.stringify(u));
}

/* ---- leg 3: a press that never crosses the slop ---------------------- */
{
  const sub = move(leg3, 303, 300);
  const u = ups(leg3);
  check('leg3: the sub-slop move arrived as a mousemove with the button held',
        sub !== undefined && sub.b === 1,
        sub === undefined ? 'no move at (303,300)' : `buttons=${sub.b}`);
  check('leg3: exactly ONE mouseup (a spurious slop-window up would make two)',
        u.length === 1, `${u.length} ups: ${JSON.stringify(u)}`);
  check('leg3: the mouseup follows the move, at the release point',
        u.length === 1 && sub !== undefined && u[0].n > sub.n && u[0].x === 303,
        JSON.stringify(u));
}

/* ---- globally: one up per release, three releases -------------------- */
check('exactly three mouseups in the whole session',
      evs.filter((e) => e.t === 'up').length === 3,
      JSON.stringify(evs.filter((e) => e.t === 'up')));

if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf drag-slop e2e checks passed');
