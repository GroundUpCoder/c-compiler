#!/usr/bin/env node
// 0092 acceptance, headless: file manager operations + the desktop's
// (rename / delete / copy / cut / paste / new folder / properties).
// Covers:
//   - the fileman context menu (right-click a row -> Open / Open With /
//     Cut / Copy / Rename / Delete / Properties, dir-gated; empty pane ->
//     Paste / New Folder / Refresh, Paste gated on a clipboard FILE list)
//     over the 0091 TrackPopupMenu primitive — items are agent targets
//   - rename: the F2 accelerator + dialog (settext + OK, and the
//     message-loop Enter commit), EEXIST refusal keeps the dialog open
//   - copy/paste: recursive dir copy with the Win95 "Copy of" clash
//     uniquifier; cut/paste: a real move, the slot cleared after (a cut
//     pastes once -> Paste re-grays)
//   - delete: the Del accelerator + MessageBox confirm (No keeps, Yes
//     removes — to the Recycle Bin since 0093, test_recycle_e2e owns the
//     store's semantics); EROFS under /bin fails with a clean error box
//     (0040)
//   - properties: stat facts (type/size/location) in a MessageBox
//   - the wm.c desktop menus (0092 rows): icon Cut/Copy of the selection,
//     desktop Paste — the SAME format-2 clipboard file list, so desktop
//     copy pastes into fileman and vice versa; a text-only clipboard
//     leaves desktop PASTE grayed (gray rows never fire, 0091)
//
// Row-0 discipline: right-click selection is coordinate-driven, so every
// context-menu op targets ROW 0 (y=30 hits it for any row height); the
// listing is arranged so the interesting entry sorts first. Keyboard ops
// (F2/Del) select via the click+HOME+DOWN idiom (test_fileman_e2e).
//
// Run: node tests/kernel/test_fileman_ops_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-fmops-'));
const image = path.join(tmp, 'os.img');

const HOME = 'wmctl key $SID 74 1073741898';
const DOWN = 'wmctl key $SID 81 1073741905';
const F2 = 'wmctl key $SID 59 1073741883';
const DEL = 'wmctl key $SID 76 127';
const ESC = 'wmctl key $SID 41 27';
const sel = (row) => ['wmctl click $SID 100 100', HOME,
                      ...Array(row).fill(DOWN)].join('\n');
// Row 0 of the LISTBOX starts at surface y = TOP_H(26) + 2 for any row
// height; (100, 30) is inside it. (100, 300) is past a short listing.
const RC_ROW0 = 'wmctl click $SID 100 30 3';
const RC_PANE = 'wmctl click $SID 100 300 3';

// The wm.c desktop menus (geometry from wm.c MENU_*/CTX_W — the ctxmenu
// goldens' move-together rule): icon menu rows OPEN 4-24 / sep / CUT
// 32-52 / COPY 52-72 / DELETE 72-92 (0093); desktop menu NEW / SORT BY /
// REFRESH / PASTE 64-84 / sep / DISPLAY. Fresh desktop icons sort
// 'Copy of dfile.txt' < 'dfile.txt' < doom... (the 0091 test's rule; the
// Recycle Bin pins to the tail — 0093 — so it never shifts these); icon
// centers x=58, y = 16 + idx*64 + 32.
const ICON_CUT_Y = 42, ICON_COPY_Y = 62, DESK_PASTE_Y = 74;

