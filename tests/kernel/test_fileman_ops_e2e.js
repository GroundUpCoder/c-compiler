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
//   - the status strip is comctl32's shared STATUSBAR (0230 redo — the
//     control notepad uses): descenders render un-clipped — shot leg below
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
const { driveBoot, freshImage, deskEntries, deskCell } = require('./lib/drive.js');

// The seeded desktop grid (drive.js model, todos/0184/0185): dirs sort
// first and the set wraps past column 0, so the test's dropped files land
// at derived cells, not "icon 0".
const DFILE = deskCell(deskEntries(['dfile.txt']), 'dfile.txt');
const DCOPY = deskCell(deskEntries(['dfile.txt', 'Copy of dfile.txt']),
                       'Copy of dfile.txt');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-fmops-');

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
// goldens' move-together rule): on a DOCUMENT icon (regular, not runnable
// — both targets here are .txt) the menu rows are OPEN 4-24 / EDIT 24-44
// (0202) / sep / CUT 52-72 / COPY 72-92 / DELETE 92-112; desktop menu NEW
// / SORT BY / REFRESH / PASTE 64-84 / sep / DISPLAY. Desktop cells are
// derived from the drive.js grid model (deskEntries/deskCell — dirs
// first, Recycle Bin tail-pinned, column wrap at 11 rows; todos/
// 0184/0185), never "icon 0" row math.
const ICON_CUT_Y = 62, ICON_COPY_Y = 82, DESK_PASTE_Y = 74;

