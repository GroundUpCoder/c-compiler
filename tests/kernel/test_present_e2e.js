#!/usr/bin/env node
// 0119 acceptance, headless: the presentation tools — suckless sent and
// MagicPoint (mgp), both display-ported Xlib -> SDL (vendor/sent,
// vendor/magicpoint) and seeded with demo decks:
// sent is a gucman package since the deploy-leg split (the fat fixture
// folds it to /usr/opt/sent; its decks reference images relative to the
// package share/ dir, so its launch cd's there first). mgp is BAKED
// (ticket #80 reversed its #72 package pull): /bin/mgp + decks at
// /usr/share/mgp with absolute image refs, launchable from any cwd.
//   - `sent demo.sent` opens an 800x500 window: slide 1 is
//     black-on-white text (drw over freetype); space advances (pixels
//     change), q quits and the window closes
//   - `mgp /usr/share/mgp/demo.mgp` opens an 800x600 "MagicPoint" window:
//     page 1 is white text on the deck's MidnightBlue %default background;
//     space advances to the bulleted page whose %tab icons are pure-green
//     boxes (the icon + tab directive path); q quits cleanly
// Shots are shm and bit-exact; assertions are dominant-color + presence
// counts, not golden images, so font rasterization details stay free.
//
// Run: node tests/kernel/test_present_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir, image } = freshImage('os-present-');
const keys = (sid, ch) => 'wmctl key ' + sid + ' 0 ' + ch.charCodeAt(0);

/* ---- session A: drive both apps, leave PNG shots on the root volume ---- */
const script = [
  // sent — driven through the `slides` launcher (todos/0444), not a manual
  // cd + bare binary: the baked launcher at /usr/bin/slides probes
  // /usr/opt/sent and cd's to share/ ITSELF (deck + image refs are
  // CWD-relative), so this leg is the cd-form launcher's regression guard —
  // if the launcher loses its cd, sent cannot open demo.sent and the
  // `wmctl wait win sent` below fails loud.
  'slides &',
  'wmctl wait win sent',
  'sleep 2',                     // first paint: freetype title render
  'SSID=$(wmctl list | grep "\tsent$" | sed "s/[^0-9].*//")',
  'wmctl shot $SSID /root/s1.png && echo s1-ok',
  keys('$SSID', ' '),
  'sleep 1.5',
  'wmctl shot $SSID /root/s2.png && echo s2-ok',
  keys('$SSID', 'q'),
  'sleep 1.5',
  'echo ==sentgone',
  'wmctl list | grep -c "\tsent$" || true',
  'echo ==',
  // mgp
  'mgp /usr/share/mgp/demo.mgp &',
  'wmctl wait win MagicPoint',
  'sleep 3',                     // page 1 render (freetype at several sizes)
  'MSID=$(wmctl list | grep "MagicPoint" | sed "s/[^0-9].*//")',
  'wmctl shot $MSID /root/m1.png && echo m1-ok',
  keys('$MSID', ' '),
  'sleep 2',
  'wmctl shot $MSID /root/m2.png && echo m2-ok',
  keys('$MSID', ' '),
  'sleep 2',
  'wmctl shot $MSID /root/m3.png && echo m3-ok',
  keys('$MSID', ' '),
  'sleep 2',
  'wmctl shot $MSID /root/m4.png && echo m4-ok',
  keys('$MSID', 'q'),
  'sleep 1.5',
  'echo ==mgpgone',
  'wmctl list | grep -c "MagicPoint" || true',
  'echo ==',
];

/* ---- the 0185 Presentations showcase decks: each launches, renders its
 * title page (shot 1) and its second page (shot 2), then pages through the
 * REST of the deck (`steps` covers every %page + %pause stop) so a
 * draw-time crash on any page can't hide — the window must still be alive
 * before q. Backgrounds are per-deck distinct; pixel asserts in session B. */
