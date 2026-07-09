#!/usr/bin/env node
// 0058 acceptance, headless: the win32 user32 layer (os/win32/user32.c,
// design todos/WIN32.md) through os/boot.js. Covers:
//   - the classic blocking message loop in main() (GetMessage parks in
//     host.js __sdl_pump_wait) with the Windows lifecycle ORDER:
//     WM_CREATE < WM_SIZE < WM_PAINT
//   - the agent tree (wm_agent.h): `wmctl tree` dumps every control with
//     class/id/rect/text; `wmctl click "<label>"` presses a named button
//     with NO pixel coordinates (BM_CLICK -> WM_COMMAND, observed on the
//     app's stdout); CLASS:n addressing; gettext/settext round-trips
//   - controls: EDIT focus + kernel key injection typing, checkbox
//     BM_GETCHECK, LISTBOX add/select (LBN_SELCHANGE via a local-coord
//     pixel click — the input-routing leg), LBN_DBLCLK, SCROLLBAR arrow
//     notify -> app SetScrollPos (the Petzold WM_VSCROLL shape)
//   - MessageBox: a real modal (second kernel surface), owner disabled,
//     `wmctl click OK`/`Cancel` dismisses -> IDOK/IDCANCEL
//   - teardown: Quit -> WM_DESTROY -> WM_QUIT -> clean exit, surface gone,
//     agent socket unlinked
//   - two win32 apps at once: `wmctl tree` dumps both processes
//
// Layout coordinates mirror os/win32/ctldemo.c WM_CREATE — change together
// (tests/browser/os-user32.mjs probes the same layout).
//
// Run: node tests/kernel/test_user32_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-user32-'));
const image = path.join(tmp, 'os.img');

function boot(script) {
  const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r.stdout;
}

/* ---- session A: the whole interactive story in one boot ---- */
const out = boot([
  'ctldemo &',
  'sleep 4',                                     // wasm boot + first paint
  'SID=$(wmctl list | grep "Control Demo$" | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // Label click, no pixels: BM_CLICK -> BN_CLICKED -> WM_COMMAND.
  'wmctl click Greet',
  'sleep 1',
  // Focus the edit by class:index, type over the kernel key path,
  // read it back through the agent.
  'wmctl click EDIT:0',
  'sleep 1',
  'wmctl key $SID 11 104',                       // h
  'wmctl key $SID 12 105',                       // i
  'sleep 1',
  'echo ==gettext1',
  'wmctl gettext EDIT:0',
  'wmctl click Add',
  'sleep 1',
  'echo ==listtext',
  'wmctl gettext LISTBOX:0',
  // settext round-trip.
  'wmctl settext EDIT:0 world',
  'echo ==gettext2',
  'wmctl gettext EDIT:0',
  // Checkbox by label; Greet reports its state.
  'wmctl click Verbose',
  'wmctl click Greet',
  'sleep 1',
  // Input routing: local-coord pixel click on listbox row 0 (rect 12,44).
  'wmctl click $SID 100 54',
  'sleep 1',
  'wmctl dblclick $SID 100 54',
  'sleep 1',
  // Scrollbar arrows (rect 264,44 16x120; the down arrow bottom square).
  'wmctl click $SID 272 152',
  'sleep 1',
  'wmctl click $SID 272 152',
  'sleep 1',
  'wmctl click $SID 272 50',                     // up arrow
  'sleep 1',
  // MessageBox modal: Cancel first, then OK.
  'wmctl click About',
  'sleep 2',
  'echo ==mblist',
  'wmctl list',
  'echo ==cut',
  'echo ==mbtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Cancel',
  'sleep 1',
  'wmctl click About',
  'sleep 2',
  'wmctl click OK',
  'sleep 1',
  // A second win32 app: tree dumps BOTH processes.
  'gdidemo &',
  'sleep 4',
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  // Teardown: label-click Quit; the surface and agent socket must go.
  'wmctl click Quit',
  'sleep 1',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  'echo ==sock',
  'ls /run/win32',
  'echo ==cut',
  '',
].join('\n'));

