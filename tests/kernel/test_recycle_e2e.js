#!/usr/bin/env node
// 0093 acceptance, headless: the Recycle Bin — trash, restore, empty.
// Covers:
//   - fileman Del / menu Delete send to the trash store (confirm wording
//     says Recycle Bin; No keeps, Yes moves): the file leaves its dir and
//     lands in /root/.recycle/files with an info/ sidecar recording the
//     original absolute path; same-basename trashings uniquify ("x",
//     "x 2") with per-entry sidecars
//   - Shift+Del bypasses to a confirmed PERMANENT delete (nothing stored)
//   - browsing the store swaps the row menu to Restore/Delete/Properties
//     and the pane menu to Empty Recycle Bin/Refresh; Delete IN the store
//     is permanent
//   - Restore returns the entry to its recorded path (sidecar goes with
//     it); an occupied target prompts Replace? (No keeps both, Yes
//     replaces)
//   - Empty Recycle Bin confirms, clears files/ + info/, then grays
//   - EROFS: trashing under /bin fails clean AND leaves no stray store
//     entry (the fo_trash sweep of fo_move's EXDEV partial copy)
//   - the wm.c desktop: the bin icon is a real /root/Desktop launcher
//     pinned to the grid's TAIL (row 7 on the seeded desktop), its glyph
//     flips empty->full->empty with store contents (tile-center pixel),
//     the icon menu grew DELETE + RENAME (120x116, todos/0103), the bin's own menu is
//     OPEN/EMPTY RECYCLE BIN (120x56; EMPTY grays when empty and a
//     grayed click leaves the menu open), the Del key trashes the
//     selection, and double-clicking the bin opens fileman AT the store
//
// Geometry mirrors os/wm.c: on a DOCUMENT icon (junk.txt) the menu rows
// are OPEN 4-24 / EDIT 24-44 (0202) / sep / CUT 52-72 / COPY 72-92 /
// DELETE 92-112; bin menu OPEN 4-24 / sep / EMPTY 32-52.
// Desktop (1024x768): the seeded set wraps past column 0 (11 rows/col since
// todos/0184) and the bin sorts LAST (entcmp tail-pin, todos/0093) into
// column 1 — every bin/junk/kdel cell is DERIVED from the drive.js grid
// model (deskEntries/deskCell over os/image.json, the 0166 rule), never row
// math. Click offset +30/+32 in the cell; glyph pixels at +18 (center) /
// +10 (rim) from the cell top.
//
// Run: node tests/kernel/test_recycle_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage, deskEntries, deskCell } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

// The seeded desktop grid (drive.js model, todos/0184/0185): the icon set
// wraps past column 0 at 1024x768 (11 rows/col) and the Recycle Bin tail-pin
// now lands in column 1, so every bin/junk cell is derived, never row math.
const BIN = deskCell(deskEntries(), 'Recycle Bin');
const JUNK = deskCell(deskEntries(['junk.txt']), 'junk.txt');
const KDEL = deskCell(deskEntries(['kdel.txt']), 'kdel.txt');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-recycle-');

const HOME = 'wmctl key $SID 74 1073741898';
const DEL = 'wmctl key $SID 76 127';
const sel0 = ['wmctl click $SID 100 100', HOME].join('\n');
const RC_ROW0 = 'wmctl click $SID 100 30 3';
const RC_PANE = 'wmctl click $SID 100 300 3';

// 0154 event-based waits. Two agent-tree polls carry most of the sync here:
//   CONFIRM  a MessageBox (Yes/No or Replace) is up — its "No" button is an
//            HWND that only the dialog owns (the fileman window has none), so
//            the poll fires exactly when the modal is built and serving.
//   SETTLED  fileman is back at its idle loop with the op finished — "Go" is
//            always present, and after a BUTTON/dialog click (which PostMessages
//            BM_CLICK, returned in the serving iteration) the probe is served
//            only once the handler + refill have run, so it's a safe post-op
//            barrier before a disk check.
// What stays a `sleep`: fileman's context menus are in-surface TrackPopupMenus
// — not WM windows (not in `wmctl list`) and their items aren't HWNDs, so
// neither wait can see them; plus the wm.c desktop's coarse re-read tick, its
// own (non-win32) disk trashes, and the negative "menu didn't close" check.
const CONFIRM = 'wmctl wait label No 8000';
const SETTLED = 'wmctl wait label Go 8000';

