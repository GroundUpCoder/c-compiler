#!/usr/bin/env node
// A CLASS-SELECTOR RESTYLE ON AN EXISTING ELEMENT REPAINTS, PROMPTLY, IN
// THE OS (todos/0316; NETSURF-JS.md §9 Lane B's residual, tripped over by
// §10).
//
// Lane B's bridge re-boxes the document when JS mutates the DOM, and
// test_netsurf_mutation_e2e.js proves that for element INSERTION and for
// textContent.  Nothing asserted the other everyday mutation: rewriting an
// existing element's CLASS so a stylesheet rule starts matching it.  That
// gap is why the bug survived Lane B, and it is why
// test_netsurf_events_e2e.js deliberately probes through canvases instead
// (its probe-page comment says so).
//
// ONE page, ONE click handler, six probes.  Three are the measurement and
// three are controls that stop a failure being blamed on the wrong half of
// the stack:
//
//   ctl    a <canvas> filled by putImageData.  No CSS, no box tree — the
//          engine's most direct repaint channel.  It DATES the click: the
//          frame it lit in is the frame everything else is measured
//          against.  It is also the second bug's trigger (below).
//   plain  a div CREATED by the handler, styled by a plain `.plain` rule.
//          This is the Lane B insertion path, so it lights iff the live
//          re-conversion ran at all.
//   fresh  a div CREATED by the handler with className 'fresh on', styled
//          by `.fresh.on` — the identical selector SHAPE as `cls` below,
//          but on an element whose class list is built from scratch.  It
//          lit even with the class-cache bug, which is what makes that
//          failure a statement about the EXISTING element rather than
//          about the stylesheet, the selector or the bridge.
//   idc    <div id="idsel">, no class attribute, restyled by `#idsel.on`.
//   cls    <div id="a" class="slab">, restyled by `.slab.on`.
//
// idc and cls differ in one respect that matters and it is not the
// selector: `#idsel` has no class attribute until the click creates one,
// while `.slab` already has one whose VALUE the click rewrites.  Two
// separate defects were measured here and each has its own leg:
//
//   1. libdom cached an element's parsed class list and rebuilt it only
//      when the class attribute was ADDED or REMOVED, so rewriting an
//      existing one left every class-matching selector reading the OLD
//      list for the rest of the document's life.  `cls` stayed unstyled
//      forever; `idc`, `fresh` and `plain` were unaffected.
//   2. the gucOS frontend's event loop sampled its park deadline BEFORE
//      processing input, so a callback scheduled by a click's own JS
//      listener — which is how the live re-conversion is scheduled — was
//      not reflected in it and the loop parked "until input" on a stale
//      -1.  Nothing re-boxed until some later unrelated event woke it.
//      Whether that happened depended on whether the press and the release
//      landed in one pass, so the same page repainted late, or never: the
//      canvas is what makes it deterministic here, because filling it is
//      enough JS to let both events arrive before the handler returns.
//
// Both are asserted in the SAME frame as the control, so neither can come
// back as "eventually".  Assertions are colour counts over the window,
// never fixed coordinates.
//
// Run: node tests/kernel/test_netsurf_restyle_e2e.js
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

/* ---- the probe page ------------------------------------------------- */

const BOX_W = 400;
const BOX_H = 60;
const AREA = BOX_W * BOX_H;             /* 24000 px per lit probe */
/* Each probe lights a colour no other probe (or the page chrome) uses, and
 * each unlit state is a DISTINCT grey, so a histogram says which probe
 * stayed dark rather than just "some grey is left". */
const LIT = {
  ctl: [0, 0, 200],       /* canvas, via putImageData                  */
  plain: [0, 160, 160],   /* .plain on a created element               */
  fresh: [200, 0, 200],   /* .fresh.on on a created element            */
  idc: [0, 200, 0],       /* #idsel.on  — id + class                   */
  cls: [200, 0, 0],       /* .slab.on   — class + class                */
};
const DARK = {
  ctl: [208, 208, 208],
  fresh: [160, 160, 160],
  idc: [192, 192, 192],
  cls: [176, 176, 176],
};

