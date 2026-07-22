#!/usr/bin/env node
// 0272 acceptance, headless: MagicPointPlus (/bin/mgpp) — a thin -DMGPP fork
// of /bin/mgp that adds click-to-go-back and arrow-key navigation, everything
// else identical.  The delta lives behind `#ifdef MGPP` in
// vendor/magicpoint/mgp.c; mgpp is a separate binary built from
// vendor/magicpoint/mgpp.json (same sources, adds -DMGPP).
//
// This drives the seeded demo deck (/usr/share/mgp/demo.mgp — an 800x600
// window whose first four pages render pairwise-distinct: MidnightBlue title,
// green-bullets, blue->black %bgrad, magenta/cyan GIF) and asserts, by shm
// pixel identity between shots, that navigation moves the EXPECTED direction:
//   - forward baselines with `space` (unchanged): p1 -> p2 -> p3, all differ
//   - Left arrow  goes BACK    (page 3 -> page 2 == p2)
//   - Right arrow goes FORWARD (page 2 -> page 3 == p3)
//   - a LEFT-half click  goes BACK    (page 3 -> page 2 == p2)
//   - a RIGHT-half click goes FORWARD (page 2 -> page 3 == p3)
//   - `b` still goes back and `q` still quits (window closes)
//
// RED->GREEN pin: pass the OLD binary as argv[2] to prove the assertions fail
// without the fix —
//     node tests/kernel/test_mgpp_e2e.js mgp    # RED  (arrows inert; a
//                                                #       left-half click is
//                                                #       button-1 FORWARD)
//     node tests/kernel/test_mgpp_e2e.js         # GREEN (default: mgpp)
//
// Run: node tests/kernel/test_mgpp_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const BIN = process.argv[2] || 'mgpp';   // RED harness: `... mgp` must fail

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir, image } = freshImage('os-mgpp-');
// wmctl key <sid> <scancode> <sym>: sym is the SDL keycode (compiler.js
// SDLK_*), the same convention test_present_e2e.js uses for space (32).
const SDLK_LEFT = 1073741904, SDLK_RIGHT = 1073741903;
const key = (sid, sym) => 'wmctl key ' + sid + ' 0 ' + sym;
// wmctl click <sid> X Y btn: client-coord injection. The window is 800 wide,
// so the fork's hit-test splits at x=400 — 100 is the left half, 700 right.
const click = (sid, x) => 'wmctl click ' + sid + ' ' + x + ' 300 1';

/* ---- session A: drive mgpp, leave PPM shots on the root volume ---- */
const script = [
  BIN + ' /usr/share/mgp/demo.mgp &',
  'wmctl wait win MagicPoint',
  'sleep 3',                       // page 1 render (freetype at several sizes)
  'MSID=$(wmctl list | grep "MagicPoint" | sed "s/[^0-9].*//")',
  'wmctl shot $MSID /root/p1.ppm && echo p1-ok',    // page 1

  key('$MSID', 32), 'sleep 2',                       // space -> page 2
  'wmctl shot $MSID /root/p2.ppm && echo p2-ok',
  key('$MSID', 32), 'sleep 2',                       // space -> page 3
  'wmctl shot $MSID /root/p3.ppm && echo p3-ok',

  // on page 3: Left arrow -> back to page 2
  key('$MSID', SDLK_LEFT), 'sleep 2',
  'wmctl shot $MSID /root/kl.ppm && echo kl-ok',
  // on page 2: Right arrow -> forward to page 3
  key('$MSID', SDLK_RIGHT), 'sleep 2',
  'wmctl shot $MSID /root/kr.ppm && echo kr-ok',

  // on page 3: left-half click -> back to page 2
  click('$MSID', 100), 'sleep 2',
  'wmctl shot $MSID /root/cl.ppm && echo cl-ok',
  // on page 2: right-half click -> forward to page 3
  click('$MSID', 700), 'sleep 2',
  'wmctl shot $MSID /root/cr.ppm && echo cr-ok',

  // on page 3: `b` still goes back to page 2 (unchanged binding)
  key('$MSID', 'b'.charCodeAt(0)), 'sleep 2',
  'wmctl shot $MSID /root/bb.ppm && echo bb-ok',

  // `q` still quits
  key('$MSID', 'q'.charCodeAt(0)),
  'wmctl wait nowin MagicPoint',
  'echo ==mgppgone',
  'wmctl list | grep -c "MagicPoint" || true',
  'echo ==',
  'echo ALLDONE',
];
const a = driveBoot(script, { image, timeout: 300000 });
const out = a.stdout || '';
for (const s of ['p1', 'p2', 'p3', 'kl', 'kr', 'cl', 'cr', 'bb'])
  check(BIN + ' shot ' + s + ' taken', out.includes(s + '-ok'),
    JSON.stringify(out.slice(-400)));
