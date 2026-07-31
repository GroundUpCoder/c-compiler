#!/usr/bin/env node
'use strict';
// #311: win32rc NOT semantics. rc's NOT lists bits to CLEAR from the
// ASSEMBLED style — "default | given, then clear the NOT-listed bits from
// the RESULT". Pre-fix, a bare `NOT WS_VISIBLE` tail (calc's hidden
// Dword/Word/Byte radios) evaluated to 0 and the NOT was silently dropped,
// so the control kept the keyword default's WS_VISIBLE and painted over
// the visible radio set sharing its coordinates.
//
// Run: node tests/kernel/test_win32rc.js
var { spawnSync } = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.resolve(__dirname, '../..');
var WS_VISIBLE = 0x10000000, WS_TABSTOP = 0x00010000, WS_CHILD = 0x40000000;
var WS_GROUP = 0x00020000, BS_AUTORADIOBUTTON = 0x9;

var failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function hex(v) { return '0x' + (v >>> 0).toString(16); }

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'win32rc-'));
var rc = path.join(tmp, 't.rc');
var out = path.join(tmp, 't.res');
fs.writeFileSync(rc, [
  '#define HIDDEN NOT WS_VISIBLE',
  '7 DIALOGEX 0, 0, 100, 100',
  'CAPTION "t"',
  'FONT 8, "MS Shell Dlg"',
  'BEGIN',
  // calc's exact case: a style tail that is JUST a NOT term must clear
  // the keyword default's WS_VISIBLE (AUTORADIOBUTTON default 0x50010009).
  '    AUTORADIOBUTTON "bare", 101, 0, 0, 10, 10, NOT WS_VISIBLE',
  // no tail: the keyword default is untouched.
  '    AUTORADIOBUTTON "plain", 102, 12, 0, 10, 10',
  // combined: NOT must reach a DEFAULT bit (PUSHBUTTON default carries
  // WS_TABSTOP), not just bits OR-ed earlier in the same expression.
  '    PUSHBUTTON "mix", 103, 24, 0, 10, 10, WS_GROUP | NOT WS_TABSTOP',
  // NOT clears from the RESULT, not left-to-right: a later OR of the same
  // bit does not resurrect it.
  '    CONTROL "gen", 104, "BUTTON", BS_AUTORADIOBUTTON | NOT WS_VISIBLE | WS_VISIBLE, 36, 0, 10, 10',
  // a #define carrying the NOT (the evalExprString path) behaves like the
  // inline spelling.
  '    AUTORADIOBUTTON "def", 105, 48, 0, 10, 10, HIDDEN',
  'END',
].join('\n'));

var r = spawnSync(process.execPath,
  [path.join(ROOT, 'tools/win32rc.js'), rc, '-o', out, '-q'],
  { encoding: 'utf8' });
check('win32rc exits 0', r.status === 0, r.stderr);

var controls = {};
if (r.status === 0) {
  var b = fs.readFileSync(out);
  check('WRES v2 header', b.toString('ascii', 0, 4) === 'WRES' && b.readUInt32LE(4) === 2);
  var count = b.readUInt32LE(8);
  var dlg = null;
  for (var i = 0; i < count; i++) {
    var base = 12 + i * 12;
    if (b.readUInt16LE(base) === 5) dlg = { off: b.readUInt32LE(base + 4) };
  }
  check('RT_DIALOG entry present', dlg !== null);
  if (dlg) {
    var o = dlg.off + 8;                         // skip i16 x,y,w,h
    o += 4;                                      // u32 style
    o += 2;                                      // u16 menuId
    o += 2 + b.readUInt16LE(o);                  // caption
    o += 2;                                      // fontSize
    o += 2 + b.readUInt16LE(o);                  // face
    var n = b.readUInt16LE(o); o += 2;
    for (var c = 0; c < n; c++) {
      o += 1;                                    // u8 class
      var id = b.readInt16LE(o); o += 2;
      o += 8;                                    // x,y,w,h
      var style = b.readUInt32LE(o); o += 4;
      o += 2 + b.readUInt16LE(o);                // text
      controls[id] = style >>> 0;
    }
    check('all 5 controls serialized', n === 5, String(n));
  }
}

check('bare NOT WS_VISIBLE clears the keyword default (style has no 0x10000000)',
  controls[101] !== undefined && (controls[101] & WS_VISIBLE) === 0, hex(controls[101]));
check('bare NOT keeps the rest of the default (WS_CHILD|WS_TABSTOP|BS_AUTORADIOBUTTON)',
  controls[101] === ((WS_CHILD | WS_TABSTOP | BS_AUTORADIOBUTTON) >>> 0), hex(controls[101]));
check('no tail: default untouched (0x50010009)',
  controls[102] === 0x50010009, hex(controls[102]));
check('combined NOT clears a default bit (WS_GROUP in, WS_TABSTOP out)',
  controls[103] === ((WS_CHILD | WS_VISIBLE | WS_GROUP) >>> 0), hex(controls[103]));
check('NOT clears from the RESULT (later OR does not resurrect the bit)',
  controls[104] !== undefined && (controls[104] & WS_VISIBLE) === 0, hex(controls[104]));
check('#define-carried NOT behaves like the inline spelling',
  controls[105] === controls[101], hex(controls[105]) + ' vs ' + hex(controls[101]));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? 'FAILURES: ' + failures : 'ALL OK');
process.exit(failures ? 1 : 0);
