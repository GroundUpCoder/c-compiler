#!/usr/bin/env node
// todos/0410: an <img> must keep rendering after a mutation-triggered live
// re-conversion (NetSurf JS Lane B).  The pre-fix defect: any class toggle
// scheduled the whole-document re-conversion; its refetch of the image
// completed against a document whose status was already DONE, so the
// all-objects-arrived reformat (READY-gated) never ran and the throttled
// incremental_reflow check silently dropped its one chance — a box needing
// the object's INTRINSIC size (no REPLACE_DIM: width-only or attribute-less
// img) kept zero height forever.  The image rendered once at load and never
// again until a fresh page load.
//
// The page is deck-shaped on purpose (the isolating repro's geometry): the
// image sits on an absolutely-positioned bottom "base" layer that NEVER
// moves, an opaque cover slide is toggled on/off by clicking a nav region,
// and the img carries ONLY a width attribute — both-attrs images take the
// REPLACE_DIM shortcut and never needed the completion reformat, so a
// width-only img is the discriminating shape.  Click-away-and-back:
//
//   shot a  load, cover on           -> no image ink (covered)
//   shot b  click 1 (mutation #1)    -> cover off, image INK required
//   shot c  click 2                  -> cover back, no image ink
//   shot d  click 3                  -> image INK required again (the
//                                       defect was cumulative: every
//                                       re-conversion re-fetched and
//                                       re-lost it)
//
// Assertions are on INK (orange pixel counts), never on the absence of an
// error.  Run: node tests/kernel/run.js --filter=netsurf_img_reconvert
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

/* orange.png is a solid 32x32 #ff8000 square (the Lane 4 PNG fixture);
 * width="200" with NO height forces the aspect-ratio path that needs the
 * object's intrinsic size — the shape the defect ate.  200x200 = 40000
 * orange pixels when it renders. */
const IMG_W = 200;
const PAGE = `<html>
<head><title>NsImgRcv</title>
<style>
body { margin: 0; background: #1a1a1a; overflow: hidden; }
.slide { position: absolute; left: -10000px; top: 0; width: 100%; height: 100%; }
.slide.on, .slide.base { left: 0; }
.cover { background: #301848; }
.nav { position: absolute; top: 0; width: 50%; height: 100%; }
#next { left: 50%; }
</style></head>
<body>
<div class="slide base"><img src="orange.png" width="${IMG_W}"></div>
<div class="slide cover on" id="c1"><p style="color:#ffffff">cover</p></div>
<div class="nav" id="next"></div>
<script>
var c1 = document.getElementById('c1');
document.getElementById('next').addEventListener('click', function () {
	c1.className = (c1.className.indexOf('on') >= 0)
		? 'slide cover' : 'slide cover on';
});
console.log('imgrcv ready');
</script>
</body></html>
`;

/* ---- seed boot, then plant the page + the PNG fixture ---- */
const { dir: tmp, image } = freshImage('os-nsimgrcv-');
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
  put('/root/imgrcv.html', Buffer.from(PAGE, 'utf-8'));
  put('/root/orange.png', fs.readFileSync(
    path.join(ROOT, 'vendor', 'netsurf', 'test', 'img', 'orange.png')));
  rootStore.flush();
  rootStore.close();
}

/* Post-title-barrier settle (the netsurf-e2e pattern): shot until two
 * consecutive frames match.  The page has no timers, so it settles. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${ref} || break; sleep 0.1; done`,
];

/* ---- session A: load, then three cover toggles ---- */
const out = driveBoot([
  'netsurf /root/imgrcv.html &',
  'wmctl wait win NsImgRcv 30000',
  'SID=$(wmctl list | grep "\tNsImgRcv$" | sed "s/[^0-9].*//")',
  ...pollStable('$SID', '/root/a.ppm'),
  'echo shot-a-ok',
  'wmctl click $SID 600 300',
  ...pollChange('$SID', '/root/a.ppm'),
  ...pollStable('$SID', '/root/b.ppm'),
  'echo shot-b-ok',
  'wmctl click $SID 600 300',
  ...pollChange('$SID', '/root/b.ppm'),
  ...pollStable('$SID', '/root/c.ppm'),
  'echo shot-c-ok',
  'wmctl click $SID 600 300',
  ...pollChange('$SID', '/root/c.ppm'),
  ...pollStable('$SID', '/root/d.ppm'),
  'echo shot-d-ok',
  'wmctl close $SID && wmctl wait nowin NsImgRcv 8000 && echo closed-ok',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['shot-a-ok', 'shot-b-ok', 'shot-c-ok', 'shot-d-ok', 'closed-ok']) {
  check(tag, out.includes(tag));
}

/* ---- session B: read the shots back and count INK ---- */
const back = driveBoot('cat /root/a.ppm /root/b.ppm /root/c.ppm /root/d.ppm\n',
  { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
function parsePPMs(buf, names) {
  const shots = {}; let off = 0;
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
const shots = parsePPMs(back.stdout, ['a', 'b', 'c', 'd']);
function orangeCount(s) {
  let n = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 3;
      if (s.data[i] > 200 && s.data[i + 1] > 90 && s.data[i + 1] < 170 &&
          s.data[i + 2] < 60) n++;
    }
  }
  return n;
}
const FULL = IMG_W * IMG_W;             /* solid square, scaled uniformly */
const counts = {};
for (const n of ['a', 'b', 'c', 'd']) counts[n] = orangeCount(shots[n]);
console.log(`  info orange ink a=${counts.a} b=${counts.b} c=${counts.c} d=${counts.d} (full=${FULL})`);

check('a: image covered at load (no orange ink)', counts.a < FULL / 100,
      `orange=${counts.a}`);
check('b: image INK after the first mutation-triggered re-conversion',
      counts.b > FULL * 0.9, `orange=${counts.b} want>${FULL * 0.9}`);
check('c: cover back over the image', counts.c < FULL / 100,
      `orange=${counts.c}`);
check('d: image INK again after further re-conversions',
      counts.d > FULL * 0.9, `orange=${counts.d} want>${FULL * 0.9}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? 'PASS test_netsurf_img_reconvert_e2e'
                           : `FAIL test_netsurf_img_reconvert_e2e (${failures})`);
process.exit(failures === 0 ? 0 : 1);
