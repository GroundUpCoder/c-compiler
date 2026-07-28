#!/usr/bin/env node
// todos/0370 acceptance, headless: SysListView32 + SysHeader32 + the AQM
// agent seam (os/win32/listview.c, design todos/SOFTWARE-NATIVE.md §3).
// Covers:
//   - `ctldemo lvtest`: the synchronous message-surface selftest (columns,
//     items, subitems, A/W roundtrips, state/selection/notify, hit test,
//     ensure-visible + scroll, sort-with-state-travel, WM_GETTEXT format,
//     extended styles, column delete) — must report 0 failed
//   - the drivability bar (non-negotiable, the ticket's acceptance): every
//     row and column is addressable BY NAME through wmctl with no wmctl
//     change — `wmctl click <row>` selects a listview row (AQM_FINDLABEL),
//     `wmctl gettext <row>` returns the joined line, `wmctl wait text` on
//     row labels polls side-effect-free, `wmctl tree` splices lvrow/hdcol
//     lines under the control (AQM_DUMPCHILDREN), `wmctl click <column>`
//     presses the header segment (HDN_ITEMCLICK -> LVN_COLUMNCLICK -> the
//     demo's sort)
//   - the LISTBOX retrofit: the SAME seam closes the pre-0370 gap where
//     LISTBOX rows were gettext-visible but not click/label targets
//     (test_fileman_e2e drives rows by HOME+N*DOWN ordinals for exactly
//     that reason) — `wmctl click <item>` now selects, lbrow tree lines
//   - keyboard: VK_DOWN/VK_END move focus+selection (LVN_ITEMCHANGED
//     echoes), the embedded SCROLLBAR child exists once rows overflow
//   - mouse: pixel dblclick/rclick fire NM_DBLCLK/NM_RCLICK
//
// Pixel coordinates in the mouse leg mirror os/win32/ctldemo.c lvdemo
// layout + the 28px stock font cell (listview at 12,12; header 34px; rows
// 30px) — change together.
//
// Run: node tests/kernel/test_listview_e2e.js
'use strict';
const { driveBoot, freshImage } = require('./lib/drive.js');

