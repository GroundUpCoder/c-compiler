#!/usr/bin/env node
// #435 acceptance: the Mac modifier symbols render on a CLEAN FIRST BOOT with
// NO packages installed — Noto Sans Symbols 2 is BAKED at
// /usr/share/fonts/symbols2.ttf and registered in the baked fallback list
// /usr/share/fonts/fallback (fontchain.h's /usr layer; the /etc layer stays
// absent on a virgin image, so gucman font-package install/remove semantics
// are untouched).
//
// Instruments (the test_fontpkg_e2e.js pattern):
//   - baked-image leg: the BOOTED minimal image (not the manifest) carries the
//     face and the list line;
//   - term pixel leg (cp_glyph): ⌘ ⌥ ⇧ ⌫ ⏎ render ink, pairwise DISTINCT,
//     and differ from the tofu box;
//   - gdi32 leg (font_glyph — the SAME chain path wm.c menus/chrome draw
//     through via TextOut): notepad on the same file prints exactly ONE
//     "unsupported font glyph" report and it names U+0378, never U+2318.
//
// In-run tofu controls (the #97 vacuity standard): U+0378/U+0379 are
// PERMANENTLY UNASSIGNED in Unicode (verified glyph 0 in every vendored face,
// 2026-08-05), so they render the synthesized tofu box forever — both cells
// byte-identical proves the pixel instrument still SEES tofu, and their gdi32
// report proves the stderr instrument is live in the very process under test.
// Red control (pre-fix tree): no baked list, all five symbol cells collapse to
// the identical tofu box, and the notepad report names U+2318.
//
// U+2303 ⌃ is deliberately NOT asserted: measured 2026-08-05, Noto Sans
// Symbols 2 does not map it (glyph 0; it lives in Noto Sans Symbols (1), a
// different family). #435 ruled Symbols 2 only — the ⌃ gap is reported in the
// lane report, not hidden here.
//
// Run: node tests/kernel/test_symbolfont_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ensureMinimalImage } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// "⌘ ⌥ ⇧ ⌫ ⏎ <U+0378> <U+0379>" as explicit UTF-8 byte escapes for busybox
// printf — glyphs space-separated so a proportional chain glyph overflowing
// its 8px mono cell spills into a BLANK cell, never the next sample.
const SYMS = '\\xe2\\x8c\\x98 \\xe2\\x8c\\xa5 \\xe2\\x87\\xa7 \\xe2\\x8c\\xab' +
             ' \\xe2\\x8f\\x8e \\xcd\\xb8 \\xcd\\xb9';

async function main() {
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-symbolfont-');
  fs.copyFileSync(MIN, image);
  const BOOT_ARGS = { image, args: ['--packages=none'], timeout: 600000 };

  const a = driveBoot([
    'echo ==baked',
    'test -f /usr/share/fonts/symbols2.ttf && echo SYM-TTF-OK',
    'cat /usr/share/fonts/fallback',
    'test ! -e /etc/fonts/fallback && echo NO-ETC-FALLBACK',
    `printf '${SYMS}\\n' > /root/sym.txt`,
    'echo ==term',
    'term sh -c "cat /root/sym.txt; sleep 300" &',
    'wmctl wait win term',
    'sleep 2',                       // timing subject: freetype render (multi-frame, no signal)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'wmctl shot $TSID /root/sym.ppm && echo shot-sym-ok',
    'pkill term',
    'wmctl wait nowin term',
    'echo ==gdi',
    'notepad /root/sym.txt &',
    'wmctl wait win "sym.txt - Notepad"',
    'sleep 2',                       // timing subject: EDIT paint (multi-frame, no signal)
    'pkill notepad',
    'wmctl wait nowin "sym.txt - Notepad"',
    'echo ==done',
  ], BOOT_ARGS);
  const aout = String(a.stdout || '');
  const aall = aout + '\n' + String(a.stderr || '');

  const baked = section(aout, 'baked');
  check('baked image carries /usr/share/fonts/symbols2.ttf', baked.includes('SYM-TTF-OK'),
    baked.slice(0, 200));
  check('baked /usr/share/fonts/fallback lists the symbol face',
    baked.includes('/usr/share/fonts/symbols2.ttf'), baked.slice(0, 200));
  check('clean boot has no /etc fallback delta', baked.includes('NO-ETC-FALLBACK'));
  check('term shot written', aout.includes('shot-sym-ok'));

  // gdi32 chain, by stderr (the fontpkg counting instrument): the report is
  // once-per-call-site per PROCESS, so notepad reports only its FIRST
  // uncovered cp. Green: the five symbols resolve via the chain, so the first
  // miss is the unassigned U+0378 control — exactly one report, naming it.
  // Red: the first miss is U+2318 itself. The U+0378 report doubles as the
  // positive control that the reporting path is alive in this process.
  const tofuReports = (aall.match(/unsupported font glyph/g) || []).length;
  check('gdi32: exactly one tofu report and it names the U+0378 control',
    tofuReports === 1 && /unsupported font glyph U\+0378/.test(aall),
    String(tofuReports) + ' report(s): ' +
      (aall.match(/unsupported font glyph U\+[0-9A-F]+/g) || []).join(','));
  check('gdi32: no modifier symbol reports as tofu',
    !/unsupported font glyph U\+(2318|2325|21E7|232B|23CE)/.test(aall));
  check('gdi32: the baked symbol face loads (no cannot-load report)',
    !/fallback face .* cannot load/.test(aall));

  // ---- pixel proof (term) --------------------------------------------
  const b = driveBoot('cat /root/sym.ppm\n',
    { image, args: ['--packages=none'], timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  // One 16x19 bitmap per glyph at row 0: glyph i sits in cell 2i (8px cells,
  // space-separated), sampled with its trailing blank cell to keep any
  // proportional overflow inside the sample. Row 0 renders below the 30px
  // term menu bar band (todos/0273c), as in test_fontpkg_e2e.js.
  const GRID_Y = 30;
  function glyphBits(buf, ppm, i) {
    const out = Buffer.alloc(16 * 19 * 3);
    for (let y = 0; y < 19; y++) {
      for (let x = 0; x < 16; x++) {
        const s = ppm.data + ((GRID_Y + y) * ppm.w + (i * 16 + x)) * 3;
        buf.copy(out, (y * 16 + x) * 3, s, s + 3);
      }
    }
    return out;
  }
  const ink = (bits) => { let n = 0; for (const v of bits) if (v) n++; return n; };
  const ppm = parsePPM(b.stdout, 0);
  check('shot parses', !!ppm);
  if (!ppm) return finish(tmp);

  const NAMES = ['U+2318 cmd', 'U+2325 option', 'U+21E7 shift', 'U+232B delete-left', 'U+23CE return'];
  const g = [0, 1, 2, 3, 4].map((i) => glyphBits(b.stdout, ppm, i));
  const t = [5, 6].map((i) => glyphBits(b.stdout, ppm, i));
  check('tofu control: both unassigned cells render ink', t.every((x) => ink(x) > 0),
    t.map(ink).join(','));
  check('tofu control: one box, twice (cells byte-identical)', t[0].equals(t[1]));
  check('symbols: all five glyphs render ink', g.every((x) => ink(x) > 0), g.map(ink).join(','));
  for (let i = 0; i < 5; i++)
    check(`symbols: ${NAMES[i]} is not the tofu box`, !g[i].equals(t[0]));
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++)
      check(`symbols: ${NAMES[i]} != ${NAMES[j]}`, !g[i].equals(g[j]));

  finish(tmp);
}

function finish(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nsymbolfont e2e: ${failures} FAILED` : '\nsymbolfont e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
