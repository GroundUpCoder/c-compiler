#!/usr/bin/env node
// 0119 acceptance, headless: the presentation tools — suckless sent and
// MagicPoint (mgp), both display-ported Xlib -> SDL (vendor/sent,
// vendor/magicpoint) and seeded with demo decks:
//   - `sent /usr/share/sent/demo.sent` opens an 800x500 window: slide 1 is
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

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir, image } = freshImage('os-present-');
const keys = (sid, ch) => 'wmctl key ' + sid + ' 0 ' + ch.charCodeAt(0);

/* ---- session A: drive both apps, leave PPMs on the root volume ---- */
const script = [
  // sent
  'sent /usr/share/sent/demo.sent &',
  'wmctl wait win sent',
  'sleep 2',                     // first paint: freetype title render
  'SSID=$(wmctl list | grep "\tsent$" | sed "s/[^0-9].*//")',
  'wmctl shot $SSID /root/s1.ppm && echo s1-ok',
  keys('$SSID', ' '),
  'sleep 1.5',
  'wmctl shot $SSID /root/s2.ppm && echo s2-ok',
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
  'wmctl shot $MSID /root/m1.ppm && echo m1-ok',
  keys('$MSID', ' '),
  'sleep 2',
  'wmctl shot $MSID /root/m2.ppm && echo m2-ok',
  keys('$MSID', ' '),
  'sleep 2',
  'wmctl shot $MSID /root/m3.ppm && echo m3-ok',
  keys('$MSID', 'q'),
  'sleep 1.5',
  'echo ==mgpgone',
  'wmctl list | grep -c "MagicPoint" || true',
  'echo ==',
  'echo ALLDONE',
];
const a = driveBoot(script, { image, timeout: 420000 });
const out = a.stdout || '';
check('sent shot 1 taken', out.includes('s1-ok'));
check('sent shot 2 taken', out.includes('s2-ok'));
check('sent window closed on q', section(out, 'sentgone').trim() === '0');
check('mgp shot 1 taken', out.includes('m1-ok'));
check('mgp shot 2 taken', out.includes('m2-ok'));
check('mgp shot 3 taken', out.includes('m3-ok'));
check('mgp window closed on q', section(out, 'mgpgone').trim() === '0');
check('session A completed', out.includes('ALLDONE'));

/* ---- session B: read the PPMs back and assert pixels ---- */
const b = driveBoot('cat /root/s1.ppm /root/s2.ppm /root/m1.ppm /root/m2.ppm /root/m3.ppm\n',
  { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
const buf = b.stdout;

// Parse concatenated binary P6 PPMs.
function parsePpms(buffer) {
  const ppms = [];
  let off = 0;
  while (off < buffer.length) {
    const head = buffer.slice(off, off + 64).toString('latin1');
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) break;
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    const data = off + m[0].length;
    ppms.push({ w, h, data, buf: buffer });
    off = data + w * h * 3;
  }
  return ppms;
}
const ppms = parsePpms(buf);
check('read 5 PPMs back', ppms.length === 5, 'got ' + ppms.length);

function count(ppm, pred) {
  let n = 0;
  for (let y = 0; y < ppm.h; y++)
    for (let x = 0; x < ppm.w; x++) {
      const i = ppm.data + (y * ppm.w + x) * 3;
      if (pred(ppm.buf[i], ppm.buf[i + 1], ppm.buf[i + 2])) n++;
    }
  return n;
}
function differ(p1, p2) {
  if (p1.w !== p2.w || p1.h !== p2.h) return true;
  let n = 0;
  for (let y = 0; y < p1.h; y += 4)
    for (let x = 0; x < p1.w; x += 4) {
      const i = p1.data + (y * p1.w + x) * 3, j = p2.data + (y * p2.w + x) * 3;
      if (p1.buf[i] !== p2.buf[j] || p1.buf[i + 1] !== p2.buf[j + 1] ||
          p1.buf[i + 2] !== p2.buf[j + 2]) n++;
    }
  return n > 50;
}

if (ppms.length === 5) {
  const [s1, s2, m1, m2, m3] = ppms;
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
    let i = m3.data + (10 * m3.w + x) * 3;
    if (m3.buf[i] < 90 && m3.buf[i + 1] < 90 && m3.buf[i + 2] > 120) topBlue++;
    i = m3.data + ((m3.h - 10) * m3.w + x) * 3;
    if (m3.buf[i] < 50 && m3.buf[i + 1] < 50 && m3.buf[i + 2] < 70) botDark++;
  }
  check('mgp page 3 gradient: blue top band', topBlue > m3.w / 8, String(topBlue));
  check('mgp page 3 gradient: dark bottom band', botDark > m3.w / 8, String(botDark));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? 'FAILED (' + failures + ')' : 'PASSED');
process.exit(failures ? 1 : 0);
