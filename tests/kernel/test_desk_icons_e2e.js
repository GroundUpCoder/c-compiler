#!/usr/bin/env node
// Ticket #82 acceptance, headless: per-filetype desktop icon glyphs — the
// wm.c desk render loop dispatches each entry through desk_kind() (bin /
// dir / exec / text / image / deck / generic) instead of drawing one flat
// navy block for every file. Seeds one file per kind on /root/Desktop,
// shots the desktop layer, and probes each glyph's signature pixels.
//
// CENTER-PIXEL CONTRACT (updated deliberately by #82, mirrored in wm.c's
// draw_icon_glyph comment): tile center (ix+12, iy+12) is NAVY for
// programs (solid block), folders (tab+body) and the FULL Recycle Bin;
// WHITE for every data-file glyph and the empty bin. Exec/dir/bin pixels
// are byte-identical to pre-#82 (the wm_service/recycle/os-shell probes).
//
// Run: node tests/kernel/test_desk_icons_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, deskEntries, deskCell } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-deskicons-');

// The grid model (drive.js, todos/0184/0185): seeded set + this test's
// five runtime files, column-major with dirs first and the bin pinned last.
const EXTRAS = ['alauncher', 'blob.dat', 'deck.mgp', 'notes.txt', 'photo.ppm'];
const LIST = deskEntries(EXTRAS);
const cellOf = (name) => deskCell(LIST, name);

const script = [
  'wmctl wait win desktop 15000',
  // One desktop file per glyph kind. Content decides runnability (the
  // activate()/desk_kind peek — no chmod needed); extension decides the
  // data kinds.
  "printf '#!/bin/sh\\ntrue\\n' > /root/Desktop/alauncher",
  "printf 'plain text\\n' > /root/Desktop/notes.txt",
  "printf 'x' > /root/Desktop/photo.ppm",
  "printf 'deck\\n' > /root/Desktop/deck.mgp",
  "printf 'y' > /root/Desktop/blob.dat",
  // The desktop re-reads /root/Desktop on the coarse 1s tick and repaints
  // on that same wake; there is no event or marker for it (the
  // openwith-e2e precedent) — a genuine no-marker settle, annotated per
  // todos/0171.
  'sleep 2',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'wmctl shot $DSID /root/d.ppm && echo D-SHOT',
];

const r = driveBoot(script, { image, timeout: 300000 });
const out = r.stdout || '';
check('desktop shot written', out.includes('D-SHOT'), out.slice(-400));

// Read the shot back out of the root volume (the recycle-e2e pattern).
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));
const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
const store = new BLOCK_FS.MemoryByteStore(bytes.length);
store.setBytes(0, bytes);
const ufs = BLOCK_FS.createV4(store);
const ppm = COMMON.readFileBytes(ufs, '/root/d.ppm');
const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1');
const m = /^P6\n(\d+) (\d+)\n255\n/.exec(head);
check('shot is a 1024x768 P6', !!m && m[1] === '1024' && m[2] === '768', head);
const off = head.indexOf('255\n') + 4, W = 1024;
const px = (x, y) => String(Array.from(
  ppm.subarray(off + (y * W + x) * 3, off + (y * W + x) * 3 + 3)));

const WHITE = '255,255,255', NAVY = '0,0,128';
// Icon tile origin inside a cell: ix = cell.x + 30, iy = cell.y + 6.
const at = (name, dx, dy) => {
  const c = cellOf(name);
  return px(c.x + 30 + dx, c.y + 6 + dy);
};
// Probe a glyph: list of [dx, dy, expected, what] triples.
const glyph = (name, kind, probes) => {
  for (const [dx, dy, want, what] of probes)
    check(`${name} (${kind}): ${what} at +${dx},+${dy}`,
          at(name, dx, dy) === want, at(name, dx, dy));
};

// DK_EXEC — a #! script keeps the pre-#82 solid block (navy center).
glyph('alauncher', 'exec', [
  [12, 12, NAVY, 'solid block center'],
  [5, 3, WHITE, 'no page outline'],
  [12, 5, WHITE, 'white above the block'],
]);
// DK_TEXT — page outline + text lines, white center.
glyph('notes.txt', 'text', [
  [5, 3, NAVY, 'page outline corner'],
  [9, 10, NAVY, 'text line'],
  [12, 12, WHITE, 'data-file white center'],
  [16, 5, WHITE, 'no dog-ear fold'],
]);
// DK_FILE — dog-eared page, no lines.
glyph('blob.dat', 'generic', [
  [5, 3, NAVY, 'page outline corner'],
  [16, 5, NAVY, 'dog-ear fold'],
  [9, 10, WHITE, 'no text lines'],
  [12, 12, WHITE, 'data-file white center'],
]);
// DK_IMAGE — frame + sun + ridge.
glyph('photo.ppm', 'image', [
  [4, 12, NAVY, 'frame left edge'],
  [8, 9, NAVY, 'sun'],
  [12, 16, NAVY, 'mountain ridge'],
  [12, 12, WHITE, 'data-file white center'],
]);
// DK_DECK — presentation screen on a stand.
glyph('deck.mgp', 'deck', [
  [4, 8, NAVY, 'screen border'],
  [7, 6, NAVY, 'title stripe'],
  [12, 18, NAVY, 'stand base'],
  [12, 12, WHITE, 'data-file white center'],
]);
// DK_DIR — the seeded Presentations folder keeps the 0185 tab+body.
glyph('Presentations', 'dir', [
  [16, 6, WHITE, 'tab notch'],
  [8, 12, NAVY, 'folder body'],
  [12, 12, NAVY, 'container navy center'],
]);
// DK_BIN — empty basket (the recycle-e2e contract, cheap to re-assert).
glyph('Recycle Bin', 'bin', [
  [12, 4, NAVY, 'basket rim'],
  [12, 12, WHITE, 'empty-bin white center'],
]);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\ndesk icons e2e: ${failures} FAILED` : '\ndesk icons e2e: PASS');
process.exit(failures ? 1 : 0);
