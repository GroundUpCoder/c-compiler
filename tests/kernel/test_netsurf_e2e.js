#!/usr/bin/env node
// NetSurf Lane 3 acceptance: /bin/netsurf is a first-class INSTALLED
// gucOS app — the binary, engine resources, proportional sans faces and
// the html/htm openwith association all come from the BAKED image seeds
// (os/image.json; no test-side install, the Lane 2 /var/local shim is
// gone).
//
//   - openwith: `open /root/hello.html` resolves the baked html key
//     through the shared openwith.h resolver (the same path the
//     desktop/fileman double-click takes) and spawns /bin/netsurf.
//   - render: hello.html paints — white page, REAL freetype AA text
//     (antialiased gray edge pixels present).
//   - status bar: the bottom STATUS_H=18 strip is silver chrome;
//     hovering the link block (wmctl hover) drives
//     gui_window_set_status -> dark text pixels in the strip.
//   - title: the window title follows the document <title> (wmctl wait
//     win "Smoke"/"Squares"/"Two" are the barriers — exact titles).
//   - resize: wmctl resize -> RESIZED -> reformat: the float squares
//     re-wrap from one band (800px) to two (500px) — a genuine
//     re-LAYOUT, not a crop; the status bar re-lays to the new bottom.
//   - input: wheel scroll (blue link block leaves the viewport),
//     PageDown scroll (viewport = window minus the status bar; the deep
//     green marker block scrolls into view), Home, and a pointer click
//     on a link block that NAVIGATES to two.html.
//   - history: Alt+Left returns to squares.html (title + pixels),
//     Alt+Right goes forward to two.html again — the local history
//     wired to the gucOS navigation chord.
//   - close: wmctl close -> SDL_EVENT_WINDOW_CLOSE_REQUESTED -> the
//     last-window destroy exits the process (wait nowin).
//
// Squares page geometry (margin 0, content coords):
//   blue <a> block x 0-400, y 0-120; six 100x100 red floats (104px
//   pitch) y 122-222 — one band at 800w, 4+2 bands at 500w (band2 y
//   226-326); 654px filler; green block y ~876-976; 1500px tail.
// Viewport heights: 800x600 window -> 582 content rows; 500x400 ->
//   382 (the bottom 18 are the status bar).
//
// Run: node tests/kernel/test_netsurf_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

