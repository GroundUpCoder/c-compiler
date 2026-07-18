#!/usr/bin/env node
// 0048 acceptance, headless: /bin/fileman (the wave-1 file manager, a
// Win32-veneer app over plain POSIX dir calls). Covers:
//   - the listing: LISTBOX of the cwd, dirs-first sorted, dirs marked
//     with a trailing '/' (readable via the WM_GETTEXT items convention)
//   - navigation: the path EDIT + Go (agent settext), Up, and Open on a
//     selected directory; the title tracks the cwd
//   - activation (the 0066 activate() semantics, wm.c's copy): a
//     runnable file (#! script) spawns with its own pgroup; a plain
//     file opens through the openwith associations (todos/0072 —
//     default.gui is notepad in the baked store; the picker itself is
//     test_openwith_e2e.js's)
//   - drag-resize relayout: wmctl resize reflows the strip + LISTBOX
//
// Row selection is KEYBOARD-driven (click focuses the listbox, HOME
// selects row 0, VK_DOWN steps) so the test never depends on row-height
// pixel math; the selection readback is the '> ' marker in the items.
//
// Run: node tests/kernel/test_fileman_e2e.js
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

const { dir: tmp, image } = freshImage('os-fileman-');

function boot(script) {
  const r = driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

/* /root fresh listing: Desktop/ roms/ | doom1.wad hello.c launcher
 * plain.txt — launcher is row 4, plain.txt row 5 (dirs-first sorted; /root/id1
 * left with the quake package in the deploy-leg split). */
const HOME = 'wmctl key $SID 74 1073741898';
const DOWN = 'wmctl key $SID 81 1073741905';
const sel = (row) => ['wmctl click $SID 200 100', HOME,
                      ...Array(row).fill(DOWN)].join('\n');

const out = boot([
  "printf '#!/bin/sh\\nwinbox\\n' > /root/launcher",
  "printf 'plain text, not a program\\n' > /root/plain.txt",
  'fileman &',
  // Boot barrier (todos/0154): the "Go" button resolving means fileman's window,
  // listing and agent tree are up.
  'wmctl wait label Go 10000',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // Go navigation by settext — wait for the target dir's contents to land in the
  // LISTBOX rather than guessing at the relist latency.
  'wmctl settext EDIT:0 /usr/share',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 os-release 4000',
  'echo ==l2',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  // Up -> /usr (has bin/, distinctive of the parent)
  'wmctl click Up',
  'wmctl wait text LISTBOX:0 "bin/" 4000',
  'echo ==l3',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // back to /root, then Open on the selected DIRECTORY (row 0 = Desktop/)
  'wmctl settext EDIT:0 /root',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 "Desktop/" 4000',
  sel(0),
  'echo ==selmark',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'wmctl click Open',
  'wmctl wait text LISTBOX:0 term 4000',         // navigated into Desktop/
  'echo ==l4',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'wmctl click Up',
  'wmctl wait text LISTBOX:0 launcher 4000',      // back at /root
  // activate a runnable: launcher (row 4) -> sh -> winbox
  sel(4),
  'wmctl click Open',
  'wmctl wait win winbox 8000',
  'echo ==list3',
  'wmctl list',
  'echo ==cut',
  // activate a plain file: plain.txt (row 5) -> the GUI default (notepad)
  sel(5),
  'wmctl click Open',
  'wmctl wait win "plain.txt - Notepad" 12000',   // notepad loads freetype + opens
  'echo ==list4',
  'wmctl list',
  'echo ==cut',
  // drag-resize relayout. The new LISTBOX geometry (592 wide) is tree-only —
  // no label/text/window signal for "WM_SIZE reflow done" — so this stays an
  // annotated relayout-settle sleep (0083 rule).
  'wmctl resize $SID 600 400',
  'sleep 1',
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  '',
].join('\n'));

const tree1 = section(out, 'tree1');
check('fileman window titled with the cwd',
  /class=FileMan [^\n]*text='File Manager - \/root'/.test(tree1), tree1.slice(0, 300));
// 0106: rows now carry details columns (name '/' marker, right-aligned
// size/<DIR>, date). Assert dirs-first ordering + the '/'+<DIR> columns
// tolerantly ([^'] spans the padding/date/\n between entries; the tree
// dump caps the item text, so the three leading dirs are the anchor).
check('listing is dirs-first with / markers + details columns',
  /Desktop\/ +<DIR>[^']*roms\/ +<DIR>/.test(tree1), tree1);
check('files carry a byte size + date column (status bar counts them)',
  /class=msctls_statusbar32[^\n]*text='6 object\(s\)'/.test(tree1), tree1);
check('path EDIT + Go/Up/Open/With buttons present',
  /class=EDIT id=100/.test(tree1) && /text='Go'/.test(tree1) &&
  /text='Up'/.test(tree1) && /text='Open'/.test(tree1) &&
  /text='With'/.test(tree1), tree1);

check('settext + Go navigates to /usr/share',
  /fonts\//.test(section(out, 'l2')) && /os-release/.test(section(out, 'l2')),
  section(out, 'l2'));
check('title tracks the cwd', /File Manager - \/usr\/share/.test(section(out, 'list2')),
  section(out, 'list2'));
check('Up goes to the parent', /bin\//.test(section(out, 'l3')) && /share\//.test(section(out, 'l3')),
  section(out, 'l3'));

check('keyboard selection marks row 0 (Desktop/)',
  /^> Desktop\//.test(section(out, 'selmark').trim()), section(out, 'selmark'));
check('Open on a directory navigates into it',
  /pokemon/.test(section(out, 'l4')) && /term/.test(section(out, 'l4')),
  section(out, 'l4'));

check('Open on a #! script spawns it (winbox up)',
  section(out, 'list3').split('\n').some(l => l.endsWith('\twinbox')),
  section(out, 'list3'));
check('Open on a plain file opens the GUI default (notepad, todos/0072)',
  section(out, 'list4').split('\n').some(l => l.includes('Notepad')),
  section(out, 'list4'));

const tree2 = section(out, 'tree2');
check('resize reflows the listbox (592 wide)',
  /class=LISTBOX [^\n]*rect=4,26 592x/.test(tree2), tree2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