const script = [
  // -- fixtures --
  'mkdir -p /root/optest/sub /root/optest2',
  'printf inner > /root/optest/sub/inner.txt',
  'printf A > /root/optest/a.txt',
  'printf B > /root/optest/b.txt',
  'printf M > /root/optest2/m.txt',
  'fileman /root/optest &',
  'wmctl wait label Go 10000',                   // fileman controls + msg loop up (window listed)
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  // ---- status-strip descender clip (0230): shot before anything moves ----
  'wmctl wait text msctls_statusbar32:0 "3 object(s)" 8000', // status text set (3 fixture rows)
  'echo ==sstree',
  // The tree round-trip is also the paint barrier: the agent socket is
  // served from the GetMessage IDLE loop, and WM_PAINT delivers before the
  // loop idles — so by the time this dump answers, the strip's repaint has
  // landed in the surface and the shot below can't catch a pre-paint frame.
  'wmctl tree',
  'echo ==cut',
  'wmctl shot $SID /root/ss.ppm && echo ss-shot-ok',
  'echo ==ssshot',
  'base64 /root/ss.ppm',
  'echo ==cut',
  // ---- the file menu on a DIRECTORY row (sub/ is row 0: dirs first) ----
  RC_ROW0,
  'wmctl wait label Properties 8000',            // the row popup menu is populated
  'echo ==menu1',
  'wmctl tree',
  'echo ==cut',
  ESC,
  'wmctl wait nolabel Properties 6000',          // menu dismissed before the next select-click
  // ---- rename via F2: a.txt (row 1) -> z.txt (settext + OK) ----
  sel(1),
  F2,
  'wmctl wait label OK 8000',                     // rename dialog controls (EDIT:1) exist
  'echo ==rn1',
  'wmctl tree',
  'echo ==cut',
  'wmctl settext EDIT:1 z.txt',
  'wmctl click OK',
  'wmctl wait text LISTBOX:0 z.txt 8000',         // rename committed + listbox refreshed
  'echo ==l1',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // ---- rename EEXIST refusal, then the Enter commit: z.txt -> y.txt ----
  sel(2),                                        // sub/(0) b.txt(1) z.txt(2)
  F2,
  'wmctl wait label OK 8000',                     // second rename dialog up
  'wmctl settext EDIT:1 b.txt',
  'wmctl click OK',
  'wmctl wait count "Rename" 2 8000',             // EEXIST error box (2nd "Rename" window) up, dialog stays
  'echo ==rn2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',                              // dismiss the error box
  'wmctl wait count "Rename" 1 6000',             // error box gone, dialog remains
  'RSID=$(wmctl list | grep "Rename$" | sed "s/[^0-9].*//")',
  'wmctl click $RSID 100 36',                    // refocus the name EDIT
  'wmctl settext EDIT:1 y.txt',
  'wmctl key $RSID 40 13',                       // Enter commits (loop path)
  'wmctl wait text LISTBOX:0 y.txt 8000',         // retyped name committed (dialog closed)
  'echo ==l2',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  // ---- copy a DIRECTORY, paste in place -> "Copy of sub" (recursive) ----
  RC_ROW0,
  'wmctl wait label Copy 8000',                   // row menu up
  'wmctl click Copy',
  'wmctl wait nolabel Copy 6000',                 // Copy dispatched (clipboard set), menu closed
  RC_PANE,
  'wmctl wait label Paste 8000',                  // pane menu up
  'echo ==menu2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Paste',
  'wmctl wait text LISTBOX:0 "Copy of sub" 8000', // paste done + listbox refreshed
  'test -f "/root/optest/Copy of sub/inner.txt" && echo COPY-SUB-OK',
  'echo ==l3',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // ---- cut/paste = move; the slot clears -> Paste re-grays ----
  'wmctl settext EDIT:0 /root/optest2',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 m.txt 8000',         // navigated to optest2 (m.txt listed)
  RC_ROW0,                                       // m.txt (the only row)
  'wmctl wait label Cut 8000',                     // row menu up
  'wmctl click Cut',
  'wmctl wait nolabel Cut 6000',                  // Cut dispatched (clipboard set), menu closed
  'wmctl settext EDIT:0 /root/optest/sub',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 inner.txt 8000',      // navigated to sub (inner.txt listed)
  RC_PANE,
  'wmctl wait label Paste 8000',                  // pane menu up
  'wmctl click Paste',
  'wmctl wait text LISTBOX:0 m.txt 8000',          // move landed m.txt in sub
  'test -f /root/optest/sub/m.txt && test ! -f /root/optest2/m.txt && echo MOVE-OK',
  RC_PANE,
  'wmctl wait label Paste 8000',                  // pane menu up (Paste now grayed)
  'echo ==menu3',
  'wmctl tree',
  'echo ==cut',
  ESC,
  'wmctl wait nolabel Paste 6000',                // menu dismissed before the select-click
  // ---- delete: confirm No keeps, Yes deletes (m.txt row 1) ----
  sel(1),                                        // inner.txt(0) m.txt(1)
  DEL,
  'wmctl wait win "Confirm File Delete" 8000',     // confirm box up
  'echo ==del1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'wmctl wait nowin "Confirm File Delete" 6000',   // No dismissed the box
  'test -f /root/optest/sub/m.txt && echo DEL-NO-OK',
  sel(1),
  DEL,
  'wmctl wait win "Confirm File Delete" 8000',     // confirm box up again
  'wmctl click Yes',
  'wmctl wait nowin "Confirm File Delete" 6000',   // Yes handled (delete done, box closed)
  'test ! -f /root/optest/sub/m.txt && echo DEL-YES-OK',
  // ---- EROFS: delete under /bin fails with a clean error box ----
  'wmctl settext EDIT:0 /bin',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 awk 8000',            // navigated to /bin (listing loaded)
  sel(0),
  DEL,
  'wmctl wait win "Confirm File Delete" 8000',     // confirm box up
  'wmctl click Yes',
  // The main window is titled "File Manager - <cwd>" (0106) and wait-count
  // matches titles EXACTLY, so the EROFS MessageBox is the ONLY window titled
  // exactly "File Manager" — wait for its presence/absence, not a count of 2/1
  // (those were dead waits: the count never left 1/0).
  'wmctl wait win "File Manager" 8000',             // EROFS error box up
  'echo ==erofs1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'wmctl wait nowin "File Manager" 6000',           // error box dismissed
  'test -e /bin/awk && echo ROFS-INTACT',
  // ---- New Folder x2: the "New Folder", "New Folder 2" uniquifier ----
  'wmctl settext EDIT:0 /root/optest',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 y.txt 8000',          // navigated back to optest
  RC_PANE,
  'wmctl wait label "New Folder" 8000',            // pane menu up
  'wmctl click "New Folder"',
  'wmctl wait text LISTBOX:0 "New Folder" 8000',    // first folder created + refreshed
  RC_PANE,
  'wmctl wait label "New Folder" 8000',            // pane menu up again
  'wmctl click "New Folder"',
  'wmctl wait text LISTBOX:0 "New Folder 2" 8000',  // uniquified second folder created
  'echo ==l4',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  // ---- properties: dir (sub/) and file (inner.txt, 5 bytes) ----
  RC_ROW0,                                       // "Copy of sub/" sorts first
  'wmctl wait label Properties 8000',            // row menu up
  'wmctl click Properties',
  'wmctl wait win "Copy of sub Properties" 8000',  // properties box up
  'echo ==props1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'wmctl wait nowin "Copy of sub Properties" 6000',
  'wmctl settext EDIT:0 /root/optest/sub',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 inner.txt 8000',      // navigated to sub
  RC_ROW0,                                       // inner.txt (the only row)
  'wmctl wait label Properties 8000',            // row menu up
  'wmctl click Properties',
  'wmctl wait win "inner.txt Properties" 8000',    // properties box up
  'echo ==props2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'wmctl wait nowin "inner.txt Properties" 6000',
  // ---- the wm.c desktop menus: text clip -> PASTE gray, never fires ----
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'printf plaintext | clip',
  'wmctl click $DSID 400 300 3',
  'wmctl wait win ctxmenu 8000',                  // desktop context menu up
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${DESK_PASTE_Y}`,       // grayed: stays open
  // KEEP: negative "action ignored" check — bounded wait to let a (wrong)
  // dismissal happen, then assert the grayed Paste left the menu open.
  'sleep 0.5',
  'echo ==dgray',
  'wmctl list',
  'echo ==cut',
  'wmctl key $CXSID 41 27',                      // Esc
  'wmctl wait nowin ctxmenu 6000',               // menu dismissed
  // ---- desktop icon COPY -> desktop PASTE -> "Copy of dfile.txt" ----
  'printf D > /root/Desktop/dfile.txt',
  // KEEP: coarse desktop-icon tick — wm.c re-reads the Desktop dir on a
  // timer, so the new icon has no event to wait on before the icon click.
  'sleep 1.5',
  `wmctl click $DSID ${DFILE.x + 42} ${DFILE.y + 32} 3`,   // dfile.txt's sorted cell
  'wmctl wait win ctxmenu 8000',                  // icon context menu up
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${ICON_COPY_Y}`,
  'wmctl wait nowin ctxmenu 6000',               // Copy handled, menu closed (clipboard set)
  'wmctl click $DSID 400 300 3',
  'wmctl wait win ctxmenu 8000',                  // desktop context menu up
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${DESK_PASTE_Y}`,
  'wmctl wait nowin ctxmenu 6000',               // Paste handled (file duplicated), menu closed
  'test -f "/root/Desktop/Copy of dfile.txt" && echo DESK-COPY-OK',
  // ---- desktop icon CUT -> paste in FILEMAN (cross-app move) ----
  // KEEP: coarse desktop-icon tick — the just-pasted "Copy of dfile.txt"
  // icon only appears after wm.c's next timed Desktop re-read.
  'sleep 1.5',
  `wmctl click $DSID ${DCOPY.x + 42} ${DCOPY.y + 32} 3`,   // "Copy of dfile.txt"'s cell
  'wmctl wait win ctxmenu 8000',                  // icon context menu up
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${ICON_CUT_Y}`,
  'wmctl wait nowin ctxmenu 6000',               // Cut handled, menu closed (clipboard set)
  'wmctl settext EDIT:0 /root/optest',
  'wmctl click Go',
  'wmctl wait text LISTBOX:0 y.txt 8000',          // navigated to optest
  RC_PANE,
  'wmctl wait label Paste 8000',                  // pane menu up
  'wmctl click Paste',
  'wmctl wait text LISTBOX:0 "Copy of dfile.txt" 8000', // cross-app move landed + refreshed
  'test -f "/root/optest/Copy of dfile.txt" && test ! -f "/root/Desktop/Copy of dfile.txt" && echo XAPP-MOVE-OK',
  'echo ==l5',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  '',
].join('\n');

