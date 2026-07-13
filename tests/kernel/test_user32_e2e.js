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
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-user32-');

function boot(script) {
  return driveBoot(script, { image, maxBuffer: 32 * 1024 * 1024 }).stdout;
}

/* ---- session A: the whole interactive story in one boot ---- */
const out = boot([
  'ctldemo &',
  // Boot barrier (todos/0154): the agent tree serving a resolvable label means
  // the app created its controls and reached the GetMessage idle loop — so the
  // WM_CREATE<SIZE<PAINT prints and `ready` are already out, and the window is
  // listed. Replaces the old `sleep 4` guess-wait.
  'wmctl wait label Greet 10000',
  'SID=$(wmctl list | grep "Control Demo$" | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // Label click, no pixels: BM_CLICK -> BN_CLICKED -> WM_COMMAND. No wait: the
  // GetMessage loop serves ONE agent request then dispatches ONE queued message
  // per iteration, so the WM_COMMAND lands before the next agent command below.
  'wmctl click Greet',
  // Focus the edit by class:index, type over the kernel key path, read it back
  // through the agent. `wait text` polls until the typed chars land in the EDIT
  // (WM_KEYDOWN->WM_CHAR is dispatched after the key ring drains) — the old
  // `sleep 1`s here were guessing at that latency.
  'wmctl click EDIT:0',
  'wmctl key $SID 11 104',                       // h
  'wmctl key $SID 12 105',                       // i
  'wmctl wait text EDIT:0 hi 4000',
  'echo ==gettext1',
  'wmctl gettext EDIT:0',
  'wmctl click Add',
  'wmctl wait text LISTBOX:0 hi 4000',
  'echo ==listtext',
  'wmctl gettext LISTBOX:0',
  // settext round-trip.
  'wmctl settext EDIT:0 world',
  'echo ==gettext2',
  'wmctl gettext EDIT:0',
  // Checkbox by label; Greet reports its state. Both agent clicks serialize
  // (Verbose's toggle dispatches before Greet is served), then the Greet
  // WM_COMMAND dispatches before the pixel clicks below.
  'wmctl click Verbose',
  'wmctl click Greet',
  // Input routing: local-coord pixel click on listbox row 0 (rect 12,44).
  'wmctl click $SID 100 54',
  // A short settle before the double-click so the single selection click can't
  // fuse with the dblclick's first click into a spurious triple (client-side
  // double-click detection is timestamp-based — a genuine timing subject).
  'sleep 0.3',
  'wmctl dblclick $SID 100 54',
  // Scrollbar arrows (rect 264,44 16x120; the down arrow bottom square). Ring
  // injections are FIFO-dispatched, so pos=1,2 then back to 1 stays ordered
  // without pacing sleeps.
  'wmctl click $SID 272 152',
  'wmctl click $SID 272 152',
  'wmctl click $SID 272 50',                     // up arrow
  // Cursor shapes (todos/0105): move the window to a known origin, then a
  // REAL screen-injected motion (wmctl smove) over the Name EDIT (client rect
  // 76,10 180x24) makes user32's update_cursor set the I-beam on the surface;
  // over the transparent "Name:" STATIC it falls to the arrow. The kernel
  // per-surface cursor reads back via `wmctl cursor`. There is no agent-visible
  // signal for "the app pumped the motion + SetCursor" — the cursor lives in
  // kernel per-surface state, so these stay annotated timing sleeps (0083 rule).
  'wmctl move $SID 200 200 && echo curmoved',
  'sleep 0.5',
  'wmctl smove 210 210',                         // over the STATIC -> arrow
  'sleep 0.8',
  'echo cur-static=$(wmctl cursor 210 210)',
  'wmctl smove 366 222',                         // over the Name EDIT -> I-beam
  'sleep 0.8',
  'echo cur-edit=$(wmctl cursor 366 222)',
  // MessageBox modal: Cancel first, then OK. The MB is a real WM window, so
  // wait on its title appearing/going (0083 wait win/nowin) instead of guessing.
  'wmctl click About',
  'wmctl wait win "About ctldemo" 6000',
  'echo ==mblist',
  'wmctl list',
  'echo ==cut',
  'echo ==mbtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Cancel',
  'wmctl wait nowin "About ctldemo" 6000',
  'wmctl click About',
  'wmctl wait win "About ctldemo" 6000',
  'wmctl click OK',
  'wmctl wait nowin "About ctldemo" 6000',
  // A second win32 app: tree dumps BOTH processes. Wait on its window title.
  'gdidemo &',
  'wmctl wait win "GDI Demo" 10000',
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  // Teardown: label-click Quit; the surface and agent socket must go. Waiting
  // for the label to vanish proves the app fully exited (and, FIFO, flushed the
  // WM_DESTROY/bye prints) before we read the list.
  'wmctl click Quit',
  'wmctl wait nolabel Greet 6000',
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

/* cursor shapes (todos/0105): hover flips the surface cursor via SetCursor */
{
  const curVal = (k) => {
    const m = out.match(new RegExp('^' + k + '=(-?\\d+)', 'm'));
    return m ? parseInt(m[1], 10) : NaN;
  };
  check('EDIT hover sets the I-beam (SDL_SYSTEM_CURSOR_TEXT=1)',
    curVal('cur-edit') === 1, curVal('cur-edit'));
  check('non-EDIT client hover falls to the arrow (0)',
    curVal('cur-static') === 0, curVal('cur-static'));
}

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

/* ---- session B: the 0104 dialog keyboard (Options template dialog) ----
 * IsDialogMessageW in DialogBoxParamW's modal loop drives Tab order,
 * mnemonics, the default button and Esc. Keys ride the kernel INJECT_KEY
 * path (`wmctl key SID SC SYM [MOD]`, SID 0 = focused window; MOD 256 =
 * LALT). Focus is read from the agent tree's ` focus` marker, addressed by
 * control id inside the "#32770" subtree (the disabled owner also carries a
 * stale focus mark — pick by id). */
const { dir: dtmp, image: dimage } = freshImage('os-user32d-');
function bootD(script) {
  return driveBoot(script, { image: dimage, maxBuffer: 32 * 1024 * 1024 }).stdout;
}
// The per-key `sleep 1`s below wait for a Tab/mnemonic keydown to be DISPATCHED
// so the ` focus ` marker in the next `wmctl tree` reflects the move. That
// marker lives per-line in the tree dump keyed by control id — the 0154
// label/text agent-wait can't target it (it matches a widget's TEXT, not its
// focus state), so these stay annotated timing subjects (0083 rule). Every
// window-level wait (dialog/MessageBox open+close) IS converted.
const FOCUS_SETTLE = 'sleep 1';   // focus-marker dispatch; tree-only, see above
const outD = bootD([
  'ctldemo &',
  'wmctl wait label Greet 10000',
  'wmctl click Options',
  'wmctl wait win Options 6000',
  'echo ==dtree', 'wmctl tree', 'echo ==cut',
  'wmctl key 0 43 9', FOCUS_SETTLE,              // Tab: edit -> Verbose
  'echo ==tab1', 'wmctl tree', 'echo ==cut',
  'wmctl key 0 43 9', FOCUS_SETTLE,              // Tab: Verbose -> OK
  'echo ==tab2', 'wmctl tree', 'echo ==cut',
  'wmctl key 0 43 9 1', FOCUS_SETTLE,            // Shift+Tab: OK -> Verbose
  'echo ==stab', 'wmctl tree', 'echo ==cut',
  'wmctl key 0 17 110 256', FOCUS_SETTLE,        // Alt+N: static mnemonic -> edit
  'echo ==altn', 'wmctl tree', 'echo ==cut',
  // Type "hi" into the dialog EDIT, then confirm it landed before toggling.
  // CLASS:n indexes the WHOLE tree: the main window's single-line (0) and
  // multiline (1) EDITs enumerate first, so the dialog's EDIT is EDIT:2 —
  // waiting on EDIT:0 here is a dead wait (the keys go to the dialog).
  'wmctl key 0 11 104', 'wmctl key 0 12 105',
  'wmctl wait text EDIT:2 hi 4000',
  'wmctl key 0 47 118 256', FOCUS_SETTLE,        // Alt+V: toggle Verbose
  'wmctl key 0 40 13',                           // Enter: default OK -> closes
  'wmctl wait nowin Options 6000',
  'echo ==afterok', 'wmctl list', 'echo ==cut',
  'wmctl click Options', 'wmctl wait win Options 6000',   // reopen
  'wmctl key 0 15 27',                           // Esc -> IDCANCEL -> closes
  'wmctl wait nowin Options 6000',
  'echo ==afteresc', 'wmctl list', 'echo ==cut',
  'wmctl click Options', 'wmctl wait win Options 6000',   // reopen
  'wmctl key 0 46 99 256',                        // Alt+C: mnemonic Cancel -> closes
  'wmctl wait nowin Options 6000',
  // MessageBox (the non-template #32770) inherits the same keyboard path.
  'wmctl click About', 'wmctl wait win "About ctldemo" 6000',
  'wmctl key 0 43 9', FOCUS_SETTLE,              // Tab: OK -> Cancel
  'wmctl key 0 40 13',                           // Enter presses focused Cancel
  'wmctl wait nowin "About ctldemo" 6000',
  'wmctl click About', 'wmctl wait win "About ctldemo" 6000',
  'wmctl key 0 40 13',                           // Enter presses default OK
  'wmctl wait nowin "About ctldemo" 6000',
  'wmctl click Quit', 'wmctl wait nolabel Greet 6000',
  '',
].join('\n'));

function sectionD(name) {
  return (outD.split('==' + name + '\n')[1] || '').split('==cut')[0];
}
/* focus line of the control with the given id inside the #32770 subtree */
function dlgFocusId(sec) {
  const m = sec.split('class=#32770')[1] || '';
  const line = m.split('\n').find(l => / focus /.test(l)) || '';
  const idm = line.match(/id=(\d+)/);
  return idm ? parseInt(idm[1], 10) : -1;
}

const dtree = sectionD('dtree');
check('Options dialog is a #32770 with a default OK button',
  /class=#32770[^]*text='Options'/.test(dtree) && /id=1 [^\n]*text='&OK'/.test(dtree),
  dtree.slice(0, 400));
check('dialog opens with focus on the first tabstop (the EDIT)',
  dlgFocusId(dtree) === 120, dlgFocusId(dtree));
check('Tab moves focus to the Verbose checkbox', dlgFocusId(sectionD('tab1')) === 121,
  dlgFocusId(sectionD('tab1')));
check('Tab moves focus to the OK button', dlgFocusId(sectionD('tab2')) === 1,
  dlgFocusId(sectionD('tab2')));
check('Shift+Tab reverses back to Verbose', dlgFocusId(sectionD('stab')) === 121,
  dlgFocusId(sectionD('stab')));
check('Alt+N (static mnemonic) hands focus to the next control (EDIT)',
  dlgFocusId(sectionD('altn')) === 120, dlgFocusId(sectionD('altn')));
check('typed text + Alt+V toggle + Enter default fires IDOK with the state',
  outD.includes("ctldemo: opt-ok name='hi' verbose=1") && outD.includes('ctldemo: options=1'));
check('dialog closed after the default button', !sectionD('afterok').includes('Options'),
  sectionD('afterok'));
check('Esc returns IDCANCEL', /ctldemo: opt-cancel[^]*ctldemo: options=2/.test(outD));
check('Esc closed the dialog', !sectionD('afteresc').includes('Options'), sectionD('afteresc'));
check('Alt+C (Cancel mnemonic) also returns IDCANCEL',
  (outD.match(/ctldemo: options=2/g) || []).length === 2,
  (outD.match(/ctldemo: options=2/g) || []).length);
/* MessageBox (non-template #32770) inherits IsDialogMessageW too */
check('MessageBox Tab moves to Cancel; Enter presses it -> IDCANCEL',
  outD.includes('ctldemo: msgbox=2'));
check('MessageBox Enter on the default OK -> IDOK',
  outD.includes('ctldemo: msgbox=1'));

fs.rmSync(dtmp, { recursive: true, force: true });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nuser32 e2e: ${failures} FAILED` : '\nuser32 e2e: PASS');
process.exit(failures ? 1 : 0);
