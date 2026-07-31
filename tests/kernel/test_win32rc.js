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
  check('WRES v3 header', b.toString('ascii', 0, 4) === 'WRES' && b.readUInt32LE(4) === 3);
  var d = readDialog(b);
  check('RT_DIALOG entry present', d !== null);
  if (d) {
    for (var id0 in d.controls) controls[id0] = d.controls[id0].style;
    check('all 5 controls serialized', d.n === 5, String(d.n));
  }
}

// Walk the WRES v3 RT_DIALOG record (layout: tools/win32rc.js header
// comment — the MUST-MATCH spec) and return dialog + per-control words.
function readDialog(b) {
  var count = b.readUInt32LE(8);
  var off = -1;
  for (var i = 0; i < count; i++) {
    var base = 12 + i * 12;
    if (b.readUInt16LE(base) === 5) off = b.readUInt32LE(base + 4);
  }
  if (off < 0) return null;
  var o = off + 8;                               // skip i16 x,y,w,h
  var style = b.readUInt32LE(o); o += 4;
  var exStyle = b.readUInt32LE(o); o += 4;       // v3 (#322)
  o += 2;                                        // u16 menuId
  o += 2 + b.readUInt16LE(o);                    // caption
  o += 2;                                        // fontSize
  o += 2 + b.readUInt16LE(o);                    // face
  var n = b.readUInt16LE(o); o += 2;
  var controls = {};
  for (var c = 0; c < n; c++) {
    o += 1;                                      // u8 class
    var id = b.readInt16LE(o); o += 2;
    o += 8;                                      // x,y,w,h
    var cstyle = b.readUInt32LE(o); o += 4;
    var cex = b.readUInt32LE(o); o += 4;         // v3 (#322)
    o += 2 + b.readUInt16LE(o);                  // text
    controls[id] = { style: cstyle >>> 0, exStyle: cex >>> 0 };
  }
  return { style: style >>> 0, exStyle: exStyle >>> 0, n: n, controls: controls };
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

/* ---- #322: EXSTYLE reaches the WRES format (v3) ----
 * The dialog-level EXSTYLE statement and both control exstyle-tail
 * spellings (CONTROL tail, keyword-control tail) EMIT into the v3
 * record — u32 exstyle after each u32 style — where #318 (v) used to
 * warn-and-discard them (gap #2, the WS_EX_CLIENTEDGE class). user32's
 * dlg_create passes them to CreateWindowEx, so a template's
 * WS_EX_CLIENTEDGE really draws. The accelerator warn (gap #25) is
 * UNCHANGED — spawned WITHOUT -q so warn() shows for it. */
var rc2 = path.join(tmp2(), 'w.rc');
var out2 = path.join(path.dirname(rc2), 'w.res');
function tmp2() { return fs.mkdtempSync(path.join(os.tmpdir(), 'win32rc-')); }
fs.writeFileSync(rc2, [
  '9 DIALOGEX 0, 0, 100, 100',
  'STYLE WS_POPUP | WS_CAPTION',
  'EXSTYLE 0x200',                               // WS_EX_CLIENTEDGE
  'CAPTION "w"',
  'FONT 8, "MS Shell Dlg"',
  'BEGIN',
  '    CONTROL "gen", 201, "EDIT", WS_TABSTOP, 0, 0, 50, 12, 0x200',
  '    EDITTEXT 202, 0, 20, 50, 12, WS_TABSTOP, 0x200',
  '    LTEXT "plain", 203, 0, 40, 50, 12',
  'END',
  '10 ACCELERATORS',
  'BEGIN',
  '    "Q", 300, ASCII',
  '    VK_F5, 301, VIRTKEY',
  'END',
].join('\n'));
var r2 = spawnSync(process.execPath,
  [path.join(ROOT, 'tools/win32rc.js'), rc2, '-o', out2],
  { encoding: 'utf8' });
check('warn run exits 0 (warnings are not errors)', r2.status === 0, r2.stderr);
check('EXSTYLE no longer warns as discarded (#322: it is carried)',
  !/EXSTYLE .* discarded/.test(r2.stderr), r2.stderr);
var d2 = r2.status === 0 ? readDialog(fs.readFileSync(out2)) : null;
check('dialog-level EXSTYLE arrives in the v3 record',
  d2 !== null && d2.exStyle === 0x200, d2 && hex(d2.exStyle));
check('CONTROL exstyle-tail arrives on the control',
  d2 !== null && d2.controls[201] && d2.controls[201].exStyle === 0x200,
  d2 && d2.controls[201] && hex(d2.controls[201].exStyle));
check('keyword-control exstyle-tail arrives on the control',
  d2 !== null && d2.controls[202] && d2.controls[202].exStyle === 0x200,
  d2 && d2.controls[202] && hex(d2.controls[202].exStyle));
check('a control without a tail carries exstyle 0',
  d2 !== null && d2.controls[201] && d2.controls[202] &&
  Object.keys(d2.controls).every(function (k) {
    return k === '201' || k === '202' || d2.controls[k].exStyle === 0;
  }));
check('non-VIRTKEY accelerator entry warns as never-fires',
  /accelerator \(key 81, cmd 300\): not VIRTKEY/.test(r2.stderr), r2.stderr);
check('VIRTKEY accelerator entry does not warn',
  !/cmd 301/.test(r2.stderr), r2.stderr);
fs.rmSync(path.dirname(rc2), { recursive: true, force: true });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? 'FAILURES: ' + failures : 'ALL OK');
process.exit(failures ? 1 : 0);
