#!/usr/bin/env node
// P0 repro: typing punctuation whose ASCII code collides with a virtual-key
// navigation code misdrives the EDIT control's WM_KEYDOWN handler.
//
// Mechanism (user32.c vk_of, the "punctuation: approximate" fall-through):
//   '  = 0x27 -> VK_RIGHT  : caret steps forward BEFORE the WM_CHAR insert —
//                            at end-of-line with a following line it crosses
//                            the \n, so the quote lands on the NEXT line.
//   .  = 0x2E -> VK_DELETE : forward-delete fires BEFORE the insert — eats
//                            the char after the caret (the \n at EOL: joins
//                            the next line up). DATA LOSS.
// Every other US-layout punctuation key must insert cleanly at the same spot.
//
// Run: node tests/kernel/test_edit_punct_repro.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-editpunct-');

// The matrix: each key typed at the END of line 1 of "abc\ndef" (caret parked
// by 2xUP + END — WM_SETTEXT leaves the caret wherever it was). scancode/sym
// pairs are exactly what the browser front-end sends (host.js SCANCODE_MAP +
// modifier-applied keysyms).  [tag, scancode, sym, mod, typed char]
const KEYS = [
  ['quote',     52, 0x27, 0, "'"],
  ['period',    55, 0x2e, 0, '.'],
  ['comma',     54, 0x2c, 0, ','],
  ['minus',     45, 0x2d, 0, '-'],
  ['slash',     56, 0x2f, 0, '/'],
  ['semicolon', 51, 0x3b, 0, ';'],
  ['equal',     46, 0x3d, 0, '='],
  ['lbracket',  47, 0x5b, 0, '['],
  ['rbracket',  48, 0x5d, 0, ']'],
  ['backslash', 49, 0x5c, 0, '\\'],
  ['backquote', 53, 0x60, 0, '`'],
  ['dquote',    52, 0x22, 1, '"'],   // Shift+' (mod 1 = LSHIFT)
  ['tilde',     53, 0x7e, 1, '~'],   // Shift+`  (0x7E -> VK_F15 class)
];

const script = [
  'notepad &',
  'wmctl wait label EDIT:0 12000',
  'SID=$(wmctl list | grep "Notepad$" | sed "s/[^0-9].*//")',
  'wmctl click EDIT:0',
];
for (const [tag, sc, sym, mod] of KEYS) {
  script.push(
    `wmctl settext EDIT:0 "$(printf 'abc\\ndef')"`,
    `wmctl key $SID 82 1073741906`,              // UP
    `wmctl key $SID 82 1073741906`,              // UP    -> line 0
    `wmctl key $SID 77 1073741901`,              // END   -> after "abc"
    `wmctl key $SID ${sc} ${sym}${mod ? ' ' + mod : ''}`,
    `echo ==${tag}`,
    'wmctl gettext EDIT:0',
    'echo ==cut'
  );
}
// Selection case: select-all via HOME(line0)+Shift+DOWN+Shift+END, then type
// ' — Windows semantics: the typed char REPLACES the selection. The VK_RIGHT
// misroute collapses the selection first, so nothing is replaced.
script.push(
  `wmctl settext EDIT:0 "$(printf 'abc\\ndef')"`,
  'wmctl key $SID 82 1073741906',
  'wmctl key $SID 82 1073741906',
  'wmctl key $SID 74 1073741898',                // HOME -> pos 0
  'wmctl key $SID 81 1073741905 1',              // Shift+DOWN
  'wmctl key $SID 77 1073741901 1',              // Shift+END -> all selected
  'wmctl key $SID 52 39',                        // type '
  'echo ==selquote',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  ''
);

const out = driveBoot(script.join('\n'), { image, maxBuffer: 64 * 1024 * 1024 }).stdout;
const section = (name) =>
  ((out.split('==' + name + '\n')[1] || '').split('==cut')[0]).replace(/\n+$/, '');

for (const [tag, , , , ch] of KEYS) {
  check(`typing ${tag} (${ch}) at EOL inserts in place: "abc${ch}\\ndef"`,
    section(tag) === `abc${ch}\ndef`, JSON.stringify(section(tag)));
}
check(`typing ' over a selection replaces it: "'"`,
  section('selquote') === "'", JSON.stringify(section('selquote')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
