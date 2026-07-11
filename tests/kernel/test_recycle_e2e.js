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
//     the icon menu grew DELETE (120x96), the bin's own menu is
//     OPEN/EMPTY RECYCLE BIN (120x56; EMPTY grays when empty and a
//     grayed click leaves the menu open), the Del key trashes the
//     selection, and double-clicking the bin opens fileman AT the store
//
// Geometry mirrors os/wm.c: icon menu rows OPEN 4-24 / sep / CUT 32-52 /
// COPY 52-72 / DELETE 72-92; bin menu OPEN 4-24 / sep / EMPTY 32-52.
// Desktop (1024x768): seeded icons rows 0-6, the bin row 7 (sorts last);
// a junk.txt sorts to row 3 (after gameboy). Icon centers x=58,
// y = 16 + row*64 + 32; the bin tile center is (58, 482).
//
// Run: node tests/kernel/test_recycle_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-recycle-'));
const image = path.join(tmp, 'os.img');

const HOME = 'wmctl key $SID 74 1073741898';
const DEL = 'wmctl key $SID 76 127';
const sel0 = ['wmctl click $SID 100 100', HOME].join('\n');
const RC_ROW0 = 'wmctl click $SID 100 30 3';
const RC_PANE = 'wmctl click $SID 100 300 3';

