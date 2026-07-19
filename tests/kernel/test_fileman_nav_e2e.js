#!/usr/bin/env node
// 0106 acceptance, headless: the fileman navigator v2 — details columns,
// multi-select, Enter/Backspace, F5 refresh, the View toggles (sort + show
// hidden), and Alt+Left back history. The browser twin is
// tests/browser/os-fileman.mjs (the multi-select + Delete visual leg).
//
// Covers:
//   - details view: each row carries the stat size (bytes) or <DIR> and an
//     mtime column; the status strip counts objects and the selection
//   - multi-select (LBS_EXTENDEDSEL in user32): Ctrl-click builds a SET
//     readable via the agent tree ('> ' on every marked row); Shift+Down
//     extends a range; a multi-select Delete removes the whole set
//   - Enter opens the caret row (dir navigates / file associates),
//     Backspace goes Up
//   - F5 re-lists so a file created outside fileman appears
//   - View: Sort by Size reorders (name order != size order), Show Hidden
//     Files flips dotfile visibility
//   - Alt+Left walks the back history
//
// Row geometry: row height is font-derived (20px em ~29px rows, listbox
// top TOP_H=26); clickRow(n) computes row n's center. Keyboard selection
// (click + HOME + DOWN) stays row-height-agnostic where it can.
//
// Run: node tests/kernel/test_fileman_nav_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-fmnav-');

function boot(script) {
  const r = driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}
function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

const HOME = 'wmctl key $SID 74 1073741898';
const DOWN = 'wmctl key $SID 81 1073741905';
const ENTER = 'wmctl key $SID 40 13';
const BACK = 'wmctl key $SID 42 8';               // Backspace = Up (Win95)
const F5 = 'wmctl key $SID 62 1073741886';
const DEL = 'wmctl key $SID 76 127';
const ALT_LEFT = 'wmctl key $SID 80 1073741904 256';   // SDL_KMOD_LALT rides the key
const CTRL_DOWN = 'wmctl keydown $SID 224 1073742048 64';
const CTRL_UP = 'wmctl keyup $SID 224 1073742048 0';
const SHIFT_DOWN_KEY = ['wmctl keydown $SID 225 1073742049 1',
                        'wmctl key $SID 81 1073741905 1',
                        'wmctl keyup $SID 225 1073742049 0'].join('\n');
// Row pitch is font-derived (20px em -> ~29px rows, listbox top TOP_H=26):
// clickRow(n) targets the CENTER of visual row n.
const clickRow = (n) => `wmctl click $SID 100 ${26 + n * 29 + 14}`;
const RC_PANE = 'wmctl click $SID 100 320 3';