function section(name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

/* lifecycle order */
const iCreate = out.indexOf('ctldemo: WM_CREATE');
const iSize = out.indexOf('ctldemo: WM_SIZE');
const iPaint = out.indexOf('ctldemo: WM_PAINT');
check('WM_CREATE arrives', iCreate >= 0);
check('lifecycle order CREATE < SIZE < PAINT',
  iCreate >= 0 && iSize > iCreate && iPaint > iSize, `${iCreate},${iSize},${iPaint}`);
check('app reaches ready', out.includes('ctldemo: ready'));

/* window + tree */
const list1 = section('list1');
const row = list1.split('\n').find(l => l.endsWith('\tControl Demo')) || '';
check('WM-placed window titled "Control Demo"', row !== '', JSON.stringify(list1.slice(0, 200)));
check('window is 480x360 fixed-size', row.includes('480x360') && !(row.split('\t')[5] || '').includes('R'), row);

const tree1 = section('tree1');
check('tree dumps the top-level', /win \d+ class=ctldemo id=0 rect=0,0 480x360 .*text='Control Demo'/.test(tree1), tree1.slice(0, 200));
for (const probe of [
  ["STATIC label", /class=STATIC id=100 rect=12,14 60x18 .*text='Name:'/],
  ["single-line EDIT", /class=EDIT id=101 rect=76,10 180x24/],
  ["Add button", /class=BUTTON id=200 .*text='Add'/],
  ["LISTBOX", /class=LISTBOX id=103 rect=12,44 244x120/],
  ["SCROLLBAR", /class=SCROLLBAR id=104 rect=264,44 16x120/],
  ["multiline EDIT with escaped newline", /class=EDIT id=102 .*text='line one\\nline two'/],
  ["checkbox", /class=BUTTON id=105 .*text='Verbose'/],
]) check('tree shows ' + probe[0], probe[1].test(tree1), tree1);

/* label click -> WM_COMMAND */
check('wmctl click Greet fires WM_COMMAND (no pixels)',
  out.includes("ctldemo: WM_COMMAND Greet name='' verbose=0"));

/* typing through the kernel key path into the focused edit */
const gettext1 = (out.split('==gettext1\n')[1] || '').split('\n')[0];
check('EDIT focus + key injection typing round-trips', gettext1 === 'hi', gettext1);
check('Add appended the edit text', out.includes("ctldemo: added 'hi'"));
const listtext = (out.split('==listtext\n')[1] || '').split('\n')[0];
check('LISTBOX agent text carries the item', listtext.includes('hi'), listtext);

/* settext round-trip */
const gettext2 = (out.split('==gettext2\n')[1] || '').split('\n')[0];
check('settext/gettext round-trips', gettext2 === 'world', gettext2);

/* checkbox + verbose greet */
check('checkbox BM_GETCHECK toggles', out.includes('ctldemo: check=1'));
check('Greet reports the checked state and set text',
  out.includes("ctldemo: WM_COMMAND Greet name='world' verbose=1"));

/* listbox click + dblclick (local-coord routing to a child control) */
check('listbox row click -> LBN_SELCHANGE', out.includes('ctldemo: sel=0'));
check('listbox double click -> LBN_DBLCLK', out.includes('ctldemo: list-dblclk'));

/* scrollbar notify -> app SetScrollPos */
check('scrollbar SB_LINEDOWN x2 walks the pos', out.includes('ctldemo: vscroll pos=1') &&
  out.includes('ctldemo: vscroll pos=2'));
check('scrollbar SB_LINEUP walks back', /vscroll pos=2[\s\S]*vscroll pos=1/.test(out));

/* MessageBox modal */
const mblist = section('mblist');
check('MessageBox is a second kernel surface titled "About ctldemo"',
  mblist.split('\n').some(l => l.endsWith('\tAbout ctldemo')), mblist);
const mbtree = section('mbtree');
check('modal disables the owner (en=0 in the tree)',
  /class=ctldemo id=0 [^\n]*en=0/.test(mbtree), mbtree.slice(0, 300));
check('MessageBox tree shows OK and Cancel buttons',
  /class=#32770/.test(mbtree) && /text='OK'/.test(mbtree) && /text='Cancel'/.test(mbtree), mbtree);
check('wmctl click Cancel -> IDCANCEL', out.includes('ctldemo: msgbox=2'));
check('wmctl click OK -> IDOK', out.includes('ctldemo: msgbox=1'));

/* two apps in one tree scan */
const tree2 = section('tree2');
check('tree dumps two win32 processes',
  (tree2.match(/^== pid \d+/gm) || []).length === 2, tree2.slice(0, 200));
check('gdidemo appears in the scan', /class=gdidemo/.test(tree2), tree2);

/* teardown */
check('Quit -> WM_DESTROY -> clean exit',
  out.includes('ctldemo: quit') && out.includes('ctldemo: WM_DESTROY') && out.includes('ctldemo: bye'));
const list2 = section('list2');
check('window gone after quit', !list2.includes('Control Demo'), list2);
const sock = section('sock');
check('agent socket unlinked at exit (only gdidemo remains)',
  (sock.match(/agent\.\d+\.sock/g) || []).length === 1, JSON.stringify(sock));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nuser32 e2e: ${failures} FAILED` : '\nuser32 e2e: PASS');
process.exit(failures ? 1 : 0);