const PROBE_PAGE = `<html>
<head><title>NsRestyle</title>
<style>
body { margin: 0; background: #ffffff; }
canvas { display: block; }
#hit { width: ${BOX_W}px; height: ${BOX_H}px; background: #0000ff; }
#idsel { width: ${BOX_W}px; height: ${BOX_H}px; background: rgb(${DARK.idc.join(', ')}); }
#idsel.on { background: rgb(${LIT.idc.join(', ')}); }
.slab { width: ${BOX_W}px; height: ${BOX_H}px; background: rgb(${DARK.cls.join(', ')}); }
.slab.on { background: rgb(${LIT.cls.join(', ')}); }
.fresh { width: ${BOX_W}px; height: ${BOX_H}px; background: rgb(${DARK.fresh.join(', ')}); }
.fresh.on { background: rgb(${LIT.fresh.join(', ')}); }
.plain { width: ${BOX_W}px; height: ${BOX_H}px; background: rgb(${LIT.plain.join(', ')}); }
</style>
</head>
<body>
<div id="hit"></div>
<canvas id="ctl" width="${BOX_W}" height="${BOX_H}"></canvas>
<div id="tray"></div>
<div id="idsel"></div>
<div id="a" class="slab"></div>
<script>
function fill(id, r, g, b) {
	var c = document.getElementById(id).getContext('2d');
	var m = c.createImageData(${BOX_W}, ${BOX_H});
	for (var i = 0; i < ${BOX_W} * ${BOX_H} * 4; i += 4) {
		m.data[i] = r; m.data[i + 1] = g; m.data[i + 2] = b;
		m.data[i + 3] = 255;
	}
	c.putImageData(m, 0, 0);
}
fill('ctl', ${DARK.ctl.join(', ')});

var tray = document.getElementById('tray');
var idsel = document.getElementById('idsel');
var slab = document.getElementById('a');
document.getElementById('hit').addEventListener('click', function () {
	/* the control: no CSS involved, repaints the canvas node directly */
	fill('ctl', ${LIT.ctl.join(', ')});
	/* the same selector shape as the cls probe, on an element built
	 * from scratch */
	var d = document.createElement('div');
	d.className = 'fresh on';
	tray.appendChild(d);
	/* an element with NO class attribute gains one */
	idsel.className = 'on';
	/* an element whose class attribute already EXISTS has its value
	 * rewritten — the case todos/0316 is about */
	slab.className = 'slab on';
	/* the Lane B insertion control, appended LAST and reporting the DOM
	 * read-back: teal means the re-conversion ran AND both writes took,
	 * so a dark restyle probe is a paint failure and nothing else */
	if (idsel.className === 'on' && slab.className === 'slab on') {
		var e = document.createElement('div');
		e.className = 'plain';
		tray.appendChild(e);
	}
});
</script>
</body></html>
`;

/* ---- seed boot, then plant the page --------------------------------- */
const { dir: tmp, image } = freshImage('os-nsrestyle-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  const fd = rfs.open('/root/restyle.html', W, 0o644);
  const bytes = Buffer.from(PROBE_PAGE, 'utf-8');
  rfs.write(fd, bytes, bytes.length);
  rfs.close(fd);
  rootStore.flush();
  rootStore.close();
}

/* PNG shot helpers (the netsurf-e2e pattern; tests/lib/png.js since #657) */
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
/* Near-exact colour match: the compositor blits 1:1 and none of these boxes
 * is antialiased, but keep a little slack so a future dither cannot make
 * the count silently zero.  The greys are 16 apart, so the window is 8. */
const near = (want) => (p) => Math.abs(p[0] - want[0]) < 8 &&
                              Math.abs(p[1] - want[1]) < 8 &&
                              Math.abs(p[2] - want[2]) < 8;