const out = boot([
  // -- fixtures: sizes chosen so name order (a,b,c) != size order (b<c<a) --
  'mkdir -p /root/nav/sub /root/nav2',
  'printf "%0100d" 0 > /root/nav/a.txt',    // 100 bytes
  'printf "%05d" 0 > /root/nav/b.txt',      // 5 bytes
  'printf "%050d" 0 > /root/nav/c.txt',     // 50 bytes
  'printf hi > /root/nav/.secret',          // a dotfile (hidden by default)
  "printf '#!/bin/sh\\nwinbox\\n' > /root/nav/run.sh",
  'printf here > /root/nav2/inside.txt',
  'fileman /root/nav &',
  // 0154: fileman is a user32 app — waiting on its Go button proves the
  // controls were created AND the message loop is running (so the window is
  // listed), which is exactly what the SID grep below needs.
  'wmctl wait label Go 10000',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',

  // ---- details columns + status strip ----
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  'echo ==l1',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',

  // ---- Ctrl-click multi-select: row 0 (sub/) + row 3 (b.txt) ----
  // rows: sub/(0) a.txt(1) b.txt(2) c.txt(3) run.sh(4)  (dirs first, name sort)
  clickRow(0),                               // plain click -> {row0}
  CTRL_DOWN,
  clickRow(2),                               // ctrl-click row2 -> add {row0,row2}
  CTRL_UP,
  // 0154: these injects are FIFO in the one input ring, so the two guess-sleeps
  // around the ctrl-click are redundant — poll until the multi-selection marker
  // lands instead (which also implies every prior inject was dispatched).
  'wmctl wait text LISTBOX:0 "> b.txt" 8000',
  'echo ==multi',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'echo ==multistat',
  'wmctl tree',
  'echo ==cut',

  // ---- multi-select Delete removes the whole set (sub/ + b.txt) ----
  DEL,
  // 0154: the multi-delete raises a real modal MessageBox WM window — wait for
  // it before reading the tree.
  'wmctl wait win "Confirm Multiple Item Delete" 8000',
  'echo ==delbox',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  // 0154: waiting on the box being gone would race the synchronous delete that
  // runs after it closes; the status strip going to "3 object(s)" (was 5) polls
  // exactly for delete + refill completing before the -e checks.
  'wmctl wait text msctls_statusbar32:0 "3 object(s)" 8000',
  'test ! -e /root/nav/sub && test ! -e /root/nav/b.txt && echo MULTI-DEL-OK',
  'test -f /root/nav/a.txt && test -f /root/nav/c.txt && echo MULTI-DEL-KEPT',

  // ---- Shift+Down extends a range (a.txt row0 + c.txt row1 now) ----
  // remaining: a.txt(0) c.txt(1) run.sh(2)
  clickRow(0),                               // {row0}
  SHIFT_DOWN_KEY,                            // extend -> {row0,row1}
  // 0154: FIFO injects again; poll until the range's second row (c.txt) is
  // marked (replaces both guess-sleeps).
  'wmctl wait text LISTBOX:0 "> c.txt" 8000',
  'echo ==range',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',

  // ---- Enter opens: on a directory it navigates ----
  'wmctl settext EDIT:0 /root/nav2',
  'wmctl click Go',
  // 0154: wait for each Go to actually re-title the window (SetWindowText ->
  // surface title) before the next step; the nav2 hop must land first.
  'wmctl wait win "File Manager - /root/nav2" 8000',
  'wmctl settext EDIT:0 /root',
  'wmctl click Go',
  'wmctl wait win "File Manager - /root" 8000',
  clickRow(0),                               // row 0 of /root: a directory
  // (the click -> ENTER pair is FIFO in the ring; no gap needed)
  'echo ==beforeenter',
  'wmctl tree',
  'echo ==cut',
  ENTER,                                     // navigate into it
  // 0154: ENTER navigates into the subdir, so "File Manager - /root" (exact)
  // disappears from the list — poll for that.
  'wmctl wait nowin "File Manager - /root" 8000',
  'echo ==afterenter',
  'wmctl tree',
  'echo ==cut',

  // ---- Backspace goes Up ----
  BACK,
  // 0154: Backspace goes Up to /root — wait for that title to reappear.
  'wmctl wait win "File Manager - /root" 8000',
  'echo ==afterback',
  'wmctl tree',
  'echo ==cut',

  // ---- Alt+Left back history: nav2 -> nav via Go leaves nav2 on the stack ----
  'wmctl settext EDIT:0 /root/nav',
  'wmctl click Go',
  // 0154: the nav hop must complete (pushed on the back stack) before nav2, so
  // wait on each re-title.
  'wmctl wait win "File Manager - /root/nav" 8000',
  'wmctl settext EDIT:0 /root/nav2',
  'wmctl click Go',
  'wmctl wait win "File Manager - /root/nav2" 8000',
  'wmctl click $SID 100 260',                // focus the listbox (empty space)
  ALT_LEFT,                                  // back to /root/nav
  // 0154: Alt+Left walks back to nav — poll for that exact title (nav2 != nav).
  'wmctl wait win "File Manager - /root/nav" 8000',
  'echo ==altback',
  'wmctl tree',
  'echo ==cut',

  // ---- an externally-created file appears UNPROMPTED (FS_WATCH
  // auto-refresh, todos/0123/0264 — this used to require F5; the
  // dedicated legs live in test_fileman_watch_e2e.js) and F5 still
  // re-lists on demand ----
  'printf late > /root/nav/late.txt',
  'wmctl wait text LISTBOX:0 "late.txt" 8000',
  'echo ==autorefresh',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'wmctl click $SID 100 260',                // focus listbox (empty space)
  F5,
  'wmctl wait text LISTBOX:0 "late.txt" 8000',
  'echo ==afterf5',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',

  // ---- View: Sort by Size reorders (b<c<a); Show Hidden reveals .secret ----
  RC_PANE,
  // KEEP (0154): the pane context menu is an in-surface TrackPopupMenu, not a WM
  // window, and its items resolve only via AQ_CLICK (AQ_GETTEXT — what the waits
  // use — can't see menu items), so there's no queryable signal that the popup
  // has opened. The right-click must open it before the agent click can resolve
  // "Sort by Size", so this stays a small settle delay.
  'sleep 0.4',
  'wmctl click "Sort by Size"',
  // KEEP (0154): Sort by Size only REORDERS the same rows (all names present
  // before and after), so there is no positive substring for `wait text` to poll
  // and a single gettext races the WM_COMMAND dispatch — keep a settle delay.
  'sleep 0.4',
  'echo ==sized',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  RC_PANE,
  // KEEP (0154): same in-surface popup as above — no wait signal for it opening.
  'sleep 0.4',
  'wmctl click "Show Hidden Files"',
  // 0154: unlike the sort, Show Hidden ADDS a row (.secret) — poll for it.
  'wmctl wait text LISTBOX:0 ".secret" 8000',
  'echo ==hidden',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  '',
].join('\n'));

