#!/usr/bin/env node
// mgp live-reload over FS_WATCH (ticket #75), headless: the MagicPoint
// viewer opens a PATH-keyed watch fd on its deck (vendor/magicpoint/mgp.c,
// fsw_open at startup) and composes it into the settled-page idle park
// (sdlx_wait_event_fd -> the 0178 unified WAIT{watch fd ⊕ input ring}).
// An EXTERNAL deck edit wakes the park and fl_reload()s — no keystroke, on
// any page. Both editor save shapes are proven by background-color swaps:
//   - tmp + RENAME-OVER (the atomic-save pattern that defeats a per-inode
//     inotify watch): the watch survives and the new deck renders
//   - direct truncate-rewrite (`echo > deck`, the O_TRUNC + write + close
//     settle): ditto
// Colors are deck-proven X11 names (MidnightBlue -> DarkGreen ->
// DarkSlateGray), asserted as the dominant shot color, so the check is
// "the RELOADED deck rendered", not merely "pixels changed".
//
// Run: node tests/kernel/test_mgp_livereload_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir, image } = freshImage('os-mgp-live-');
const keys = (sid, ch) => 'wmctl key ' + sid + ' 0 ' + ch.charCodeAt(0);

// One tiny self-contained deck per background color (no images — cwd is
// /root). The font line matches the seeded face.
// TWO pages, and the viewer stays on page 1: upstream mgp's own 2s ctime
// poll (wantreload) only fires when PAUSED or on the LAST page, so a
// reload observed here is attributable to the FS_WATCH park wake alone —
// on the pre-watch tree this test fails (that's the red).
const deckLines = (back, title, out, op) => [
  `echo '%deffont "standard" tfont "/usr/share/fonts/mono.ttf"' ${op} ${out}`,
  `echo '%default 1 area 90 90, size 2, fore "white", back "${back}", font "standard"' >> ${out}`,
  `echo '%page' >> ${out}`,
  `echo '' >> ${out}`,
  `echo '${title}' >> ${out}`,
  `echo '%page' >> ${out}`,
  `echo '' >> ${out}`,
  `echo 'page two (never shown)' >> ${out}`,
];

const script = [
  ...deckLines('MidnightBlue', 'Live One', '/root/live.mgp', '>'),
  'cd /root && mgp live.mgp &',
  'wmctl wait win MagicPoint',
  'sleep 3',                     // title render settle (freetype; no marker)
  'LSID=$(wmctl list | grep "MagicPoint" | sed "s/[^0-9].*//")',
  'wmctl shot $LSID /root/r1.png && echo r1-ok',
  // Leg 1 — THE HEADLINE: tmp + rename-over, the editor atomic save. A
  // per-inode watch would now be watching a dead inode; the path-keyed
  // watch gets the rename-onto settle and mgp reloads.
  ...deckLines('DarkGreen', 'Live Two', '/root/live.tmp', '>'),
  'mv /root/live.tmp /root/live.mgp && echo mv-ok',
  'sleep 4',                     // watch wake -> fl_reload -> re-render (no marker)
  'wmctl shot $LSID /root/r2.png && echo r2-ok',
  // Leg 2 — direct truncate-rewrite (O_TRUNC + write + close settle).
  ...deckLines('DarkSlateGray', 'Live Three', '/root/live.mgp', '>'),
  'sleep 4',                     // watch wake -> fl_reload -> re-render (no marker)
  'wmctl shot $LSID /root/r3.png && echo r3-ok',
  'echo ==alive',
  'wmctl list | grep -c "MagicPoint" || true',
  'echo ==',
  keys('$LSID', 'q'),
  'wmctl wait nowin MagicPoint',
  'echo ALLDONE',
];

const a = driveBoot(script, { image, timeout: 300000 });
const out = a.stdout || '';
check('deck launched + shot 1 taken', out.includes('r1-ok'), out.slice(-800));
check('rename-over performed', out.includes('mv-ok'));
check('shot 2 taken', out.includes('r2-ok'));
check('shot 3 taken', out.includes('r3-ok'));
check('mgp still alive after both reloads', section(out, 'alive').trim() === '1',
  JSON.stringify(section(out, 'alive')));
check('session A completed', out.includes('ALLDONE'));

/* ---- session B: read the shots back and assert the deck that rendered ---- */
const b = driveBoot('cat /root/r1.png /root/r2.png /root/r3.png\n',
  { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
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
check('read 3 PNGs back', shots.length === 3, 'got ' + shots.length);

const near = (v, t) => Math.abs(v - t) <= 12;
function dominant(shot, [r, g, b]) {
  let n = 0;
  const total = shot.w * shot.h;
  for (let y = 0; y < shot.h; y++)
    for (let x = 0; x < shot.w; x++) {
      const i = (y * shot.w + x) * 4;
      if (near(shot.rgba[i], r) && near(shot.rgba[i + 1], g) && near(shot.rgba[i + 2], b)) n++;
    }
  return n / total;
}

if (shots.length === 3) {
  const [r1, r2, r3] = shots;
  check('shot 1: MidnightBlue deck rendered', dominant(r1, [25, 25, 112]) > 0.6,
    dominant(r1, [25, 25, 112]).toFixed(3));
  check('shot 2: rename-over save auto-reloaded to the DarkGreen deck',
    dominant(r2, [0, 100, 0]) > 0.6, dominant(r2, [0, 100, 0]).toFixed(3));
  check('shot 3: truncate-rewrite auto-reloaded to the DarkSlateGray deck',
    dominant(r3, [47, 79, 79]) > 0.6, dominant(r3, [47, 79, 79]).toFixed(3));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nmgp live-reload e2e: PASS' : `\nmgp live-reload e2e: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