const r = driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 });
const out = r.stdout;

function section(name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}
const popOf = (dump) => dump.split('popupmenu\n')[1] || '';
const item = (dump, label) =>
  dump.split('\n').find(l => l.includes(`text='${label}'`)) || '';

// ---- the status strip's descender clearance (0230) ----
// The strip is comctl32's STATUSBAR (the shared control notepad uses):
// font-derived bar height + DT_VCENTER paint, so a full glyph cell fits and
// descender rows must not clip at the bottom edge (the 0229 disease at the
// old private-STATIC site). Every pixel check anchors on the live rect from
// the tree dump, never a hardcoded height.
function parsePpm(b64) {
  const buf = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
  let p = 0;
  const tok = () => { while ([32, 10, 9, 13].includes(buf[p])) p++;
                      let s = p; while (![32, 10, 9, 13].includes(buf[p])) p++;
                      return buf.slice(s, p).toString(); };
  const magic = tok(); const w = +tok(), h = +tok(); tok(); p++;
  return { buf, w, h, data: p, magic };
}
function maxInkRow(P, x0, x1, y0, y1) {          // last row with any dark px
  let m = y0 - 1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = P.data + (y * P.w + x) * 3;
    if (P.buf[i] < 100 && P.buf[i + 1] < 100 && P.buf[i + 2] < 100) { m = y; break; }
  }
  return m;
}
const ssRow = section('sstree').split('\n')
  .find(l => /class=msctls_statusbar32/.test(l) && /object\(s\)/.test(l)) || '';