const script = [
  // -- fixtures --
  'mkdir -p /root/t1 /root/t2',
  'printf hello > /root/t1/a.txt',
  'printf one > /root/t1/p.txt',
  'printf A > /root/t1/dup.txt',
  'printf B > /root/t2/dup.txt',
  'fileman /root/t1 &',
  'sleep 5',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  // ---- Del -> Recycle Bin confirm; No keeps, Yes trashes (a.txt row 0) ----
  sel0,
  DEL,
  'sleep 0.5',
  'echo ==del1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'sleep 0.5',
  'test -f /root/t1/a.txt && echo NO-KEEPS',
  sel0,
  DEL,
  'sleep 0.5',
  'wmctl click Yes',
  'sleep 0.5',
  'test ! -f /root/t1/a.txt && test -f /root/.recycle/files/a.txt && echo TRASHED',
  'echo "==sidecar $(cat /root/.recycle/info/a.txt | head -1)"',
  // ---- Shift+Del: permanent (p.txt sorts after dup.txt: row 1) ----
  sel0,
  'wmctl key $SID 81 1073741905',                // Down -> p.txt
  'wmctl keydown $SID 225 1073742049 1',         // LSHIFT down
  'wmctl key $SID 76 127 1',
  'wmctl keyup $SID 225 1073742049 0',
  'sleep 0.5',
  'echo ==perm1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  'sleep 0.5',
  'test ! -f /root/t1/p.txt && test ! -e /root/.recycle/files/p.txt && echo PERM-GONE',
  // ---- same-basename uniquifier: dup.txt from t1 then t2 ----
  sel0,
  DEL,
  'sleep 0.4',
  'wmctl click Yes',
  'sleep 0.4',
  'wmctl settext EDIT:0 /root/t2',
  'wmctl click Go',
  'sleep 0.5',
  sel0,
  DEL,
  'sleep 0.4',
  'wmctl click Yes',
  'sleep 0.4',
  'grep -q A /root/.recycle/files/dup.txt && grep -q B "/root/.recycle/files/dup.txt 2" && echo UNIQ-OK',
  // ---- the store view: row + pane menus ----
  'wmctl settext EDIT:0 /root/.recycle/files',
  'wmctl click Go',
  'sleep 0.5',
  RC_ROW0,                                       // a.txt (sorts first)
  'sleep 0.5',
  'echo ==trashrow',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',                        // Esc
  'sleep 0.3',
  RC_PANE,
  'sleep 0.5',
  'echo ==trashpane',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'sleep 0.3',
  // ---- restore a.txt: back at the original, sidecar gone ----
  RC_ROW0,
  'sleep 0.5',
  'wmctl click Restore',
  'sleep 0.5',
  'test -f /root/t1/a.txt && test ! -e /root/.recycle/files/a.txt && test ! -e /root/.recycle/info/a.txt && echo RESTORED',
  // ---- restore clash: dup.txt's original re-created -> Replace? ----
  'printf clash > /root/t1/dup.txt',
  RC_ROW0,                                       // dup.txt now row 0
  'sleep 0.5',
  'wmctl click Restore',
  'sleep 0.5',
  'echo ==replace',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'sleep 0.5',
  'test -f /root/.recycle/files/dup.txt && grep -q clash /root/t1/dup.txt && echo REPLACE-NO',
  RC_ROW0,
  'sleep 0.5',
  'wmctl click Restore',
  'sleep 0.5',
  'wmctl click Yes',
  'sleep 0.5',
  'grep -q A /root/t1/dup.txt && echo REPLACE-YES',
  // ---- delete IN the store is permanent ("dup.txt 2" the only row) ----
  sel0,
  DEL,
  'sleep 0.5',
  'echo ==permintrash',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  'sleep 0.5',
  'test ! -e "/root/.recycle/files/dup.txt 2" && test ! -e "/root/.recycle/info/dup.txt 2" && echo TRASH-DEL-PERM',
  // ---- Empty Recycle Bin: fill one, confirm, cleared, grayed after ----
  'printf z > /root/t1/z.txt',
  'wmctl settext EDIT:0 /root/t1',
  'wmctl click Go',
  'sleep 0.5',
  'wmctl click $SID 100 100',
  'wmctl key $SID 74 1073741898',
  'wmctl key $SID 81 1073741905',                // Down (a.txt, dup.txt, z.txt: z row 2)
  'wmctl key $SID 81 1073741905',
  DEL,
  'sleep 0.4',
  'wmctl click Yes',
  'sleep 0.4',
  'wmctl settext EDIT:0 /root/.recycle/files',
  'wmctl click Go',
  'sleep 0.5',
  RC_PANE,
  'sleep 0.5',
  'wmctl click "Empty Recycle Bin"',
  'sleep 0.5',
  'echo ==emptybox',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Yes',
  'sleep 0.5',
  'echo "==left F$(ls /root/.recycle/files | wc -l | tr -d \\" \\")-I$(ls /root/.recycle/info | wc -l | tr -d \\" \\")"',
  RC_PANE,
  'sleep 0.5',
  'echo ==panegray',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'sleep 0.3',
  // ---- EROFS: trash under /bin fails clean, no stray store entry ----
  'wmctl settext EDIT:0 /bin',
  'wmctl click Go',
  'sleep 0.5',
  sel0,
  DEL,
  'sleep 0.5',
  'wmctl click Yes',
  'sleep 0.5',
  'echo ==erofs',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'sleep 0.3',
  'test -e /bin/awk && echo ROFS-INTACT',
  'echo "==stray S$(ls /root/.recycle/files | wc -l | tr -d \\" \\")-END"',
  // ---- the wm.c desktop: glyph empty -> full -> empty ----
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'wmctl shot $DSID /root/e.ppm && echo E-SHOT',
  'printf junk > /root/Desktop/junk.txt',
  'sleep 1.5',                                   // the coarse desk tick
  // junk.txt sorts to row 3 (doom drmario gameboy junk.txt ...); icon menu
  'wmctl click $DSID 58 240 3',
  'sleep 0.5',
  'echo ==iconmenu',
  'wmctl list',
  'echo ==cut',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 60 82',                    // DELETE
  'sleep 1.5',
  'test ! -f /root/Desktop/junk.txt && test -f /root/.recycle/files/junk.txt && echo DESK-TRASH',
  'wmctl shot $DSID /root/f.ppm && echo F-SHOT',
  // ---- the bin's own menu: OPEN / EMPTY RECYCLE BIN (row 7, y 494) ----
  'wmctl click $DSID 58 494 3',
  'sleep 0.5',
  'echo ==binmenu',
  'wmctl list',
  'echo ==cut',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 60 42',                    // EMPTY RECYCLE BIN
  'sleep 1.5',
  'echo "==binleft B$(ls /root/.recycle/files | wc -l | tr -d \\" \\")-END"',
  'wmctl shot $DSID /root/g.ppm && echo G-SHOT',
  // grayed EMPTY: click leaves the menu open
  'wmctl click $DSID 58 494 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 60 42',
  'sleep 0.5',
  'echo ==graystay',
  'wmctl list',
  'echo ==cut',
  'wmctl key $CXSID 41 27',
  'sleep 0.3',
  // ---- the Del KEY on a selected icon ----
  'printf k > /root/Desktop/kdel.txt',
  'sleep 1.5',
  'wmctl click $DSID 58 240',                    // kdel.txt row 3, select
  'sleep 0.7',
  'wmctl key $DSID 76 127',
  'sleep 1.5',
  'test ! -f /root/Desktop/kdel.txt && test -f /root/.recycle/files/kdel.txt && echo KEY-DEL',
  // ---- double-click the bin: fileman opens AT the store ----
  'wmctl dblclick $DSID 58 494',
  'sleep 6',                                     // fileman spawn + freetype
  'echo ==binopen',
  'wmctl list',
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
check('icon menu grew DELETE (120x96)', row(im, 'ctxmenu').includes('120x96+'),
  JSON.stringify(im));
check('icon DELETE trashes the desktop file', out.includes('DESK-TRASH'));
const bm = section('binmenu');
check('the bin icon gets its own OPEN/EMPTY menu (120x56)',
  row(bm, 'ctxmenu').includes('120x56+'), JSON.stringify(bm));
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
  // The bin tile at cell (0,7): origin (46,470), basket rim navy at
  // (58,474), center (58,482) white empty / navy full.
  check('bin glyph starts empty (white center, navy rim)',
    px('e.ppm', 58, 482) === WHITE && px('e.ppm', 58, 474) === NAVY,
    [px('e.ppm', 58, 482), px('e.ppm', 58, 474)].join(' | '));
  check('trashing flips the glyph full (navy center)',
    px('f.ppm', 58, 482) === NAVY, px('f.ppm', 58, 482));
  check('emptying flips it back (white center)',
    px('g.ppm', 58, 482) === WHITE, px('g.ppm', 58, 482));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nrecycle e2e: ${failures} FAILED` : '\nrecycle e2e: PASS');
process.exit(failures ? 1 : 0);
