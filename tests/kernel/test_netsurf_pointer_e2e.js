#!/usr/bin/env node
// THE POINTER PATH OF /bin/netsurf: A CANCELLED CLICK, AND THE DYNAMIC
// PSEUDO-CLASSES (todos/0419 P0 + todos/0420).
//
// Two defects the netsurf-bughunt lane found with in-OS probe pages, both
// in the tail of html_mouse_action, both asserted here off wmctl shots:
//
//   0419  a click listener could not stop a link.  The cancelable DOM
//         `click` fired BEFORE the deferred ACTION_NAVIGATE — the order
//         was already right — but the dispatch result was thrown away, so
//         browser_window_navigate ran whatever the listener said.  The
//         listener's own restyle was lost too, because the navigation
//         replaced the document before the repaint.
//   0420  `:hover` never matched.  node_is_hover in css/select.c was a
//         `\todo Support hovering` stub that always answered "no match".
//         Pointer tracking already worked (the status bar names the link
//         under the pointer), so what was missing is the answer and the
//         bounded restyle behind it.
//
// The legs are chosen so that a pass cannot be vacuous:
//
//   cancelled   the listener's restyle IS on screen and page B is NOT.
//               One colour proves the click reached JS, the other proves
//               the navigation stopped.  Neither alone would do: a browser
//               that dropped the click entirely also shows no page B.
//   navigates   a SECOND link whose listener does NOT call
//               preventDefault() still reaches page B.  This is the leg
//               that keeps the fix honest — a fix that simply stopped
//               navigating on every click would pass the first leg.
//   hover       `a:hover` paints while the pointer rests on the link.
//   unhover     ...and the base colour comes BACK when the pointer
//               leaves.  This is the EXIT half of the chain delta; a
//               restyle that only ever adds state passes "hover" alone.
//   ancestor    `#outer:hover` paints while the pointer rests on a SPAN
//               inside it.  :hover matches a chain, not one element.
//   active      `#press:active` paints between a button-down and the
//               matching button-up, and is gone after the release.
//
// Run: node tests/kernel/test_netsurf_pointer_e2e.js
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

/* ---- the probe pages ------------------------------------------------ */

/* Every probe owns a colour no other probe and no page chrome uses, so a
 * histogram says WHICH probe painted rather than "some colour changed". */
const C = {
  ranA:    [0x12, 0x34, 0x56],  /* the cancelled link's listener ran   */
  ranB:    [0x00, 0xa0, 0xa0],  /* the plain link's listener ran       */
  pageB:   [0x77, 0x00, 0xaa],  /* page B — the navigation target      */
  hover:   [0x0a, 0x55, 0x10],  /* a:hover                             */
  base:    [0x80, 0x80, 0x80],  /* the same link, not hovered          */
  outer:   [0xc0, 0x40, 0x00],  /* #outer:hover, driven from its span  */
  active:  [0x00, 0x00, 0xc8],  /* #press:active                       */
};
const rgb = (c) => c.join(', ');

const CLICK_PAGE = `<!DOCTYPE html><html><head><title>NsPtrClick</title><style>
body { margin: 0; background: #ffffff; }
#ran { width: 300px; height: 80px; background: #dddddd; }
#ran.a { background: rgb(${rgb(C.ranA)}); }
#ran.b { background: rgb(${rgb(C.ranB)}); }
a { display: block; width: 300px; height: 80px; background: #cccccc; }
</style></head><body>
<div id="ran">ran</div>
<a id="keep" href="b.html">cancelled link</a>
<a id="go" href="b.html">plain link</a>
<script>
var ran = document.getElementById('ran');
document.getElementById('keep').addEventListener('click', function (e) {
	ran.className = 'a';
	e.preventDefault();
});
/* the control: a listener that runs and does NOT cancel.  Its class flip
 * is what tells a failed navigation apart from a lost click. */
document.getElementById('go').addEventListener('click', function (e) {
	ran.className = 'b';
});
</script>
</body></html>
`;

const PAGE_B = `<!DOCTYPE html><html><head><title>NsPtrB</title><style>
#big { width: 400px; height: 300px; background: rgb(${rgb(C.pageB)}); }
</style></head><body><div id="big">page B</div></body></html>
`;