/* must match gucos/gui.c STATUS_H */
const STATUS_H = 18;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- seed boot, then plant the test PAGES on the root volume ----
 * (the app itself is baked: /bin/netsurf + /usr/share/netsurf/* +
 * /usr/share/fonts/sans*.ttf come from the image seeds) */
const { dir: tmp, image } = freshImage('os-netsurf-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  const TDIR = path.join(ROOT, 'vendor', 'netsurf', 'test');
  for (const f of ['hello.html', 'squares.html', 'two.html']) {
    const bytes = fs.readFileSync(path.join(TDIR, f));
    const fd = rfs.open('/root/' + f, W, 0o644);
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  }
  rootStore.flush();
  rootStore.close();
}

/* PPM helpers (the winmine/term pattern) */
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
const isBlue = (p) => p[0] < 80 && p[1] < 80 && p[2] > 180;
const isRed = (p) => p[0] > 180 && p[1] < 80 && p[2] < 80;
const isGreen = (p) => p[0] < 100 && p[1] > 140 && p[2] < 100;
const isWhite = (p) => p[0] > 230 && p[1] > 230 && p[2] > 230;
const isSilver = (p) => p.every((v) => v > 180 && v < 210);
function rowsWith(s, pred, y0, y1) {
  const rows = [];
  for (let y = Math.max(0, y0); y < Math.min(s.h, y1); y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) { rows.push(y); break; }
    }
  }
  return rows;
}
/* count pixels matching pred inside the status strip (below content) */
function stripCount(s, pred) {
  let n = 0;
  for (let y = s.h - STATUS_H + 1; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
/* raw bytes of the status strip, for change comparison */
function stripBytes(s) {
  return s.data.slice((s.h - STATUS_H) * s.w * 3);
}

/* SDL scancode + SDLK_ keycode pairs (compiler.js veneer values);
 * MOD 256 = SDL_KMOD_LALT for the history chords */
const K_PGDN = '78 1073741902';
const K_HOME = '74 1073741898';
const K_ALT_LEFT = '80 1073741904 256';
const K_ALT_RIGHT = '79 1073741903 256';

/* Repaints after scroll/status injections have no wmctl-visible marker,
 * so the driver polls PIXELS: shot to a scratch ppm until it differs
 * from the reference (bounded condition poll, not a fixed sleep). */
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${ref} || break; sleep 0.1; done`,
];
/* Post-title-barrier settle: shot until two consecutive frames match
 * (late load-progress status repaints land just after the <title>
 * barrier; the stable pair is the quiesce marker). */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];

/* ---- session A: the whole interactive story in one boot ---- */
const out = driveBoot([
  // openwith leg: the BAKED html association resolves to /bin/netsurf
  // (open(1) shares openwith.h with the desktop/fileman GUI opens)
  'open /root/hello.html &',
  'wmctl wait win Smoke 30000',            // spawn + engine init + first layout
  'SID=$(wmctl list | grep "\tSmoke$" | sed "s/[^0-9].*//")',
  ...pollStable('$SID', '/root/s1.ppm'),
  'echo shot-s1-ok',

  'netsurf /root/squares.html &',
  'wmctl wait win Squares 30000',
  'SQ=$(wmctl list | grep "\tSquares$" | sed "s/[^0-9].*//")',
  ...pollStable('$SQ', '/root/s2.ppm'),
  'echo shot-s2-ok',

  // status leg: hover the link block -> set_status paints the URL
  'wmctl hover $SQ 200 60',
  ...pollChange('$SQ', '/root/s2.ppm'),
  'wmctl shot $SQ /root/s2h.ppm && echo shot-s2h-ok',

  // resize -> RESIZED -> synchronous reformat -> floats re-wrap.  The
  // frontend reformats BEFORE the ack present, so the dim wait IS the
  // reflow barrier (no stale-crop frame exists to race).
  'wmctl resize $SQ 500 400',
  'wmctl wait dim $SQ 500x400 8000',
  'wmctl shot $SQ /root/s3.ppm && echo shot-s3-ok',

  // wheel: 3 notches down = +300px scroll (the blue block scrolls off)
  'wmctl wheel $SQ -3',
  ...pollChange('$SQ', '/root/s3.ppm'),
  'wmctl shot $SQ /root/s4.ppm && echo shot-s4-ok',

  // PageDown: +382px (the content viewport) -> the green marker scrolls in
  `wmctl key $SQ ${K_PGDN}`,
  ...pollChange('$SQ', '/root/s4.ppm'),
  'wmctl shot $SQ /root/s5.ppm && echo shot-s5-ok',

  // Home, then click the blue <a> block -> NAVIGATE to two.html.
  // The title change is the navigation barrier.
  `wmctl key $SQ ${K_HOME}`,
  'wmctl click $SQ 200 60',
  'wmctl wait win Two 20000',
  ...pollChange('$SQ', '/root/s5.ppm'),
  'wmctl shot $SQ /root/s6.ppm && echo shot-s6-ok',

  // history: Alt+Left -> BACK to squares.html (title + repaint barrier)
  `wmctl key $SQ ${K_ALT_LEFT}`,
  'wmctl wait win Squares 20000',
  ...pollChange('$SQ', '/root/s6.ppm'),
  'wmctl shot $SQ /root/s7.ppm && echo shot-s7-ok',

  // history: Alt+Right -> FORWARD to two.html again
  `wmctl key $SQ ${K_ALT_RIGHT}`,
  'wmctl wait win Two 20000',
  ...pollChange('$SQ', '/root/s7.ppm'),
  'wmctl shot $SQ /root/s8.ppm && echo shot-s8-ok',

  // close box path: CLOSE_REQUESTED -> last-window exit
  'wmctl close $SQ',
  'wmctl wait nowin Two 8000',
  'echo closed-squares-ok',
  'wmctl close $SID',
  'wmctl wait nowin Smoke 8000',
  'echo closed-smoke-ok',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

check('openwith leg: hello window appeared via `open` + shot', out.includes('shot-s1-ok'));
check('squares window appeared + shot', out.includes('shot-s2-ok'));
check('status hover shot', out.includes('shot-s2h-ok'));
check('resize shot', out.includes('shot-s3-ok'));
check('wheel shot', out.includes('shot-s4-ok'));
check('pagedown shot', out.includes('shot-s5-ok'));
check('navigate shot', out.includes('shot-s6-ok'));
check('history back shot', out.includes('shot-s7-ok'));
check('history forward shot', out.includes('shot-s8-ok'));
check('close leg: squares window gone', out.includes('closed-squares-ok'));
check('close leg: smoke window gone', out.includes('closed-smoke-ok'));

/* ---- session B: read the shots back ---- */
const NAMES = ['s1', 's2', 's2h', 's3', 's4', 's5', 's6', 's7', 's8'];
const back = driveBoot('cat ' + NAMES.map(n => '/root/' + n + '.ppm').join(' ') + '\n',
  { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const shots = parsePPMs(back.stdout, NAMES);

/* s1: hello.html rendered from the BAKED app — white page + real AA
 * text + the silver status strip */
{
  const s = shots.s1;
  check('s1: initial window is 800x600', s.w === 800 && s.h === 600,
        `${s.w}x${s.h}`);
  let white = 0, dark = 0, gray = 0;
  const contentH = s.h - STATUS_H;
  for (let y = 0; y < contentH; y++) {
    for (let x = 0; x < s.w; x++) {
      const p = px(s, x, y);
      if (isWhite(p)) white++;
      else if (p[0] < 64 && p[1] < 64 && p[2] < 64) dark++;
      else if (p[0] === p[1] && p[1] === p[2]) gray++;
    }
  }
  check('s1: mostly white page', white > s.w * contentH * 0.8, `white=${white}`);
  check('s1: glyph core pixels present', dark > 100, `dark=${dark}`);
  check('s1: ANTIALIASED text (gray edge pixels)', gray > 100, `gray=${gray}`);
  check('s1: status bar strip is silver chrome',
        stripCount(s, isSilver) > s.w * (STATUS_H - 1) * 0.5,
        `silver=${stripCount(s, isSilver)}`);
}

/* s2: squares at 800w — blue link block, ONE red float band, no green */
{
  const s = shots.s2;
  check('s2: blue link block at (200,60)', isBlue(px(s, 200, 60)));
  const red = rowsWith(s, isRed, 0, s.h);
  check('s2: one red band (rows 122..222 only)',
        red.length > 0 && red[0] >= 118 && red[red.length - 1] <= 226,
        `red rows ${red[0]}..${red[red.length - 1]}`);
  check('s2: green marker below the fold', rowsWith(s, isGreen, 0, s.h).length === 0);
}

/* s2h: after hovering the link — the status bar shows text (dark
 * pixels) and its pixels changed vs the settled s2 */
{
  const s = shots.s2h;
  check('s2h: status text pixels present in the strip',
        stripCount(s, (p) => p[0] < 120 && p[1] < 120 && p[2] < 120) > 20,
        `dark=${stripCount(s, (p) => p[0] < 120 && p[1] < 120 && p[2] < 120)}`);
  check('s2h: hover CHANGED the status strip (set_status wired)',
        !stripBytes(s).equals(stripBytes(shots.s2)));
}

/* s3: after resize to 500x400 — REFLOWED: red floats wrap to two bands;
 * the status bar re-laid to the new bottom */
{
  const s = shots.s3;
  check('s3: resized surface is 500x400', s.w === 500 && s.h === 400,
        `${s.w}x${s.h}`);
  check('s3: blue link block still at top', isBlue(px(s, 200, 60)));
  const red = rowsWith(s, isRed, 0, s.h);
  check('s3: floats re-wrapped (red present below y 240 — second band)',
        red.length > 0 && red[red.length - 1] > 240,
        `red rows ${red[0]}..${red[red.length - 1]}`);
  check('s3: status bar re-laid after resize',
        stripCount(s, isSilver) > s.w * (STATUS_H - 1) * 0.5,
        `silver=${stripCount(s, isSilver)}`);
}

/* s4: after wheel -3 (+300px) — blue block scrolled off, band2 tail at top */
{
  const s = shots.s4;
  check('s4: wheel scrolled: no blue at top', !isBlue(px(s, 200, 4)));
  const red = rowsWith(s, isRed, 0, 60);
  check('s4: red band tail visible at top rows', red.length > 0);
  check('s4: green still out of view', rowsWith(s, isGreen, 0, s.h).length === 0);
}

/* s5: after PageDown (+382px, scroll ~682) — the green marker is in view */
{
  const s = shots.s5;
  check('s5: green marker scrolled into view',
        rowsWith(s, isGreen, 0, s.h).length > 40);
  check('s5: red bands gone', rowsWith(s, isRed, 0, s.h).length === 0);
  check('s5: no blue', rowsWith(s, isBlue, 0, s.h).length === 0);
}

/* mostly-red sampler for the two.html states (content area only —
 * the strip below is status chrome) */
function redFraction(s) {
  let red = 0, samples = 0;
  for (let y = 0; y < s.h - STATUS_H; y += 4) {
    for (let x = 0; x < s.w; x += 4) {
      samples++;
      if (isRed(px(s, x, y))) red++;
    }
  }
  return { red, samples };
}

/* s6: after click on the link block — two.html rendered (red page) */
{
  const { red, samples } = redFraction(shots.s6);
  check('s6: navigation rendered two.html (mostly red page)',
        red > samples * 0.7, `red=${red}/${samples}`);
}

/* s7: after Alt+Left — BACK at squares.html (restored layout + scroll) */
{
  const s = shots.s7;
  check('s7: back restored the blue link block', isBlue(px(s, 200, 60)));
  const red = rowsWith(s, isRed, 0, s.h);
  check('s7: back restored the wrapped float bands',
        red.length > 0 && red[red.length - 1] > 240,
        `red rows ${red[0]}..${red[red.length - 1]}`);
  const { red: r6 } = redFraction(s);
  check('s7: two.html red page is gone', r6 < redFraction(shots.s6).red * 0.5);
}

/* s8: after Alt+Right — FORWARD to two.html again */
{
  const { red, samples } = redFraction(shots.s8);
  check('s8: forward re-rendered two.html (mostly red page)',
        red > samples * 0.7, `red=${red}/${samples}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? 'PASS test_netsurf_e2e' : `FAIL test_netsurf_e2e (${failures})`);
process.exit(failures === 0 ? 0 : 1);