// Local ==cut-bounded section (the test_user32_e2e.js shape): the shared
// drive.js section() slices at the NEXT '==', which the tree dump's own
// '== pid N' banner would trigger.
function section(out, name) {
  return (String(out).split('==' + name + '\n')[1] || '').split('==cut')[0];
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-listview-');

function boot(script) {
  return driveBoot(script, { image, maxBuffer: 32 * 1024 * 1024 }).stdout;
}

const DOWN = 'wmctl key $SID 81 1073741905';
const END = 'wmctl key $SID 77 1073741901';

/* ---- session A: lvtest + the whole interactive story in one boot ---- */
const out = boot([
  'echo ==lvtest',
  'ctldemo lvtest; echo lvtest-status=$?',
  'echo ==cut',
  'ctldemo listview &',
  // Boot barrier: a resolvable row label means the listview exists, its
  // items are in, and the app reached the GetMessage idle loop.
  'wmctl wait text SysListView32:0 alpha 15000',
  'SID=$(wmctl list | grep "ListView Demo$" | sed "s/[^0-9].*//")',
  'echo ==gettext1',
  'wmctl gettext SysListView32:0',
  'echo ==cut',
  // Row click BY NAME (the seam's point: no pixels, no ordinals).
  'wmctl click delta && echo rowclick-ok',
  'wmctl wait text SysListView32:0 "> delta" 4000',
  // wait text on the ROW label (side-effect-free find path) + row gettext.
  'wmctl wait text delta "1.2 MB" 4000',
  'echo ==rowtext',
  'wmctl gettext delta',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // Keyboard: focus is on the listview after the row click; DOWN advances.
  DOWN,
  'wmctl wait text SysListView32:0 "> echo" 4000',
  END,
  'wmctl wait text SysListView32:0 "> xray" 4000',
  // Sort by clicking the HEADER SEGMENT by name: version strings ascend ->
  // india ("0.3") first; second click flips -> sierra ("7.0") first.
  'wmctl click Version && echo colclick-ok',
  'wmctl wait text SysListView32:0 "Name | Version" 4000',
  'echo ==sorted1',
  'wmctl gettext SysListView32:0',
  'echo ==cut',
  'wmctl click Version',
  'sleep 0.3',
  'echo ==sorted2',
  'wmctl gettext SysListView32:0',
  'echo ==cut',
  'wmctl click Name',
  'sleep 0.3',
  'echo ==sorted3',
  'wmctl gettext SysListView32:0',
  'echo ==cut',
  // Mouse: pixel dblclick / right-click on row 0 (alpha after the Name
  // sort). Listview at (12,12), header 34px, rows 30px -> row 0 center y =
  // 12 + 2 + 34 + 15 = 63. The END leg scrolled the list, so first pin the
  // scroll: clicking alpha by label ENSUREVISIBLEs row 0 -> top = 0.
  'wmctl click alpha',
  'wmctl wait text SysListView32:0 "> alpha" 4000',
  'wmctl dblclick $SID 100 63',
  'wmctl down $SID 100 63 3',
  'wmctl up $SID 100 63 3',
  'sleep 0.3',
  // ---- LISTBOX retrofit legs (the classic ctldemo pane) ----
  'ctldemo &',
  'wmctl wait label Greet 10000',
  'wmctl settext EDIT:0 rowone',
  'wmctl click Add',
  'wmctl settext EDIT:0 rowtwo',
  'wmctl click Add',
  'wmctl wait text LISTBOX:0 rowtwo 4000',
  // The pre-0370 gap, closed: a LISTBOX row is a click/label target.
  'wmctl click rowtwo && echo lbclick-ok',
  'wmctl wait text LISTBOX:0 "> rowtwo" 4000',
  'echo ==lbrowtext',
  'wmctl gettext rowone',
  'echo ==cut',
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Quit',
  'echo ==done',
]);

check('boot reached the end marker', out.includes('==done'));
check('zero listview/header fail-loud reports (the 0211 bar)',
      !/win32: unsupported (listview|header)/.test(out),
      (out.match(/win32: unsupported [^\n]*/g) || []).join(' | '));

/* lvtest: the message surface is green in-OS */
const lvtest = section(out, 'lvtest');
check('lvtest ran', /ctldemo lvtest: \d+ checks/.test(lvtest));
check('lvtest 0 failed', /checks, 0 failed/.test(lvtest), lvtest.split('\n').filter(l => /FAIL/.test(l)).join(' | '));
check('lvtest exit 0', lvtest.includes('lvtest-status=0'));

/* gettext: header line + rows, " | " join */
const g1 = section(out, 'gettext1');
check('gettext header line', g1.startsWith('Name | Version | Size | Status\n'));
check('gettext row join', g1.includes('alpha | 1.0 | 12 KB | available'));
check('gettext all 24 rows', g1.trim().split('\n').length === 25, g1.trim().split('\n').length);

/* row click by name */
check('row click resolved', out.includes('rowclick-ok'));
check('row click selects (LVN_ITEMCHANGED echo)', out.includes('ctldemo: lv sel=3 name=delta'));
check('row click fires NM_CLICK', out.includes('ctldemo: lv click=3'));
check('row gettext = joined line',
      section(out, 'rowtext').trim() === 'delta | 3.2 | 1.2 MB | installed');

/* tree: lvrow/hdcol lines spliced under the controls */
const t1 = section(out, 'tree1');
check('tree lists the listview', t1.includes('class=SysListView32'));
check('tree has 24 lvrow lines', (t1.match(/lvrow i=/g) || []).length === 24);
check('tree marks the selected row', /lvrow i=3 sel text='delta \| 3\.2/.test(t1));
check('tree lists the header child', t1.includes('class=SysHeader32'));
check('tree has hdcol lines', (t1.match(/hdcol i=/g) || []).length === 4);
check('hdcol carries the title', /hdcol i=1 text='Version'/.test(t1));
check('tree lists the embedded scrollbar', /class=SCROLLBAR/.test(t1));

/* keyboard */
check('VK_DOWN advances selection', out.includes('ctldemo: lv sel=4 name=echo'));
check('VK_END lands on the last row', out.includes('ctldemo: lv sel=23 name=xray'));

/* sort via header click by name */
check('column click resolved', out.includes('colclick-ok'));
check('LVN_COLUMNCLICK echo', out.includes('ctldemo: lv colclick=1 dir=0 first=india'));
const s1 = section(out, 'sorted1');
check('sort ascending took (india first)',
      s1.split('\n')[1].startsWith('india | 0.3'));
check('second click flips (sierra first)', out.includes('ctldemo: lv colclick=1 dir=1 first=sierra'));
const s2 = section(out, 'sorted2');
check('sort descending took', s2.split('\n')[1].startsWith('sierra | 7.0'));
const s3 = section(out, 'sorted3');
check('Name sort restores alpha first', s3.split('\n')[1].startsWith('alpha | 1.0'));

/* mouse */
check('pixel dblclick fires NM_DBLCLK', /ctldemo: lv dblclk=0/.test(out));
check('pixel right-click fires NM_RCLICK', /ctldemo: lv rclick=0/.test(out));

/* LISTBOX retrofit: the pre-0370 gap is closed */
check('LISTBOX row click resolved', out.includes('lbclick-ok'));
check('LISTBOX row click selects (sel echo)', out.includes('ctldemo: sel=1'));
check('LISTBOX row gettext', section(out, 'lbrowtext').trim() === 'rowone');
const t2 = section(out, 'tree2');
check('tree has lbrow lines', (t2.match(/lbrow i=/g) || []).length >= 2);
check('lbrow marks the selection', /lbrow i=1 sel text='rowtwo'/.test(t2));

console.log(failures ? `FAILED (${failures})` : 'PASS');
process.exit(failures ? 1 : 0);