const script = [
  // -- fixtures --
  'mkdir -p /root/optest/sub /root/optest2',
  'printf inner > /root/optest/sub/inner.txt',
  'printf A > /root/optest/a.txt',
  'printf B > /root/optest/b.txt',
  'printf M > /root/optest2/m.txt',
  'fileman /root/optest &',
  'sleep 5',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  // ---- the file menu on a DIRECTORY row (sub/ is row 0: dirs first) ----
  RC_ROW0,
  'sleep 0.5',
  'echo ==menu1',
  'wmctl tree',
  'echo ==cut',
  ESC,
  'sleep 0.3',
  // ---- rename via F2: a.txt (row 1) -> z.txt (settext + OK) ----
  sel(1),
  F2,
  'sleep 0.5',
  'echo ==rn1',
  'wmctl tree',
  'echo ==cut',
  'wmctl settext EDIT:1 z.txt',
  'wmctl click OK',
  'sleep 0.5',
  'echo ==l1',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // ---- rename EEXIST refusal, then the Enter commit: z.txt -> y.txt ----
  sel(2),                                        // sub/(0) b.txt(1) z.txt(2)
  F2,
  'sleep 0.5',
  'wmctl settext EDIT:1 b.txt',
  'wmctl click OK',
  'sleep 0.5',
  'echo ==rn2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',                              // dismiss the error box
  'sleep 0.3',
  'RSID=$(wmctl list | grep "Rename$" | sed "s/[^0-9].*//")',
  'wmctl click $RSID 100 36',                    // refocus the name EDIT
  'wmctl settext EDIT:1 y.txt',
  'wmctl key $RSID 40 13',                       // Enter commits (loop path)
  'sleep 0.5',
  'echo ==l2',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  // ---- copy a DIRECTORY, paste in place -> "Copy of sub" (recursive) ----
  RC_ROW0,
  'sleep 0.5',
  'wmctl click Copy',
  'sleep 0.3',
  RC_PANE,
  'sleep 0.5',
  'echo ==menu2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Paste',
  'sleep 0.5',
  'test -f "/root/optest/Copy of sub/inner.txt" && echo COPY-SUB-OK',
  'echo ==l3',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // ---- cut/paste = move; the slot clears -> Paste re-grays ----
  'wmctl settext EDIT:0 /root/optest2',
  'wmctl click Go',
  'sleep 0.5',
  RC_ROW0,                                       // m.txt (the only row)
  'sleep 0.5',
  'wmctl click Cut',
  'sleep 0.3',
  'wmctl settext EDIT:0 /root/optest/sub',
  'wmctl click Go',
  'sleep 0.5',
  RC_PANE,
  'sleep 0.5',
  'wmctl click Paste',
  'sleep 0.5',
  'test -f /root/optest/sub/m.txt && test ! -f /root/optest2/m.txt && echo MOVE-OK',
  RC_PANE,
  'sleep 0.5',
  'echo ==menu3',
  'wmctl tree',
  'echo ==cut',
  ESC,
  'sleep 0.3',
  // ---- delete: confirm No keeps, Yes deletes (m.txt row 1) ----
  sel(1),                                        // inner.txt(0) m.txt(1)
  DEL,
  'sleep 0.5',
  'echo ==del1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'sleep 0.5',
  'test -f /root/optest/sub/m.txt && echo DEL-NO-OK',
  sel(1),
  DEL,
  'sleep 0.5',
  'wmctl click Yes',
  'sleep 0.5',
  'test ! -f /root/optest/sub/m.txt && echo DEL-YES-OK',
  // ---- EROFS: delete under /bin fails with a clean error box ----
  'wmctl settext EDIT:0 /bin',
  'wmctl click Go',
  'sleep 0.5',
  sel(0),
  DEL,
  'sleep 0.5',
  'wmctl click Yes',
  'sleep 0.5',
  'echo ==erofs1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'sleep 0.3',
  'test -e /bin/awk && echo ROFS-INTACT',
  // ---- New Folder x2: the "New Folder", "New Folder 2" uniquifier ----
  'wmctl settext EDIT:0 /root/optest',
  'wmctl click Go',
  'sleep 0.5',
  RC_PANE,
  'sleep 0.5',
  'wmctl click "New Folder"',
  'sleep 0.5',
  RC_PANE,
  'sleep 0.5',
  'wmctl click "New Folder"',
  'sleep 0.5',
  'echo ==l4',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // ---- properties: dir (sub/) and file (inner.txt, 5 bytes) ----
  RC_ROW0,                                       // "Copy of sub/" sorts first
  'sleep 0.5',
  'wmctl click Properties',
  'sleep 0.5',
  'echo ==props1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'sleep 0.3',
  'wmctl settext EDIT:0 /root/optest/sub',
  'wmctl click Go',
  'sleep 0.5',
  RC_ROW0,                                       // inner.txt (the only row)
  'sleep 0.5',
  'wmctl click Properties',
  'sleep 0.5',
  'echo ==props2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'sleep 0.3',
  // ---- the wm.c desktop menus: text clip -> PASTE gray, never fires ----
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'printf plaintext | clip',
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${DESK_PASTE_Y}`,       // grayed: stays open
  'sleep 0.5',
  'echo ==dgray',
  'wmctl list',
  'echo ==cut',
  'wmctl key $CXSID 41 27',                      // Esc
  'sleep 0.3',
  // ---- desktop icon COPY -> desktop PASTE -> "Copy of dfile.txt" ----
  'printf D > /root/Desktop/dfile.txt',
  'sleep 1.5',                                   // the coarse desk tick
  'wmctl click $DSID 58 48 3',                   // dfile.txt = icon 0
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${ICON_COPY_Y}`,
  'sleep 0.3',
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${DESK_PASTE_Y}`,
  'sleep 0.5',
  'test -f "/root/Desktop/Copy of dfile.txt" && echo DESK-COPY-OK',
  // ---- desktop icon CUT -> paste in FILEMAN (cross-app move) ----
  'sleep 1.5',                                   // let the grid pick it up
  'wmctl click $DSID 58 48 3',                   // "Copy of dfile.txt" = icon 0
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${ICON_CUT_Y}`,
  'sleep 0.3',
  'wmctl settext EDIT:0 /root/optest',
  'wmctl click Go',
  'sleep 0.5',
  RC_PANE,
  'sleep 0.5',
  'wmctl click Paste',
  'sleep 0.5',
  'test -f "/root/optest/Copy of dfile.txt" && test ! -f "/root/Desktop/Copy of dfile.txt" && echo XAPP-MOVE-OK',
  'echo ==l5',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  '',
].join('\n');