const DECKS = [
  { n: 'text',        back: [72, 61, 139], steps: 6 },   // DarkSlateBlue
  { n: 'colors',      back: [26, 26, 26],  steps: 6 },   // gray10
  { n: 'align',       back: [47, 79, 79],  steps: 5 },   // DarkSlateGray
  { n: 'bullets',     back: [25, 25, 112], steps: 5 },   // MidnightBlue
  { n: 'images',      back: [51, 51, 51],  steps: 7 },   // gray20
  { n: 'backgrounds', back: [0, 0, 0],     steps: 7 },   // black
  { n: 'effects',     back: [25, 25, 112], steps: 10 },  // MidnightBlue (+5 pauses)
];
/* ---- the 0202 learn-mgp tutorial series (Presentations folder): same
 * launch/page-through/alive gate; steps = %page count + %pause count. */
const TUTORIAL = [
  { n: '01-welcome',     back: [25, 25, 112], steps: 8 },   // MidnightBlue
  { n: '02-first-deck',  back: [47, 79, 79],  steps: 10 },  // DarkSlateGray
  { n: '03-text',        back: [72, 61, 139], steps: 9 },   // DarkSlateBlue
  { n: '04-color',       back: [26, 26, 26],  steps: 7 },   // gray10
  { n: '05-alignment',   back: [0, 100, 0],   steps: 8 },   // DarkGreen
  { n: '06-lists',       back: [25, 25, 112], steps: 8 },   // MidnightBlue
  { n: '07-images',      back: [51, 51, 51],  steps: 7 },   // gray20
  { n: '08-backgrounds', back: [0, 0, 0],     steps: 8 },   // black
  { n: '09-builds',      back: [25, 25, 112], steps: 11 },  // MidnightBlue (+4 pauses)
  { n: '10-mastery',     back: [16, 32, 64],  steps: 9 },   // #102040 hex
].map((d) => ({ ...d, sub: 'tutorial/' }));
/* ---- the 0221 talk decks (Presentations/POSIX on WebAssembly): same
 * launch/page-through/alive gate. */
const TALKS = [
  { n: 'posix-on-wasm', back: [48, 24, 72], steps: 13, sub: 'talks/' },  // #301848
];
const ALL = DECKS.concat(TUTORIAL, TALKS);
for (const d of ALL) {
  script.push(
    `mgp /usr/share/mgp/${d.sub || ''}${d.n}.mgp &`,
    'wmctl wait win MagicPoint',
    'sleep 2.5',                   // title page render (freetype at several sizes)
    'MSID=$(wmctl list | grep "MagicPoint" | sed "s/[^0-9].*//")',
    `wmctl shot $MSID /root/${d.n}1.png && echo ${d.n}1-ok`,
    keys('$MSID', ' '),
    'sleep 1.5',                   // page 2 render (images/bgrad decode)
    `wmctl shot $MSID /root/${d.n}2.png && echo ${d.n}2-ok`);
  for (let i = 2; i < d.steps; i++)
    script.push(keys('$MSID', ' '), 'sleep 0.6');   // page-N draw settle before the next advance (no marker)
  script.push(
    'sleep 1',                     // last page draw settle (no marker)
    `echo ==${d.n}alive`,
    'wmctl list | grep -c "MagicPoint" || true',
    'echo ==',
    keys('$MSID', 'q'),
    'wmctl wait nowin MagicPoint');
}
script.push('echo ALLDONE');
const a = driveBoot(script, { image, timeout: 900000 });
const out = a.stdout || '';
check('sent shot 1 taken', out.includes('s1-ok'));
check('sent shot 2 taken', out.includes('s2-ok'));
check('sent window closed on q', section(out, 'sentgone').trim() === '0');
check('mgp shot 1 taken', out.includes('m1-ok'));
check('mgp shot 2 taken', out.includes('m2-ok'));
check('mgp shot 3 taken', out.includes('m3-ok'));
check('mgp shot 4 taken', out.includes('m4-ok'));
check('mgp window closed on q', section(out, 'mgpgone').trim() === '0');
for (const d of ALL) {
  check(`${d.n} shots taken`,
    out.includes(d.n + '1-ok') && out.includes(d.n + '2-ok'));
  check(`${d.n} survived every page (no draw-time crash)`,
    section(out, d.n + 'alive').trim() === '1',
    JSON.stringify(section(out, d.n + 'alive')));
}
check('session A completed', out.includes('ALLDONE'));