const HOVER_PAGE = `<!DOCTYPE html><html><head><title>NsPtrHover</title><style>
body { margin: 0; background: #ffffff; }
a#h { display: block; width: 300px; height: 100px;
      background: rgb(${rgb(C.base)}); }
a#h:hover { background: rgb(${rgb(C.hover)}); }
#outer { width: 300px; height: 100px; background: #eeeeee; }
#outer:hover { background: rgb(${rgb(C.outer)}); }
#inner { display: block; width: 200px; height: 60px; background: #eeeeee; }
#outer:hover #inner { background: rgb(${rgb(C.outer)}); }
#press { width: 300px; height: 100px; background: #eeeeee; }
#press:active { background: rgb(${rgb(C.active)}); }
#far { width: 300px; height: 120px; background: #ffffff; }
</style></head><body>
<a id="h" href="#">hover me</a>
<div id="outer"><span id="inner">inner</span></div>
<div id="press">press me</div>
<div id="far">nothing here</div>
</body></html>
`;

/* Box tops in the page, in content pixels.  The frontend draws the
 * document from y=0, so these are also window coordinates. */
const Y_LINK = 40;      /* inside a#h      (0..100)    */
const Y_INNER = 130;    /* inside #inner   (100..160)  */
const Y_PRESS = 250;    /* inside #press   (200..300)  */
const Y_FAR = 350;      /* inside #far     (300..420)  */

/* ---- seed boot, then plant the pages -------------------------------- */
const { dir: tmp, image } = freshImage('os-nsptr-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  rfs.mkdir('/root/ptr', 0o755);
  const plant = (p, text) => {
    const fd = rfs.open(p, W, 0o644);
    const bytes = Buffer.from(text, 'utf-8');
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  };
  plant('/root/ptr/click.html', CLICK_PAGE);
  plant('/root/ptr/b.html', PAGE_B);
  plant('/root/ptr/hover.html', HOVER_PAGE);
  rootStore.flush();
  rootStore.close();
}

/* ---- shot helpers (the netsurf-e2e pattern) ------------------------- */
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
const near = (want) => (p) => Math.abs(p[0] - want[0]) < 12 &&
                              Math.abs(p[1] - want[1]) < 12 &&
                              Math.abs(p[2] - want[2]) < 12;
function countContent(s, pred) {
  let n = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      if (pred(px(s, x, y))) n++;
    }
  }
  return n;
}
const hist = (s) => Object.fromEntries(Object.entries(C)
  .map(([k, c]) => [k, countContent(s, near(c))]));

/* Post-load settle: shot until two consecutive frames match. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];
/* A repaint with no wmctl-visible marker: poll PIXELS until the frame
 * differs from a reference (a bounded condition poll, not a fixed sleep). */
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${ref} || break; sleep 0.1; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* ---- session A: the click legs -------------------------------------- */
/* Each link gets its OWN window, because the second one navigates away
 * and a shared window would carry page B into the next leg. */