check(BIN + ' window closed on q', section(out, 'mgppgone').trim() === '0');
check('session A completed', out.includes('ALLDONE'));

/* ---- session B: read the PPMs back and assert page identity ---- */
const NAMES = ['p1', 'p2', 'p3', 'kl', 'kr', 'cl', 'cr', 'bb'];
const b = driveBoot('cat ' + NAMES.map((n) => '/root/' + n + '.ppm').join(' ') + '\n',
  { image, timeout: 120000, maxBuffer: 64 * 1024 * 1024, encoding: null });
const buf = b.stdout;

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
check('read ' + NAMES.length + ' PPMs back', ppms.length === NAMES.length,
  'got ' + ppms.length);

// Count sampled pixels that differ between two shots (the present-test metric).
function diffCount(p1, p2) {
  if (p1.w !== p2.w || p1.h !== p2.h) return 1e9;
  let n = 0;
  for (let y = 0; y < p1.h; y += 4)
    for (let x = 0; x < p1.w; x += 4) {
      const i = p1.data + (y * p1.w + x) * 3, j = p2.data + (y * p2.w + x) * 3;
      if (p1.buf[i] !== p2.buf[j] || p1.buf[i + 1] !== p2.buf[j + 1] ||
          p1.buf[i + 2] !== p2.buf[j + 2]) n++;
    }
  return n;
}
const differ = (p, q) => diffCount(p, q) > 50;   // distinct pages
const same = (p, q) => diffCount(p, q) === 0;     // identical render == same page

if (ppms.length === NAMES.length) {
  const S = {};
  NAMES.forEach((n, i) => { S[n] = ppms[i]; });

  // sanity: the three forward baselines are pairwise-distinct pages
  check('page 1 / page 2 differ', differ(S.p1, S.p2), String(diffCount(S.p1, S.p2)));
  check('page 2 / page 3 differ', differ(S.p2, S.p3), String(diffCount(S.p2, S.p3)));
  check('page 1 / page 3 differ', differ(S.p1, S.p3), String(diffCount(S.p1, S.p3)));

  // Left arrow: page 3 -> page 2 (back)
  check('Left arrow goes BACK (matches page 2)', same(S.kl, S.p2), String(diffCount(S.kl, S.p2)));
  check('Left arrow did NOT stay on page 3', differ(S.kl, S.p3), String(diffCount(S.kl, S.p3)));
  // Right arrow: page 2 -> page 3 (forward)
  check('Right arrow goes FORWARD (matches page 3)', same(S.kr, S.p3), String(diffCount(S.kr, S.p3)));

  // left-half click: page 3 -> page 2 (back)
  check('left-half click goes BACK (matches page 2)', same(S.cl, S.p2), String(diffCount(S.cl, S.p2)));
  check('left-half click did NOT advance to page 3', differ(S.cl, S.p3), String(diffCount(S.cl, S.p3)));
  // right-half click: page 2 -> page 3 (forward)
  check('right-half click goes FORWARD (matches page 3)', same(S.cr, S.p3), String(diffCount(S.cr, S.p3)));

  // `b` still goes back: page 3 -> page 2
  check('b still goes BACK (matches page 2)', same(S.bb, S.p2), String(diffCount(S.bb, S.p2)));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? 'FAILED (' + failures + ')' : 'PASSED');
process.exit(failures ? 1 : 0);