/* ---- session B: read the PNGs back and assert pixels ---- */
const DECK_SHOTS = ALL.flatMap((d) => [`/root/${d.n}1.png`, `/root/${d.n}2.png`]);
const b = driveBoot('cat /root/s1.png /root/s2.png /root/m1.png /root/m2.png /root/m3.png /root/m4.png ' +
  DECK_SHOTS.join(' ') + '\n',
  { image, timeout: 120000, maxBuffer: 160 * 1024 * 1024, encoding: null });
const buf = b.stdout;

function parseShots(buffer) {
  // concatenated PNG shots; stop at the first non-PNG byte (trailing tty
  // noise after the last cat-back is normal)
  const shots = [];
  let off = 0;
  while (off < buffer.length) {
    let p;
    try { p = parsePng(buffer, off); } catch (e) { break; }
    shots.push(p);
    off = p.next;
  }
  return shots;
}
const shots = parseShots(buf);
const NSHOTS = 6 + DECK_SHOTS.length;
check(`read ${NSHOTS} PNGs back`, shots.length === NSHOTS, 'got ' + shots.length);

function count(shot, pred) {
  let n = 0;
  for (let y = 0; y < shot.h; y++)
    for (let x = 0; x < shot.w; x++) {
      const i = (y * shot.w + x) * 4;
      if (pred(shot.rgba[i], shot.rgba[i + 1], shot.rgba[i + 2])) n++;
    }
  return n;
}
function differ(p1, p2) {
  if (p1.w !== p2.w || p1.h !== p2.h) return true;
  let n = 0;
  for (let y = 0; y < p1.h; y += 4)
    for (let x = 0; x < p1.w; x += 4) {
      const i = (y * p1.w + x) * 4, j = (y * p2.w + x) * 4;
      if (p1.rgba[i] !== p2.rgba[j] || p1.rgba[i + 1] !== p2.rgba[j + 1] ||
          p1.rgba[i + 2] !== p2.rgba[j + 2]) n++;
    }
  return n > 50;
}

