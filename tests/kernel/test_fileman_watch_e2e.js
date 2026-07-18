#!/usr/bin/env node
// fileman auto-refresh over FS_WATCH (ticket #75, closing todos/0123),
// headless: the file manager keeps ONE path-keyed watch fd on its cwd
// (os/win32/fileman.c watch_cwd, re-armed per navigation) riding user32's
// RegisterFdWake seam — the fd joins GetMessage's unified WAIT, a readable
// episode posts WM_FSCHANGE, and the handler re-lists with the selection
// carried by NAME. Every leg is an EXTERNAL mutation (the hush shell — a
// different process) with NO F5 and no fileman keystroke between the
// mutation and the assertion; all waits are marker-based (listbox row
// text / status-bar object counts), no fixed sleeps.
//   L1  external create appears unprompted (row + object count)
//   L2  the selection survived the auto-refill: Del's confirm box still
//       names the row selected BEFORE the external change (0123's
//       carry-by-name rule — an eaten selection would confirm nothing)
//   L3  external tmp + rename-over (the editor atomic-save finish, the
//       inotify-trap shape) lands its destination row unprompted
//   L4  external delete drops the object count unprompted
//   L5  navigation re-arms the watch: after cd elsewhere, a mutation
//       there refreshes too
//
// Run: node tests/kernel/test_fileman_watch_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir, image } = freshImage('os-fileman-watch-');
const HOME = 'wmctl key $SID 74 1073741898';
const DEL = 'wmctl key $SID 76 127';

const script = [
  // -- fixtures --
  'mkdir -p /root/w /root/w2',
  'printf one > /root/w/a.txt',
  'printf two > /root/w/b.txt',
  'printf m > /root/w2/m.txt',
  'fileman /root/w &',
  'wmctl wait label Go 10000',                   // controls + msg loop up
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  'wmctl wait text msctls_statusbar32:0 "2 object(s)" 8000',
  // select a.txt (row 0): click into the listbox (focus), HOME to row 0
  'wmctl click $SID 100 100',
  HOME,

  // L1: external create — the row and the count appear with NO keystroke.
  'printf three > /root/w/c.txt',
  'wmctl wait text LISTBOX:0 c.txt 8000',        // the listbox text is all rows
  'wmctl wait text msctls_statusbar32:0 "3 object(s)" 8000',
  'echo l1-ok',

  // L2: the pre-change selection (a.txt) survived the auto-refill — the
  // Del confirm still names it. An eaten selection opens no box at all.
  DEL,
  'wmctl wait label Yes 8000',                   // confirm box up
  // The confirm STATIC is the only STATIC alive: its text naming a.txt IS
  // the selection-survival proof (an eaten selection opens no box at all).
  'wmctl wait text STATIC:0 a.txt 6000 && echo confirm-names-a',
  'wmctl click No',
  'wmctl wait nolabel Yes 6000',

  // L3: external tmp + rename-over (atomic-save finish) — unprompted row.
  'printf four > /root/w/tmp1',
  'mv /root/w/tmp1 /root/w/e.txt',
  'wmctl wait text LISTBOX:0 e.txt 8000',
  'wmctl wait text msctls_statusbar32:0 "4 object(s)" 8000',
  'echo l3-ok',

  // L4: external delete — the count drops unprompted.
  'rm /root/w/c.txt /root/w/e.txt',
  'wmctl wait text msctls_statusbar32:0 "2 object(s)" 8000',
  'echo l4-ok',

  // L5: navigation re-arms the watch on the NEW cwd.
  'wmctl settext EDIT:0 /root/w2',
  'wmctl click Go',
  'wmctl wait text msctls_statusbar32:0 "1 object(s)" 8000',
  'printf n > /root/w2/n.txt',
  'wmctl wait text LISTBOX:0 n.txt 8000',
  'wmctl wait text msctls_statusbar32:0 "2 object(s)" 8000',
  'echo l5-ok',
  'echo ALLDONE',
];

const a = driveBoot(script, { image, timeout: 300000 });
const out = a.stdout || '';

check('L1: external create refreshed the listing unprompted', out.includes('l1-ok'),
  out.slice(-1200));
check('L2: selection survived by name — Del confirm names a.txt',
  out.includes('confirm-names-a'));
check('L3: external rename-over landed its row unprompted', out.includes('l3-ok'));
check('L4: external delete dropped the count unprompted', out.includes('l4-ok'));
check('L5: navigation re-armed the watch on the new cwd', out.includes('l5-ok'));
check('session completed', out.includes('ALLDONE'));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nfileman watch e2e: PASS' : `\nfileman watch e2e: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