function countContent(s, pred) {
  let n = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
const hist = (s, table) => Object.fromEntries(Object.entries(table)
  .map(([k, c]) => [k, countContent(s, near(c))]));

/* Post-title-barrier settle: shot until two consecutive frames match. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${out} && break; cp /root/poll.png ${out}; done`,
];
/* Repaints with no wmctl-visible marker: poll PIXELS until the frame differs
 * from the reference (bounded condition poll, not a fixed sleep). */
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${ref} || break; sleep 0.1; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* ---- session A: load, click once, sample two frames ----------------- */
const out = driveBoot([
  'netsurf /root/restyle.html &',
  'wmctl wait win NsRestyle 30000',
  sidOf('RS', 'NsRestyle'),
  ...pollStable('$RS', '/root/p0.png'),
  'echo shot-p0-ok',
  'wmctl click $RS 200 30',
  /* p1 is the FIRST frame that differs from the pre-click one: whatever the
   * click made visible in one go.  The control lights here by construction,
   * so this frame is the "same frame as the control" question. */
  ...pollChange('$RS', '/root/p0.png'),
  'wmctl shot $RS /root/p1.png && echo shot-p1-ok',
  /* p2 is the settled frame.  Nothing else touches this window, so a probe
   * dark in p2 never repainted at all — and a probe lit in p2 but not p1
   * repainted LATE, which is its own failure below. */
  ...pollStable('$RS', '/root/p2.png'),
  'echo shot-p2-ok',
  'wmctl close $RS && wmctl wait nowin NsRestyle 8000 && echo restyle-closed',
], { image, timeout: 300000, maxBuffer: 64 * 1024 * 1024 }).stdout;

const NAMES = ['p0', 'p1', 'p2'];
for (const tag of NAMES) check(`shot ${tag} taken`, out.includes(`shot-${tag}-ok`));
check('restyle window closed', out.includes('restyle-closed'));

/* ---- session B: read the shots back --------------------------------- */
const back = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.png`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 128 * 1024 * 1024 });
const shots = parsePngs(back.stdout, NAMES);
const h0 = hist(shots.p0, LIT), h1 = hist(shots.p1, LIT), h2 = hist(shots.p2, LIT);
console.log(`  lit  p0 (pre-click)  ${JSON.stringify(h0)}`);
console.log(`  lit  p1 (the click's frame) ${JSON.stringify(h1)}`);
console.log(`  lit  p2 (settled)    ${JSON.stringify(h2)}`);
console.log(`  dark p2 (settled)    ${JSON.stringify(hist(shots.p2, DARK))}`);

/* A probe counts as lit at 80% of its box: the boxes are solid fills, so
 * this is generous, and it cannot be reached by stray page chrome. */
const LIVE = AREA * 0.8;

/* Not vacuous: nothing is lit before the click. */
for (const k of Object.keys(LIT)) {
  check(`pre-click: ${k} is dark`, h0[k] < AREA * 0.1, `${h0[k]} px`);
}

/* Controls. */
check('control: the canvas repainted (the click reached JS)',
      h1.ctl > LIVE, `${h1.ctl} px of ${AREA}`);
check('control: a created element appeared, so the re-conversion RAN — and ' +
      'both className writes read back mutated',
      h1.plain > LIVE, `${h1.plain} px of ${AREA}`);
check('control: the same selector shape on a NEW element restyles',
      h1.fresh > LIVE, `${h1.fresh} px of ${AREA}`);

/* Defect 1 (libdom class cache): settled, both restyles must have landed. */
check('id + class (#idsel.on): the element repainted with its new style',
      h2.idc > LIVE, `${h2.idc} px of ${AREA}`);
check('class + class (.slab.on): the element repainted with its new style',
      h2.cls > LIVE, `${h2.cls} px of ${AREA}`);

/* Defect 2 (stale park deadline): and in the frame the control lit in, not
 * "eventually, if something else happens to wake the loop". */
check('id + class restyled in the SAME frame as the control',
      h1.idc > LIVE, `${h1.idc} px of ${AREA} in the control's frame`);
check('class + class restyled in the SAME frame as the control',
      h1.cls > LIVE, `${h1.cls} px of ${AREA} in the control's frame`);

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf class-restyle e2e checks passed');