// details columns
const l1 = section(out, 'l1');
check('directory rows show a <DIR> column', /sub\/ +<DIR>/.test(l1), l1);
check('file rows show the stat byte size (a.txt = 100)',
  /a\.txt +100 /.test(l1), l1);
check('file rows carry an mtime date column',
  /a\.txt +100 +\d{4}-\d\d-\d\d \d\d:\d\d/.test(l1), l1);
const tree1 = section(out, 'tree1');
check('status strip counts objects (sub a b c run.sh shown; .secret hidden)',
  /class=msctls_statusbar32[^\n]*text='5 object\(s\)'/.test(tree1), tree1);

// multi-select
const multi = section(out, 'multi');
check('Ctrl-click builds a multi-selection (sub/ + b.txt both marked)',
  /> sub\//.test(multi) && /> b\.txt/.test(multi) &&
  !/> a\.txt/.test(multi) && !/> c\.txt/.test(multi), multi);
check('status strip reports the selected count (2 selected)',
  /class=msctls_statusbar32[^\n]*2 selected/.test(section(out, 'multistat')),
  section(out, 'multistat'));
check('multi-select Delete confirms with a plural wording',
  /Confirm Multiple Item Delete/.test(section(out, 'delbox')) ||
  /these 2 items/.test(section(out, 'delbox')), section(out, 'delbox'));
check('multi-select Delete removes the whole set', out.includes('MULTI-DEL-OK'));
check('multi-select Delete leaves the unselected rows', out.includes('MULTI-DEL-KEPT'));

const range = section(out, 'range');
check('Shift+Down extends the selection to a range (a.txt + c.txt)',
  /> a\.txt/.test(range) && /> c\.txt/.test(range) && !/> run\.sh/.test(range),
  range);

// Enter / Backspace
const be = section(out, 'beforeenter'), ae = section(out, 'afterenter');
check('Enter on a directory navigates into it',
  /File Manager - \/root'/.test(be) &&
  /File Manager - \/root\/[A-Za-z]/.test(ae), ae.slice(0, 200));
check('Backspace goes back Up to the parent',
  /File Manager - \/root'/.test(section(out, 'afterback')),
  section(out, 'afterback').slice(0, 200));

check('Alt+Left walks the back history (nav2 -> nav)',
  /File Manager - \/root\/nav'/.test(section(out, 'altback')),
  section(out, 'altback').slice(0, 200));

// F5
check('the external file appears with NO F5 (FS_WATCH auto-refresh, 0123)',
  /late\.txt/.test(section(out, 'autorefresh')), section(out, 'autorefresh'));
check('F5 re-lists so the externally-created file appears',
  /late\.txt/.test(section(out, 'afterf5')), section(out, 'afterf5'));

// View toggles
// At the sort point /root/nav holds a.txt(100) c.txt(50) run.sh(17)
// late.txt(4); name order is a,c,late,run — size-ascending is late<run<c<a,
// so late.txt/c.txt/a.txt monotonic proves the reorder off the name sort.
const sized = section(out, 'sized');
check('Sort by Size reorders by byte size (late.txt < c.txt < a.txt)',
  sized.indexOf('late.txt') >= 0 &&
  sized.indexOf('late.txt') < sized.indexOf('c.txt') &&
  sized.indexOf('c.txt') < sized.indexOf('a.txt'), sized);
check('Show Hidden Files reveals the dotfile (.secret)',
  /\.secret/.test(section(out, 'hidden')), section(out, 'hidden'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nfileman nav e2e: ${failures} FAILED` : '\nfileman nav e2e: PASS');
process.exit(failures ? 1 : 0);