const clickOut = driveBoot([
  /* leg 1: the cancelled click */
  'netsurf /root/ptr/click.html &',
  'wmctl wait win NsPtrClick 30000',
  sidOf('K', 'NsPtrClick'),
  ...pollStable('$K', '/root/k0.ppm'),
  'echo shot-k0-ok',
  'wmctl click $K 60 120',              /* inside a#keep (80..160) */
  ...pollChange('$K', '/root/k0.ppm'),
  /* settle past the frame the class flip landed in: a navigation, had it
   * happened, would repaint again right after */
  ...pollStable('$K', '/root/k1.ppm'),
  'echo shot-k1-ok',
  'wmctl close $K && wmctl wait gone $K 8000 && echo k-closed',

  /* leg 2: the plain click, in a fresh window */
  'netsurf /root/ptr/click.html &',
  'wmctl wait win NsPtrClick 30000',
  sidOf('G', 'NsPtrClick'),
  ...pollStable('$G', '/root/g0.ppm'),
  'echo shot-g0-ok',
  'wmctl click $G 60 200',              /* inside a#go (160..240) */
  /* the navigation retitles the window, which IS a wmctl-visible marker */
  'wmctl wait win NsPtrB 20000 && echo navigated',
  ...pollStable('$G', '/root/g1.ppm'),
  'echo shot-g1-ok',
  'wmctl close $G && wmctl wait gone $G 8000 && echo g-closed',
], { image, timeout: 300000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['k0', 'k1', 'g0', 'g1']) {
  check(`shot ${tag} taken`, clickOut.includes(`shot-${tag}-ok`));
}
check('the cancelled-click window closed', clickOut.includes('k-closed'));
check('the plain-click window closed', clickOut.includes('g-closed'));

/* ---- session B: the hover / active legs ----------------------------- */
const hoverOut = driveBoot([
  'netsurf /root/ptr/hover.html &',
  'wmctl wait win NsPtrHover 30000',
  sidOf('H', 'NsPtrHover'),
  /* park the pointer well away from every probe box first, so the frames
   * below are transitions and not a first-entry artefact */
  `wmctl hover $H 600 ${Y_FAR}`,
  ...pollStable('$H', '/root/h0.ppm'),
  'echo shot-h0-ok',

  `wmctl hover $H 60 ${Y_LINK}`,
  ...pollChange('$H', '/root/h0.ppm'),
  ...pollStable('$H', '/root/h1.ppm'),
  'echo shot-h1-ok',

  /* leave the link again: the exit half of the delta */
  `wmctl hover $H 600 ${Y_FAR}`,
  ...pollChange('$H', '/root/h1.ppm'),
  ...pollStable('$H', '/root/h2.ppm'),
  'echo shot-h2-ok',

  /* the pointer on the INNER span, styling the OUTER div */
  `wmctl hover $H 60 ${Y_INNER}`,
  ...pollChange('$H', '/root/h2.ppm'),
  ...pollStable('$H', '/root/h3.ppm'),
  'echo shot-h3-ok',

  /* :active — hold the button down over #press, shoot, then release */
  `wmctl down $H 60 ${Y_PRESS}`,
  ...pollChange('$H', '/root/h3.ppm'),
  ...pollStable('$H', '/root/h4.ppm'),
  'echo shot-h4-ok',
  `wmctl up $H 60 ${Y_PRESS}`,
  ...pollChange('$H', '/root/h4.ppm'),
  ...pollStable('$H', '/root/h5.ppm'),
  'echo shot-h5-ok',

  'wmctl close $H && wmctl wait gone $H 8000 && echo h-closed',
], { image, timeout: 300000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['h0', 'h1', 'h2', 'h3', 'h4', 'h5']) {
  check(`shot ${tag} taken`, hoverOut.includes(`shot-${tag}-ok`));
}
check('the hover window closed', hoverOut.includes('h-closed'));

/* ---- read every shot back ------------------------------------------- */
const NAMES = ['k0', 'k1', 'g0', 'g1', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5'];
const back = driveBoot('cat ' + NAMES.map((n) => `/root/${n}.ppm`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 256 * 1024 * 1024 });
const shots = parsePPMs(back.stdout, NAMES);
const h = {};
for (const n of NAMES) {
  h[n] = hist(shots[n]);
  console.log(`  ${n}  ${JSON.stringify(h[n])}`);
}

/* A 300x80 block is 24000px and a 300x100 one is 30000px; 12000 is well
 * under either and far above any stray page chrome. */
const LIT = 12000;
const DARK = 400;

/* ---- todos/0419 ----------------------------------------------------- */
check('pre-click: nothing is lit', h.k0.ranA < DARK && h.k0.pageB < DARK,
      `ranA ${h.k0.ranA}, pageB ${h.k0.pageB}`);
check('0419 cancelled: the click reached the listener and its restyle PAINTED',
      h.k1.ranA > LIT, `${h.k1.ranA} px`);
check('0419 cancelled: preventDefault() stopped the navigation',
      h.k1.pageB < DARK, `${h.k1.pageB} px of page B`);

check('pre-click: the plain-link window is clean',
      h.g0.ranB < DARK && h.g0.pageB < DARK,
      `ranB ${h.g0.ranB}, pageB ${h.g0.pageB}`);
check('0419 control: an UNCANCELLED click still navigates',
      clickOut.includes('navigated') && h.g1.pageB > LIT,
      `${h.g1.pageB} px of page B`);

/* ---- todos/0420 ----------------------------------------------------- */
check('pre-hover: the link shows its base colour, no :hover anywhere',
      h.h0.base > LIT && h.h0.hover < DARK,
      `base ${h.h0.base}, hover ${h.h0.hover}`);
check('0420 hover: a:hover painted under the pointer',
      h.h1.hover > LIT, `${h.h1.hover} px`);
check('0420 hover: and it REPLACED the base colour',
      h.h1.base < DARK, `${h.h1.base} px of base left`);
check('0420 unhover: the base colour came back when the pointer left',
      h.h2.base > LIT && h.h2.hover < DARK,
      `base ${h.h2.base}, hover ${h.h2.hover}`);
check('0420 ancestor: #outer:hover painted with the pointer on its SPAN',
      h.h3.outer > LIT, `${h.h3.outer} px`);
check('0420 active: :active painted while the button was held',
      h.h4.active > LIT, `${h.h4.active} px`);
check('0420 active: and cleared at the release',
      h.h5.active < DARK, `${h.h5.active} px left`);

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf pointer-path e2e checks passed');