const ssM = ssRow.match(/rect=(-?\d+),(-?\d+) (\d+)x(\d+)/) || [];
const [ssX, ssY, , ssH] = ssM.slice(1).map(Number);
check('status strip located in the agent tree', ssM.length > 0, ssRow);
const ssP = parsePpm(section('ssshot'));
check('status-strip shot is a P6 frame', ssP.magic === 'P6', ssP.magic);
/* 0230 red->green pin: the old STATUS_H 18 vs the 19px stock cell. */
check('status-strip height derives from the stock font cell (0230)',
  ssH >= 21, 'H=' + ssH + ' row=' + JSON.stringify(ssRow.slice(0, 120)));
// "3 object(s)" in the 8px-advance mono stock font, drawn DT_LEFT with the
// STATUSBAR's 6px well inset: 'j' occupies cell cols x+38..46, 'ect' (no
// descenders) cols x+46..70 — the descender must reach >=3 rows below the
// x-height.
const jMax = maxInkRow(ssP, ssX + 38, ssX + 46, ssY, ssY + ssH);
const ectMax = maxInkRow(ssP, ssX + 46, ssX + 70, ssY, ssY + ssH);
check("descenders render: 'j' reaches >=3 rows below the x-height glyphs",
  jMax - ectMax >= 3, 'j=' + jMax + ' ect=' + ectMax);
/* Unclipped means CLEARANCE: ink ON the strip's bottom row is exactly what
 * a clipped render looks like, so "reaches the edge" proves nothing — the
 * descender bottom must sit >=2 clear rows above the clip edge. Under the
 * old hardcoded-18 geometry the deepest 'j' row WAS the strip's last row
 * (an exact-fit razor edge, one font-hinting change from visible loss) —
 * this is the pixel half of the red->green. */
check('descender bottom clears the strip clip edge by >=2 rows',
  jMax >= ssY && jMax <= ssY + ssH - 3,
  'jMax=' + jMax + ' strip=' + ssY + '+' + ssH);

// ---- the file menu (a directory row) ----
const m1 = popOf(section('menu1'));
check('right-click a row raises the file menu (agent-visible popup)',
  m1.includes("text='Open'") && item(m1, 'Cut') !== '' &&
  item(m1, 'Copy') !== '' && item(m1, 'Rename') !== '' &&
  item(m1, 'Delete') !== '' && item(m1, 'Properties') !== '',
  section('menu1').slice(0, 400));
check('Open With is grayed on a directory',
  item(m1, 'Open With').includes('grayed'), item(m1, 'Open With'));
check('Edit is grayed on a directory (0202)',
  item(m1, 'Edit').includes('grayed'), item(m1, 'Edit'));

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