const script = [
  // -- fixtures --
  'mkdir -p /root/t1 /root/t2',
  'printf hello > /root/t1/a.txt',
  'printf one > /root/t1/p.txt',
  'printf A > /root/t1/dup.txt',
  'printf B > /root/t2/dup.txt',
  'fileman /root/t1 &',
  'wmctl wait label Go 10000',                    // fileman built its controls + reached the message loop
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  // ---- Del -> Recycle Bin confirm; No keeps, Yes trashes (a.txt row 0) ----
  sel0,
  DEL,
  CONFIRM,                                       // the "send to Recycle Bin?" dialog is up
  'echo ==del1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'wmctl wait nolabel No 8000',                  // dialog dismissed
  'test -f /root/t1/a.txt && echo NO-KEEPS',
  sel0,
  DEL,
  CONFIRM,
  'wmctl click Yes',
  SETTLED,                                       // trash done, fileman idle again
  'test ! -f /root/t1/a.txt && test -f /root/.recycle/files/a.txt && echo TRASHED',
  'echo "==sidecar $(cat /root/.recycle/info/a.txt | head -1)"',
  // ---- Shift+Del: permanent (p.txt sorts after dup.txt: row 1) ----
  sel0,
  'wmctl key $SID 81 1073741905',                // Down -> p.txt
  'wmctl keydown $SID 225 1073742049 1',         // LSHIFT down
  'wmctl key $SID 76 127 1',
  'wmctl keyup $SID 225 1073742049 0',
  CONFIRM,                                       // the permanent-delete confirm is up
  'echo ==perm1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  SETTLED,
  'test ! -f /root/t1/p.txt && test ! -e /root/.recycle/files/p.txt && echo PERM-GONE',
  // ---- same-basename uniquifier: dup.txt from t1 then t2 ----
  sel0,
  DEL,
  CONFIRM,
  'wmctl click Yes',
  // (no settle: the settext/Go below are agent ops, served only after the trash)
  'wmctl settext EDIT:0 /root/t2',
  'wmctl click Go',
  'wmctl wait text "LISTBOX:0" dup.txt 8000',    // t2's listing loaded
  sel0,
  DEL,
  CONFIRM,
  'wmctl click Yes',
  SETTLED,
  'grep -q A /root/.recycle/files/dup.txt && grep -q B "/root/.recycle/files/dup.txt 2" && echo UNIQ-OK',
  // ---- the store view: row + pane menus ----
  'wmctl settext EDIT:0 /root/.recycle/files',
  'wmctl click Go',
  'wmctl wait text "LISTBOX:0" a.txt 8000',      // the store listing loaded
  RC_ROW0,                                       // a.txt (sorts first)
  'sleep 0.5',                                   // in-surface TrackPopupMenu — no WM window / HWND to poll
  'echo ==trashrow',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',                        // Esc
  'sleep 0.3',                                   // popup dismiss — nothing pollable
  RC_PANE,
  'sleep 0.5',                                   // in-surface popup — nothing pollable
  'echo ==trashpane',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'sleep 0.3',                                   // popup dismiss
  // ---- restore a.txt: back at the original, sidecar gone ----
  RC_ROW0,
  'sleep 0.5',                                   // in-surface popup — nothing pollable
  'wmctl click Restore',
  'sleep 0.5',                                   // menu-item click posts no msg + no store-view signal for the restore — settle before the disk check
  'test -f /root/t1/a.txt && test ! -e /root/.recycle/files/a.txt && test ! -e /root/.recycle/info/a.txt && echo RESTORED',
  // ---- restore clash: dup.txt's original re-created -> Replace? ----
  'printf clash > /root/t1/dup.txt',
  RC_ROW0,                                       // dup.txt now row 0
  'sleep 0.5',                                   // in-surface popup — nothing pollable
  'wmctl click Restore',
  CONFIRM,                                       // EEXIST -> the "Replace it?" dialog is up
  'echo ==replace',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'wmctl wait nolabel No 8000',                  // dialog dismissed
  'test -f /root/.recycle/files/dup.txt && grep -q clash /root/t1/dup.txt && echo REPLACE-NO',
  RC_ROW0,
  'sleep 0.5',                                   // in-surface popup — nothing pollable
  'wmctl click Restore',
  CONFIRM,
  'wmctl click Yes',
  SETTLED,
  'grep -q A /root/t1/dup.txt && echo REPLACE-YES',
  // ---- delete IN the store is permanent ("dup.txt 2" the only row) ----
  sel0,
  DEL,
  CONFIRM,                                       // the permanent-delete confirm is up
  'echo ==permintrash',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  SETTLED,
  'test ! -e "/root/.recycle/files/dup.txt 2" && test ! -e "/root/.recycle/info/dup.txt 2" && echo TRASH-DEL-PERM',
  // ---- Empty Recycle Bin: fill one, confirm, cleared, grayed after ----
  'printf z > /root/t1/z.txt',
  'wmctl settext EDIT:0 /root/t1',
  'wmctl click Go',
  'wmctl wait text "LISTBOX:0" z.txt 8000',      // back at t1 with z.txt listed
  'wmctl click $SID 100 100',
  'wmctl key $SID 74 1073741898',
  'wmctl key $SID 81 1073741905',                // Down (a.txt, dup.txt, z.txt: z row 2)
  'wmctl key $SID 81 1073741905',
  DEL,
  CONFIRM,
  'wmctl click Yes',
  // (no settle: the settext/Go below serialize behind the trash)
  'wmctl settext EDIT:0 /root/.recycle/files',
  'wmctl click Go',
  'wmctl wait text "LISTBOX:0" z.txt 8000',      // z.txt now in the store
  RC_PANE,
  'sleep 0.5',                                   // in-surface popup — nothing pollable
  'wmctl click "Empty Recycle Bin"',
  CONFIRM,                                       // the Empty confirm dialog is up
  'echo ==emptybox',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  SETTLED,
  'echo "==left F$(ls /root/.recycle/files | wc -l | tr -d \\" \\")-I$(ls /root/.recycle/info | wc -l | tr -d \\" \\")"',
  RC_PANE,
  'sleep 0.5',                                   // in-surface popup — nothing pollable
  'echo ==panegray',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'sleep 0.3',                                   // popup dismiss
  // ---- EROFS: trash under /bin fails clean, no stray store entry ----
  'wmctl settext EDIT:0 /bin',
  'wmctl click Go',
  'wmctl wait text "LISTBOX:0" awk 8000',        // /bin listing loaded
  sel0,
  DEL,
  CONFIRM,                                       // the "send to Recycle Bin?" confirm is up
  'wmctl click Yes',
  'wmctl wait label OK 8000',                    // the EROFS error box ("Cannot delete") is up
  'echo ==erofs',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  SETTLED,
  'test -e /bin/awk && echo ROFS-INTACT',
  'echo "==stray S$(ls /root/.recycle/files | wc -l | tr -d \\" \\")-END"',
  // ---- the wm.c desktop: glyph empty -> full -> empty ----
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  // The bin pins to the grid TAIL (entcmp) — its cell, and junk.txt's
  // sorted cell, are derived from the drive.js grid model (deskEntries/
  // deskCell over os/image.json, the 0166 rule), so a new seeded icon —
  // or the 0184 column wrap — can't silently shift them.
  `BINX=${BIN.x + 42}`,
  `BINY=${BIN.y + 30}`,
  'wmctl shot $DSID /root/e.ppm && echo E-SHOT',
  'printf junk > /root/Desktop/junk.txt',
  'sleep 1.5',                                   // the coarse desk tick (wm.c re-reads Desktop on a timer — no event)
  // junk.txt's sorted cell; icon menu
  `wmctl click $DSID ${JUNK.x + 42} ${JUNK.y + 32} 3`,
  'wmctl wait win ctxmenu 8000',                 // wm.c's ctxmenu IS a real WM window
  'echo ==iconmenu',
  'wmctl list',
  'echo ==cut',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 30 90',                    // Delete (Edit shifted it, 0202;
                                                 // engine rows 0259: 1+2*18+8+2*18+9)
  'sleep 1.5',                                   // wm.c trashes + the coarse glyph tick must flip empty->full before F-SHOT (no event)
  'test ! -f /root/Desktop/junk.txt && test -f /root/.recycle/files/junk.txt && echo DESK-TRASH',
  'wmctl shot $DSID /root/f.ppm && echo F-SHOT',
  // ---- the bin's own menu: OPEN / EMPTY RECYCLE BIN (bin row, y=$BINY) ----
  'wmctl click $DSID $BINX $BINY 3',
  'wmctl wait win ctxmenu 8000',
  'echo ==binmenu',
  'wmctl list',
  'echo ==cut',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 30 36',                    // Empty Recycle Bin (1+18+8+9)
  'sleep 1.5',                                   // wm.c empties + the coarse glyph tick must flip full->empty before G-SHOT (no event)
  'echo "==binleft B$(ls /root/.recycle/files | wc -l | tr -d \\" \\")-END"',
  'wmctl shot $DSID /root/g.ppm && echo G-SHOT',
  // grayed EMPTY: click leaves the menu open
  'wmctl click $DSID $BINX $BINY 3',
  'wmctl wait win ctxmenu 8000',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 30 36',
  'sleep 0.5',                                   // negative check: a grayed EMPTY click must NOT close the menu (nothing to poll for)
  'echo ==graystay',
  'wmctl list',
  'echo ==cut',
  'wmctl key $CXSID 41 27',
  'wmctl wait nowin ctxmenu 8000',               // menu dismissed
  // ---- the Del KEY on a selected icon ----
  'printf k > /root/Desktop/kdel.txt',
  'sleep 1.5',                                   // coarse desk tick so the new icon is laid out (no event)
  `wmctl click $DSID ${KDEL.x + 42} ${KDEL.y + 32}`,   // kdel.txt's sorted cell, select
  'sleep 0.7',                                   // let wm.c register the single-click selection (no queryable selection state)
  'wmctl key $DSID 76 127',
  'sleep 1.5',                                   // wm.c trashes the selection (no event; coarse tick)
  'test ! -f /root/Desktop/kdel.txt && test -f /root/.recycle/files/kdel.txt && echo KEY-DEL',
  // ---- double-click the bin: fileman opens AT the store ----
  'wmctl dblclick $DSID $BINX $BINY',
  'wmctl wait win "File Manager - /root/.recycle/f" 10000',  // the second fileman booted (title truncated to 31 chars)
  'echo ==binopen',
  'wmctl list',
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
const row = (sec, title) =>
  sec.split('\n').find(l => l.endsWith('\t' + title)) || '';

// ---- fileman: trash + confirm wording ----
check('Del raises the Recycle Bin confirm',
  section('del1').includes("send 'a.txt' to the Recycle Bin"),
  section('del1').slice(0, 400));
check('confirm No keeps the file', out.includes('NO-KEEPS'));
check('confirm Yes moves it into /root/.recycle/files', out.includes('TRASHED'));
check('the sidecar records the original absolute path',
  out.includes('==sidecar /root/t1/a.txt'),
  out.slice(out.indexOf('==sidecar')).slice(0, 40));
check('Shift+Del confirm says permanent delete (not Recycle Bin)',
  section('perm1').includes("delete 'p.txt'") &&
  !section('perm1').includes('Recycle Bin'), section('perm1').slice(0, 400));
check('Shift+Del really deletes (nothing stored)', out.includes('PERM-GONE'));
check('same-basename trashings uniquify ("dup.txt", "dup.txt 2")',
  out.includes('UNIQ-OK'));

// ---- the store view ----
const tr = popOf(section('trashrow'));
check('store row menu is Restore/Delete/Properties (no Open/Cut)',
  item(tr, 'Restore') !== '' && item(tr, 'Delete') !== '' &&
  item(tr, 'Properties') !== '' && item(tr, 'Open') === '' &&
  item(tr, 'Cut') === '', section('trashrow').slice(0, 400));
const tp = popOf(section('trashpane'));
check('store pane menu is Empty Recycle Bin/Refresh (enabled while full)',
  item(tp, 'Empty Recycle Bin') !== '' &&
  !item(tp, 'Empty Recycle Bin').includes('grayed') &&
  item(tp, 'Refresh') !== '' && item(tp, 'Paste') === '',
  section('trashpane').slice(0, 400));
check('Restore returns the file (sidecar gone with it)', out.includes('RESTORED'));
check('Restore onto an occupied path prompts Replace?',
  section('replace').includes('Replace it?'), section('replace').slice(0, 400));
check('Replace No keeps both', out.includes('REPLACE-NO'));
check('Replace Yes restores over it', out.includes('REPLACE-YES'));
check('delete IN the store confirms as permanent',
  section('permintrash').includes("delete 'dup.txt 2'") &&
  !section('permintrash').includes('Recycle Bin'),
  section('permintrash').slice(0, 400));
check('...and really deletes entry + sidecar', out.includes('TRASH-DEL-PERM'));

// ---- empty ----
check('Empty Recycle Bin confirms',
  section('emptybox').includes('permanently delete all items'),
  section('emptybox').slice(0, 400));
check('Empty clears files/ AND info/', out.includes('==left F0-I0'),
  out.slice(out.indexOf('==left')).slice(0, 20));
check('Empty grays once the store is empty',
  item(popOf(section('panegray')), 'Empty Recycle Bin').includes('grayed'),
  section('panegray').slice(0, 300));

// ---- EROFS ----
check('trash under /bin fails with a clean error box',
  section('erofs').includes('Cannot delete'), section('erofs').slice(0, 400));
check('the read-only volume is intact', out.includes('ROFS-INTACT'));
check('a failed trash leaves NO stray store entry (the fo_trash sweep)',
  out.includes('==stray S0-END'), out.slice(out.indexOf('==stray')).slice(0, 20));

// ---- the wm.c desktop ----
const im = section('iconmenu');
check('icon menu grew Delete + Rename + Edit (h 120 on a document, 0103/0202)',
  /x120\+/.test(row(im, 'ctxmenu')), JSON.stringify(im));
check('icon DELETE trashes the desktop file', out.includes('DESK-TRASH'));
const bm = section('binmenu');
check('the bin icon gets its own Open/Empty menu (h 48)',
  /x48\+/.test(row(bm, 'ctxmenu')), JSON.stringify(bm));
check('EMPTY RECYCLE BIN empties the store', out.includes('==binleft B0-END'),
  out.slice(out.indexOf('==binleft')).slice(0, 24));
check('grayed EMPTY leaves the menu open (0091 rule)',
  row(section('graystay'), 'ctxmenu') !== '', JSON.stringify(section('graystay')));
check('the Del key trashes the selected icon', out.includes('KEY-DEL'));
check('double-clicking the bin opens fileman at the store',
  section('binopen').includes('File Manager - /root/.recycle/f'),
  JSON.stringify(section('binopen')));

// ---- glyph pixels: e (empty) -> f (full) -> g (emptied) ----
{
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  const px = (name, x, y) => {
    const ppm = COMMON.readFileBytes(ufs, '/root/' + name);
    const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1');
    const off = head.indexOf('255\n') + 4;
    return String(Array.from(
      ppm.subarray(off + (y * 1024 + x) * 3, off + (y * 1024 + x) * 3 + 3)));
  };
  for (const s of ['E', 'F', 'G']) check(`${s} shot written`, out.includes(s + '-SHOT'));
  const WHITE = '255,255,255', NAVY = '0,0,128';
  // The bin sits at its derived cell (BIN — column 1 since the 0184 wrap);
  // the basket rim samples at +10 (navy) and the center at +18 (white
  // empty / navy full), x at the tile center (+42).
  const BX = BIN.x + 42, CEN = BIN.y + 18, RIM = BIN.y + 10;
  check('bin glyph starts empty (white center, navy rim)',
    px('e.ppm', BX, CEN) === WHITE && px('e.ppm', BX, RIM) === NAVY,
    [px('e.ppm', BX, CEN), px('e.ppm', BX, RIM)].join(' | '));
  check('trashing flips the glyph full (navy center)',
    px('f.ppm', BX, CEN) === NAVY, px('f.ppm', BX, CEN));
  check('emptying flips it back (white center)',
    px('g.ppm', BX, CEN) === WHITE, px('g.ppm', BX, CEN));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nrecycle e2e: ${failures} FAILED` : '\nrecycle e2e: PASS');
process.exit(failures ? 1 : 0);
