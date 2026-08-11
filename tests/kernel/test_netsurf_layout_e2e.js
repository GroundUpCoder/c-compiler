#!/usr/bin/env node
// NetSurf Lane 4 layout fidelity: the REAL layout features the engine
// ships beyond the squares float page, asserted as exact box geometry —
// the point of vendoring a mature engine over a toy renderer.
//
//   - table.html: a collapsed 3x2 table of 100x50 solid cells at the
//     origin — every cell centre is probed for its exact colour and the
//     column/row boundaries must fall at x=100/200/300 and y=50/100
//     (the in-test EXPECTED table is the golden).
//   - flow.html: block box-model arithmetic (margin 20 + border 5 +
//     padding 10 puts the yellow content origin at x=35,y=35 with a red
//     100x40 inner block) and inline-block wrapping (three 150x40
//     blocks in a 320px container: two on line one, the third wraps to
//     y+40).
//   - forms.html: form controls RENDER (rendering only — submit is not
//     exercised by this test): each control sits in its own 40px yellow
//     row strip and must paint "ink" (non-strip, non-white pixels)
//     into its band; the unchecked vs checked checkbox rows must
//     differ (the check glyph itself).
//   - fonts.html: the same words in sans vs serif and mono vs
//     mono-bold must render DIFFERENT pixels — proving the Lane 4
//     baked serif.ttf / mono_bold.ttf faces really load (without
//     them both pairs fall back to identical faces and the bands
//     match byte-for-byte).
//
// Run: node tests/kernel/test_netsurf_layout_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');