if (shots.length === NSHOTS) {
  const [s1, s2, m1, m2, m3, m4] = shots;
  const spix = s1.w * s1.h;
  // sent slide 1: white background, black "sent" title
  const white = count(s1, (r, g, b) => r > 240 && g > 240 && b > 240);
  const dark = count(s1, (r, g, b) => r < 60 && g < 60 && b < 60);
  check('sent slide 1 mostly white bg', white > spix * 0.7, white + '/' + spix);
  check('sent slide 1 has dark glyph pixels', dark > 200, String(dark));
  check('sent advances on space', differ(s1, s2));

  // mgp page 1: MidnightBlue (25,25,112) %default background + white title
  const mpix = m1.w * m1.h;
  const navy = count(m1, (r, g, b) => r < 60 && g < 60 && b > 70 && b < 150);
  const bright = count(m1, (r, g, b) => r > 200 && g > 200 && b > 200);
  check('mgp page 1 MidnightBlue bg', navy > mpix * 0.6, navy + '/' + mpix);
  check('mgp page 1 has white glyph pixels', bright > 200, String(bright));
  check('mgp advances on space', differ(m1, m2));

  // mgp page 2: %tab 1 "icon box green 50" bullets — pure green boxes
  const green = count(m2, (r, g, b) => r < 80 && g > 200 && b < 80);
  check('mgp page 2 has green box icons', green > 100, String(green));

  // mgp page 3: %bgrad blue->black — the imageToXImage/background-pixmap
  // path (this page CRASHED before the 9-arg imageToXImage arity fix)
  check('mgp page 3 differs from page 2', differ(m2, m3));
  let topBlue = 0, botDark = 0;
  for (let x = 0; x < m3.w; x += 4) {
    let i = (10 * m3.w + x) * 4;
    if (m3.rgba[i] < 90 && m3.rgba[i + 1] < 90 && m3.rgba[i + 2] > 120) topBlue++;
    i = ((m3.h - 10) * m3.w + x) * 4;
    if (m3.rgba[i] < 50 && m3.rgba[i + 1] < 50 && m3.rgba[i + 2] < 70) botDark++;
  }
  check('mgp page 3 gradient: blue top band', topBlue > m3.w / 8, String(topBlue));
  check('mgp page 3 gradient: dark bottom band', botDark > m3.w / 8, String(botDark));

  // mgp page 4: %newimage static GIF (200x150, left magenta / right cyan)
  // decoded via the vendored giflib — colours on no other slide, so their
  // presence proves the GIF loader ran and the raster mapped palette->RGB.
  check('mgp page 4 differs from page 3', differ(m3, m4));
  const magenta = count(m4, (r, g, b) => r > 200 && g < 80 && b > 200);
  const cyan = count(m4, (r, g, b) => r < 80 && g > 200 && b > 200);
  check('mgp page 4 GIF: magenta pixels', magenta > 1000, String(magenta));
  check('mgp page 4 GIF: cyan pixels', cyan > 1000, String(cyan));

  // ---- the 0185 showcase + 0202 tutorial decks (title + page-2 shots) ----
  const deck = {};
  ALL.forEach((d, i) => { deck[d.n] = [shots[6 + i * 2], shots[6 + i * 2 + 1]]; });
  const nearC = (p, q, tol = 14) => Math.abs(p - q) <= tol;
  for (const d of ALL) {
    const [t, p2] = deck[d.n];
    const tpix = t.w * t.h;
    const bg = count(t, (r, g, b) =>
      nearC(r, d.back[0]) && nearC(g, d.back[1]) && nearC(b, d.back[2]));
    check(`${d.n} title: dominant deck background`, bg > tpix * 0.55,
      bg + '/' + tpix);
    const glyph = count(t, (r, g, b) => r > 200 && g > 200 && b > 200);
    check(`${d.n} title: white title glyphs`, glyph > 150, String(glyph));
    check(`${d.n} advances on space`, differ(t, p2));
  }
  // per-deck capability witnesses on page 2:
  //   colors — the named-color column (pure red among them)
  check('colors page 2: red pixels', count(deck.colors[1],
    (r, g, b) => r > 200 && g < 60 && b < 60) > 80, undefined);
  //   bullets — %icon box SpringGreen + arc gold at tab depths
  check('bullets page 2: SpringGreen box icons', count(deck.bullets[1],
    (r, g, b) => r < 80 && g > 200 && b > 60 && b < 180) > 60, undefined);
  check('bullets page 2: gold arc icons', count(deck.bullets[1],
    (r, g, b) => r > 200 && g > 170 && b < 80) > 40, undefined);
  //   images — the natural-size demo.gif (magenta/cyan halves)
  check('images page 2: GIF magenta pixels', count(deck.images[1],
    (r, g, b) => r > 200 && g < 80 && b > 200) > 1000, undefined);
  check('images page 2: GIF cyan pixels', count(deck.images[1],
    (r, g, b) => r < 80 && g > 200 && b > 200) > 1000, undefined);
  //   backgrounds — the bare %bgrad default (blue top -> black bottom)
  {
    const g2 = deck.backgrounds[1];
    let topBlue = 0, botDark = 0;
    for (let x = 0; x < g2.w; x += 4) {
      let i = (10 * g2.w + x) * 4;
      if (g2.rgba[i] < 90 && g2.rgba[i + 1] < 90 && g2.rgba[i + 2] > 120) topBlue++;
      i = ((g2.h - 10) * g2.w + x) * 4;
      if (g2.rgba[i] < 50 && g2.rgba[i + 1] < 50 && g2.rgba[i + 2] < 70) botDark++;
    }
    check('backgrounds page 2 gradient: blue top band', topBlue > g2.w / 8, String(topBlue));
    check('backgrounds page 2 gradient: dark bottom band', botDark > g2.w / 8, String(botDark));
  }
  //   effects — the first %pause stop shows the tab-1 SpringGreen box
  check('effects page 2: SpringGreen box icon', count(deck.effects[1],
    (r, g, b) => r < 80 && g > 200 && b > 60 && b < 180) > 30, undefined);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? 'FAILED (' + failures + ')' : 'PASSED');
process.exit(failures ? 1 : 0);