const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
  { input: script, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
if (r.error) throw r.error;
const out = r.stdout;

function section(name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}
const popOf = (dump) => dump.split('popupmenu\n')[1] || '';
const item = (dump, label) =>
  dump.split('\n').find(l => l.includes(`text='${label}'`)) || '';

// ---- the file menu (a directory row) ----
const m1 = popOf(section('menu1'));
check('right-click a row raises the file menu (agent-visible popup)',
  m1.includes("text='Open'") && item(m1, 'Cut') !== '' &&
  item(m1, 'Copy') !== '' && item(m1, 'Rename') !== '' &&
  item(m1, 'Delete') !== '' && item(m1, 'Properties') !== '',
  section('menu1').slice(0, 400));
check('Open With is grayed on a directory',
  item(m1, 'Open With').includes('grayed'), item(m1, 'Open With'));

// ---- rename ----
const rn1 = section('rn1');
check('F2 opens the rename dialog prefilled with the name',
  /class=Rename/.test(rn1) && rn1.includes("Rename 'a.txt' to:"),
  rn1.slice(0, 400));
const l1 = section('l1');
check('settext + OK renames a.txt -> z.txt',
  l1.includes('z.txt') && !l1.includes('a.txt'), l1);
check('rename onto an existing name refuses (EEXIST error box, dialog stays)',
  section('rn2').includes('Cannot rename') && /class=Rename/.test(section('rn2')),
  section('rn2').slice(0, 500));
const l2 = section('l2');
check('Enter commits the retyped name (z.txt -> y.txt, b.txt intact)',
  l2.includes('y.txt') && !l2.includes('z.txt') && l2.includes('b.txt'), l2);
check('the rename dialog is gone after the Enter commit',
  !/\tRename$/.test(section('list1')), section('list1'));

// ---- copy / paste ----
check('pane menu Paste is enabled with a file list on the clipboard',
  item(popOf(section('menu2')), 'Paste') !== '' &&
  !item(popOf(section('menu2')), 'Paste').includes('grayed'),
  section('menu2').slice(0, 300));
check('copy+paste a directory in place -> recursive "Copy of sub"',
  out.includes('COPY-SUB-OK') && section('l3').includes('Copy of sub/'),
  section('l3'));
check('cut+paste moves across directories', out.includes('MOVE-OK'));
check('the slot clears after a cut-paste (Paste re-grays)',
  item(popOf(section('menu3')), 'Paste').includes('grayed'),
  section('menu3').slice(0, 300));

// ---- delete ----
const d1 = section('del1');
check('Del raises the confirm box (Recycle Bin wording, 0093)',
  d1.includes('Confirm File Delete') &&
  d1.includes("send 'm.txt' to the Recycle Bin"), d1.slice(0, 400));
check('confirm No keeps the file', out.includes('DEL-NO-OK'));
check('confirm Yes removes it from the dir', out.includes('DEL-YES-OK'));
check('delete under /bin fails with a clean EROFS box (0040)',
  section('erofs1').includes('Cannot delete'), section('erofs1').slice(0, 500));
check('the read-only volume is intact', out.includes('ROFS-INTACT'));

// ---- new folder ----
const l4 = section('l4');
check('New Folder twice uniquifies ("New Folder", "New Folder 2")',
  l4.includes('New Folder/') && l4.includes('New Folder 2/'), l4);

// ---- properties ----
check('directory Properties: type + location from stat',
  section('props1').includes('Type: Directory') &&
  section('props1').includes('Location: /root/optest') &&
  section('props1').includes('Copy of sub Properties'),
  section('props1').slice(0, 500));
check('file Properties: size in bytes',
  section('props2').includes('Type: File') &&
  section('props2').includes('Size: 5 bytes'),
  section('props2').slice(0, 500));

// ---- the wm.c desktop menus ----
check('desktop PASTE stays grayed for a text-only clipboard (menu stays open)',
  (section('dgray').match(/\tctxmenu$/m) || [])[0] !== undefined,
  section('dgray'));
check('desktop icon COPY -> desktop PASTE duplicates with "Copy of"',
  out.includes('DESK-COPY-OK'));
check('desktop icon CUT pastes into fileman (cross-app move, one kernel slot)',
  out.includes('XAPP-MOVE-OK') && section('l5').includes('Copy of dfile.txt'),
  section('l5'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nfileman ops e2e: ${failures} FAILED` : '\nfileman ops e2e: PASS');
process.exit(failures ? 1 : 0);