/* must match gucos/gui.c STATUS_H */
const STATUS_H = 18;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- seed boot, then plant the fixture pages on the root volume ---- */
const { dir: tmp, image } = freshImage('os-nslayout-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  const TDIR = path.join(ROOT, 'vendor', 'netsurf', 'test');
  for (const f of ['table.html', 'flow.html', 'forms.html', 'fonts.html']) {
    const bytes = fs.readFileSync(path.join(TDIR, f));
    const fd = rfs.open('/root/' + f, W, 0o644);
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  }
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
const near = (p, rgb, tol = 4) => Math.abs(p[0] - rgb[0]) <= tol &&
                                  Math.abs(p[1] - rgb[1]) <= tol &&
                                  Math.abs(p[2] - rgb[2]) <= tol;
const WHITE = [255, 255, 255], YELLOW = [255, 216, 0];
/* raw bytes of a horizontal band [y0, y1) */
const bandBytes = (s, y0, y1) => s.data.slice(y0 * s.w * 4, y1 * s.w * 4);
/* count pixels matching pred in a band */
function bandCount(s, pred, y0, y1) {
  let n = 0;
  for (let y = y0; y < Math.min(y1, s.h); y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}

/* Post-title-barrier settle: shot until two consecutive frames match
 * (late load-progress status repaints land just after the <title>
 * barrier; the stable pair is the quiesce marker). */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${out} && break; cp /root/poll.png ${out}; done`,
];

/* one leg per page: open via the CLI, settle, shot, close. The shot
 * echo is GATED on the settled png existing so a leg that never found
 * its window cannot print success markers (its `wait win` timeout
 * also hard-fails the test via driveBoot's 0171 rule). */
const leg = (page, title, out) => [
  `netsurf /root/${page} &`,
  `wmctl wait win ${title} 30000`,
  `SID=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`,
  ...pollStable('$SID', out),
  `[ -s ${out} ] && echo shot-${title}-ok`,
  'wmctl close $SID',
  `wmctl wait nowin ${title} 8000`,
  `echo closed-${title}-ok`,
];

/* ---- session A: render all four fixtures ---- */
const out = driveBoot([
  ...leg('table.html', 'Table', '/root/t.png'),
  ...leg('flow.html', 'Flow', '/root/f.png'),
  ...leg('forms.html', 'Forms', '/root/o.png'),
  ...leg('fonts.html', 'Fonts', '/root/n.png'),
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const t of ['Table', 'Flow', 'Forms', 'Fonts']) {
  check(`${t} rendered + shot`, out.includes(`shot-${t}-ok`));
  check(`${t} window closed`, out.includes(`closed-${t}-ok`));
}

/* ---- session B: read the shots back ---- */
const NAMES = ['t', 'f', 'o', 'n'];
const back = driveBoot('cat ' + NAMES.map(n => '/root/' + n + '.png').join(' ') + '\n',
  { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const shots = parsePngs(back.stdout, NAMES);

/* t: table cell geometry — the golden expected-geometry table.
 * Cells are exactly 100x50 from the origin (margin 0, collapsed). */
{
  const s = shots.t;
  const CELLS = [
    /* [probe x, probe y, expected rgb, label] */
    [50, 25, [255, 0, 0], 'r0c0 red'],
    [150, 25, [0, 200, 0], 'r0c1 green'],
    [250, 25, [0, 0, 255], 'r0c2 blue'],
    [50, 75, [255, 216, 0], 'r1c0 yellow'],
    [150, 75, [255, 0, 255], 'r1c1 magenta'],
    [250, 75, [0, 255, 255], 'r1c2 cyan'],
  ];
  for (const [x, y, rgb, label] of CELLS) {
    check(`t: cell centre ${label} at (${x},${y})`, near(px(s, x, y), rgb),
          String(px(s, x, y)));
  }
  /* column boundary at x=100 (row 0: red -> green), row boundary at
   * y=50 (col 0: red -> yellow), table right edge at x=300, table
   * bottom at y=100 */
  check('t: col boundary at x=100', near(px(s, 97, 25), [255, 0, 0]) &&
        near(px(s, 103, 25), [0, 200, 0]),
        `${px(s, 97, 25)} | ${px(s, 103, 25)}`);
  check('t: row boundary at y=50', near(px(s, 50, 47), [255, 0, 0]) &&
        near(px(s, 50, 53), [255, 216, 0]),
        `${px(s, 50, 47)} | ${px(s, 50, 53)}`);
  check('t: right edge at x=300', near(px(s, 297, 25), [0, 0, 255]) &&
        near(px(s, 310, 25), WHITE),
        `${px(s, 297, 25)} | ${px(s, 310, 25)}`);
  check('t: bottom edge at y=100', near(px(s, 50, 97), [255, 216, 0]) &&
        near(px(s, 50, 110), WHITE),
        `${px(s, 50, 97)} | ${px(s, 50, 110)}`);
}

/* f: block box model + inline-block wrap */
{
  const s = shots.f;
  const NAVY = [0, 0, 128], SILVER = [192, 192, 192];
  /* box 1: border box x 20..250 y 20..110; content origin (35,35);
   * red inner 100x40; yellow = background through padding + content */
  check('f: left border navy at (22,65)', near(px(s, 22, 65), NAVY),
        String(px(s, 22, 65)));
  check('f: top border navy at (135,22)', near(px(s, 135, 22), NAVY),
        String(px(s, 135, 22)));
  check('f: padding yellow at (30,65)', near(px(s, 30, 65), YELLOW),
        String(px(s, 30, 65)));
  check('f: inner red block at (85,55)', near(px(s, 85, 55), [255, 0, 0]),
        String(px(s, 85, 55)));
  check('f: content yellow right of red at (145,55)',
        near(px(s, 145, 55), YELLOW), String(px(s, 145, 55)));
  check('f: right border navy at (247,65)', near(px(s, 247, 65), NAVY),
        String(px(s, 247, 65)));
  check('f: bottom border navy at (135,107)', near(px(s, 135, 107), NAVY),
        String(px(s, 135, 107)));
  check('f: white outside the box at (260,65)', near(px(s, 260, 65), WHITE),
        String(px(s, 260, 65)));
  /* box 2 at y=130 (110 + 20 margin): line one green|blue + silver
   * tail, line two magenta + silver */
  check('f: inline-block 1 green at (75,150)', near(px(s, 75, 150), [0, 200, 0]),
        String(px(s, 75, 150)));
  check('f: inline-block 2 blue at (225,150)', near(px(s, 225, 150), [0, 0, 255]),
        String(px(s, 225, 150)));
  check('f: container silver at (310,150)', near(px(s, 310, 150), SILVER),
        String(px(s, 310, 150)));
  check('f: inline-block 3 WRAPPED magenta at (75,190)',
        near(px(s, 75, 190), [255, 0, 255]), String(px(s, 75, 190)));
  check('f: line two silver tail at (225,190)', near(px(s, 225, 190), SILVER),
        String(px(s, 225, 190)));
  check('f: white below the container at (75,215)', near(px(s, 75, 215), WHITE),
        String(px(s, 75, 215)));
}

/* o: form controls paint ink into their row strips */
{
  const s = shots.o;
  const isYellowish = (p) => p[0] > 200 && p[1] > 160 && p[2] < 90;
  const ink = (p) => !isYellowish(p) && !near(p, WHITE, 12);
  const ROWS = [
    ['text input', 0, 40], ['button', 40, 80], ['checkbox', 80, 120],
    ['checkbox checked', 120, 160], ['radio', 160, 200],
    ['select', 200, 240], ['textarea', 240, 300],
  ];
  for (const [label, y0, y1] of ROWS) {
    /* 2px inset from the strip edges dodges row-boundary AA */
    const n = bandCount(s, ink, y0 + 2, y1 - 2);
    check(`o: ${label} painted (ink pixels in rows ${y0}..${y1})`, n > 30,
          `ink=${n}`);
  }
  check('o: text input has a white field interior',
        bandCount(s, (p) => near(p, WHITE, 6), 2, 38) > 300,
        `white=${bandCount(s, (p) => near(p, WHITE, 6), 2, 38)}`);
  check('o: checked checkbox differs from unchecked (the check glyph)',
        !bandBytes(s, 122, 158).equals(bandBytes(s, 82, 118)));
}

/* n: the baked serif + mono-bold faces actually load */
{
  const s = shots.n;
  const dark = (p) => p[0] < 100 && p[1] < 100 && p[2] < 100;
  const ROWS = [['sans', 0, 40], ['serif', 40, 80], ['mono', 80, 120],
                ['mono bold', 120, 160]];
  for (const [label, y0, y1] of ROWS) {
    const n = bandCount(s, dark, y0, y1);
    check(`n: ${label} row has glyph pixels`, n > 50, `dark=${n}`);
  }
  check('n: serif renders differently from sans (serif.ttf loaded)',
        !bandBytes(s, 40, 80).equals(bandBytes(s, 0, 40)));
  check('n: mono bold renders differently from mono (mono_bold.ttf loaded)',
        !bandBytes(s, 120, 160).equals(bandBytes(s, 80, 120)));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? 'PASS test_netsurf_layout_e2e'
                           : `FAIL test_netsurf_layout_e2e (${failures})`);
process.exit(failures === 0 ? 0 : 1);
