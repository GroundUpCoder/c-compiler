#!/usr/bin/env node
// 0091 acceptance, headless: right-click context menus — the wm.c popup
// (desktop / icon / taskbar-button menus, "ctxmenu"/"ctxmenu2" borderless
// top-layer windows) and the user32 EDIT WM_CONTEXTMENU menu over the 0068
// TrackPopupMenu primitive (in-surface, agent-addressable). Driven through
// os/boot.js with wmctl right-click injection (`click SID X Y 3`).
// Covers: menu geometry (anchor + work-area clamp), Esc / outside-focus /
// one-popup-at-a-time dismissal, flyout cascade by click and keyboard
// (Down/Right/Left/Enter), New Folder / New Text File uniquifier, Sort by
// Name (.icons forgotten), Refresh, icon-menu Open (activate path),
// taskbar-button Restore/Minimize/Maximize/Close with grayed-row
// semantics, ctlpanel argv (Display Properties), and the EDIT menu's
// state gating (Undo/Cut/Copy/Paste/Select All) + clipboard paste.
//
// Run: node tests/kernel/test_ctxmenu_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ctx-'));
const image = path.join(tmp, 'os.img');

// Geometry mirrors os/wm.c (todos/0091, rows grown by 0092/0093): CTX_W
// 120, rows 20px, 4px pad, 8px separator, clamped to the 1024x768 work
// area above the 28px bar. Desktop menu: NEW / SORT BY / REFRESH / PASTE /
// --- / DISPLAY -> h 116; taskbar menu: RESTORE / MINIMIZE / MAXIMIZE /
// --- / CLOSE -> h 96; icon menu: OPEN / --- / CUT / COPY / DELETE -> h 96. A
// flyout parks at root-right - 3 with its first row aligned to the group
// row (NEW: FOLDER + TEXT FILE -> h 48; SORT BY: NAME -> h 28). Row
// centers at 4 + i*20 + 10.
const rowY = (i) => 4 + i * 20 + 10;               // rows above the groove
const DESK_MENU_GEOM = '120x116+400+300';
const NEW_FLY_GEOM = '120x48+517+300';             // 400+120-3, row 0 align
const SORT_FLY_GEOM = '120x28+517+320';            // row 1 align
const BAR_MENU_GEOM = '120x96+56+644';             // btn 0 x, 768-28-96
const DISPLAY_ROW_Y = 4 + 4 * 20 + 8 + 10;         // below the groove: 102
const CLOSE_ROW_Y = 4 + 3 * 20 + 8 + 10;           // bar menu groove: 82

// The desktop starts as the seeded 7 icons (plus the Recycle Bin, which
// wm.c pins to the grid's TAIL — 0093 — so it never shifts these
// indices); the script grows it. Icons auto-flow column-major sorted
// (no .icons), centers x=58, y = 16 + row*64 + 32 (the 0077 grid).
const deskY = (list, name) => 16 + list.indexOf(name) * 64 + 32;
const DESK0 = ['doom', 'drmario', 'gameboy', 'mario', 'pokemon', 'quake',
               'term'];
// after New Folder + New File.txt + zzz.txt + alauncher (11 entries, one column)
const DESK1 = [...DESK0, 'New Folder', 'New File.txt', 'zzz.txt',
               'alauncher'].sort();

const script = [
  'winbox &',
  'sleep 2.5',
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'TSID=$(wmctl list | grep taskbar$ | sed "s/[^0-9].*//")',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  // ---- desktop menu: open, geometry, shot, Esc ----
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'echo ==ctx1',
  'wmctl list',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl shot $CXSID /root/c1.ppm && echo c1-ok',
  'wmctl key $CXSID 41 27',                      // Esc
  'sleep 0.3',
  'echo ==ctx2',
  'wmctl list',
  // ---- outside focus dismisses ----
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'wmctl focus $WSID',
  'sleep 0.3',
  'echo ==ctx3',
  'wmctl list',
  // ---- New > Folder by mouse (flyout cascade + uniquifier) ----
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(0)}`,            // NEW -> flyout
  'sleep 0.5',
  'echo ==ctx4',
  'wmctl list',
  'C2SID=$(wmctl list | grep ctxmenu2$ | sed "s/[^0-9].*//")',
  `wmctl click $C2SID 60 ${rowY(0)}`,            // FOLDER
  'sleep 0.5',
  'test -d "/root/Desktop/New Folder" && echo new-folder-ok',
  'echo ==ctx5',
  'wmctl list',
  // ---- keyboard: Down/Right/Left/Right/Down/Enter -> New File.txt ----
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $CXSID 81 1073741905',              // Down -> NEW
  'wmctl key $CXSID 79 1073741903',              // Right -> flyout
  'sleep 0.5',
  'echo ==ctx6',
  'wmctl list',
  'wmctl key $CXSID 80 1073741904',              // Left -> flyout closes
  'sleep 0.3',
  'echo ==ctx7',
  'wmctl list',
  'wmctl key $CXSID 79 1073741903',              // Right again
  'sleep 0.3',
  'wmctl key $CXSID 81 1073741905',              // Down -> TEXT FILE
  'wmctl key $CXSID 40 13',                      // Enter
  'sleep 0.5',
  'test -f "/root/Desktop/New File.txt" && echo new-file-ok',
  'echo ==ctx8',
  'wmctl list',
  // ---- Sort by > Name forgets .icons ----
  "printf '2 1 term\\n' > /root/Desktop/.icons",
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(1)}`,            // SORT BY -> flyout
  'sleep 0.5',
  'echo ==ctx9',
  'wmctl list',
  'C2SID=$(wmctl list | grep ctxmenu2$ | sed "s/[^0-9].*//")',
  `wmctl click $C2SID 60 ${rowY(0)}`,            // NAME
  'sleep 0.5',
  'test -e /root/Desktop/.icons || echo icons-gone',
  // ---- Refresh re-scans (icon up without waiting for the coarse tick) ----
  "printf 'x\\n' > /root/Desktop/zzz.txt",
  "printf '#!/bin/sh\\nwinbox\\n' > /root/Desktop/alauncher",
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(2)}`,            // REFRESH
  'sleep 0.3',
  'echo ==ctx10',
  'wmctl list',
  'wmctl shot $DSID /root/d1.ppm && echo d1-ok',
  // ---- one popup at a time: Start menu and ctxmenu displace each other ----
  'wmctl menu',
  'sleep 0.5',
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'echo ==mix1',
  'wmctl list',
  'wmctl menu',                                  // toggles Start -> ctx drops
  'sleep 0.5',
  'echo ==mix2',
  'wmctl list',
  'wmctl key 0 41 27',                           // Esc the Start menu
  'sleep 0.3',
  // ---- icon menu: right-click selects + OPEN runs the activate path ----
  `wmctl click $DSID 58 ${deskY(DESK1, 'alauncher')} 3`,
  'sleep 0.5',
  'echo ==icon1',
  'wmctl list',
  'wmctl shot $DSID /root/d2.ppm && echo d2-ok',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'N1=$(wmctl list | grep -c winbox$)',
  `wmctl click $CXSID 60 ${rowY(0)}`,            // OPEN -> winbox
  'sleep 3',
  'N2=$(wmctl list | grep -c winbox$)',
  'echo OPEN-DELTA-$((N2-N1))',
  'echo ==icon2',
  'wmctl list',
  // ---- Display Properties -> ctlpanel argv (the 0089 applet hub) ----
  'wmctl click $DSID 400 300 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${DISPLAY_ROW_Y}`,      // DISPLAY
  'sleep 5',                                     // ctlpanel loads freetype
  'echo ==disp1',
  'wmctl list',
  // ---- EDIT context menu (user32 WM_CONTEXTMENU over TrackPopupMenu) ----
  'printf CTXPASTE | clip',
  'notepad &',
  'sleep 5',                                     // freetype + .res
  'NSID=$(wmctl list | grep Notepad$ | sed "s/[^0-9].*//")',
  'wmctl click $NSID 200 100 3',                 // right-click the EDIT
  'sleep 0.5',
  'echo ==edit1',
  'wmctl tree',
  'echo ==edit1end',
  'wmctl click Paste',
  'sleep 0.5',
  'echo "==edit2 $(wmctl gettext EDIT:0)"',
  'wmctl click $NSID 200 100 3',                 // reopen: state re-gates
  'sleep 0.5',
  'echo ==edit3',
  'wmctl tree',
  'echo ==edit3end',
  'wmctl key $NSID 41 27',                       // Esc closes it
  'sleep 0.3',
  // ---- taskbar-button menu (button 0 = the original winbox) ----
  'wmctl click $TSID 800 14 3',                  // empty bar: reserved (0101)
  'sleep 0.3',
  'echo ==bar1',
  'wmctl list',
  'wmctl click $TSID 60 14 3',                   // button 0
  'sleep 0.5',
  'echo ==bar2',
  'wmctl list',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(0)}`,            // RESTORE: grayed -> stays
  'sleep 0.3',
  'echo ==bar3',
  'wmctl list',
  `wmctl click $CXSID 60 ${rowY(1)}`,            // MINIMIZE
  'sleep 0.5',
  'echo ==bar4',
  'wmctl list',
  'wmctl click $TSID 60 14 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(0)}`,            // RESTORE (now active)
  'sleep 0.5',
  'echo ==bar5',
  'wmctl list',
  'wmctl click $TSID 60 14 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(2)}`,            // MAXIMIZE
  'sleep 1',                                     // RESIZE round-trip
  'echo ==bar6',
  'wmctl list',
  'wmctl click $TSID 60 14 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${rowY(0)}`,            // RESTORE from maximized
  'sleep 1',
  'echo ==bar7',
  'wmctl list',
  'wmctl click $TSID 60 14 3',
  'sleep 0.5',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 60 ${CLOSE_ROW_Y}`,        // CLOSE -> request-close
  'sleep 1',
  'echo ==bar8',
  'wmctl list',
  '',
].join('\n');

const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
  { input: script, encoding: 'utf8', timeout: 300000 });
if (r.error) throw r.error;

const out = r.stdout;
function section(name) {
  const m = out.split('==' + name + '\n');
  return m.length > 1 ? m[1].split('==')[0] : '';
}
const row = (sec, title) =>
  sec.split('\n').find(l => l.endsWith('\t' + title)) || '';
const geom = (line) => line.split('\t')[2] || '';
const flags = (line) => line.split('\t')[5] || '';
// wmctl list is z-ordered; the taskbar-menu target is button 0 = the FIRST
// winbox = the lowest sid, so pick it explicitly.
const wrow = (sec) => sec.split('\n').filter(l => l.endsWith('\twinbox'))
  .sort((a, b) => parseInt(a) - parseInt(b))[0] || '';

// ---- desktop menu open / dismissal ----
const c1 = section('ctx1');
const cm1 = row(c1, 'ctxmenu');
check(`right-click empty desktop opens the menu (${DESK_MENU_GEOM}, borderless)`,
  cm1.includes(DESK_MENU_GEOM) && flags(cm1).includes('b'), JSON.stringify(c1));
check('the menu rides the TOP layer like the bar', flags(cm1).includes('T'), cm1);
check('menu shot written', out.includes('c1-ok'));
check('Esc dismisses it', row(section('ctx2'), 'ctxmenu') === '',
  JSON.stringify(section('ctx2')));
check('focus leaving dismisses it (outside-click rule)',
  row(section('ctx3'), 'ctxmenu') === '', JSON.stringify(section('ctx3')));

// ---- New > flyout by mouse ----
const c4 = section('ctx4');
check(`clicking NEW cascades the flyout (${NEW_FLY_GEOM})`,
  row(c4, 'ctxmenu2').includes(NEW_FLY_GEOM) && row(c4, 'ctxmenu') !== '',
  JSON.stringify(c4));
check('flyout FOLDER click creates /root/Desktop/New Folder',
  out.includes('new-folder-ok'));
check('selection dismissed the whole popup',
  row(section('ctx5'), 'ctxmenu') === '' && row(section('ctx5'), 'ctxmenu2') === '',
  JSON.stringify(section('ctx5')));

// ---- keyboard nav ----
check('keyboard Down+Right cascades the NEW flyout',
  row(section('ctx6'), 'ctxmenu2').includes(NEW_FLY_GEOM),
  JSON.stringify(section('ctx6')));
check('Left backs out of the flyout (root stays)',
  row(section('ctx7'), 'ctxmenu2') === '' && row(section('ctx7'), 'ctxmenu') !== '',
  JSON.stringify(section('ctx7')));
check('keyboard Enter on TEXT FILE creates New File.txt and dismisses',
  out.includes('new-file-ok') && row(section('ctx8'), 'ctxmenu') === '',
  JSON.stringify(section('ctx8')));

// ---- Sort by > Name ----
check(`SORT BY cascades its flyout (${SORT_FLY_GEOM})`,
  row(section('ctx9'), 'ctxmenu2').includes(SORT_FLY_GEOM),
  JSON.stringify(section('ctx9')));
check('Sort by Name forgets the .icons placements', out.includes('icons-gone'));

// ---- Refresh ----
check('REFRESH selection dismisses the menu',
  row(section('ctx10'), 'ctxmenu') === '', JSON.stringify(section('ctx10')));
check('desktop shot after refresh written', out.includes('d1-ok'));

// ---- one popup at a time ----
const x1 = section('mix1');
check('right-click while the Start menu is open: ctxmenu up, startmenu gone',
  row(x1, 'ctxmenu') !== '' && row(x1, 'startmenu') === '', JSON.stringify(x1));
const x2 = section('mix2');
check('Start toggle while the ctxmenu is open: startmenu up, ctxmenu gone',
  row(x2, 'startmenu') !== '' && row(x2, 'ctxmenu') === '', JSON.stringify(x2));

// ---- icon menu ----
const i1 = section('icon1');
check('right-click an icon opens the Open/Cut/Copy/Delete menu (120x96, 0093)',
  row(i1, 'ctxmenu').includes('120x96+'), JSON.stringify(i1));
check('icon shot written', out.includes('d2-ok'));
check('OPEN runs the launcher through the activate path (winbox +1)',
  out.includes('OPEN-DELTA-1'),
  out.slice(out.indexOf('OPEN-DELTA')).slice(0, 20));

// ---- Display Properties ----
const dp = section('disp1');
check('DISPLAY spawns ctlpanel with the Display applet open (argv path)',
  row(dp, 'Control Panel') !== '' && row(dp, 'Display Properties') !== '',
  JSON.stringify(dp));

// ---- EDIT context menu (user32) ----
const e1full = out.split('==edit1\n')[1] ? out.split('==edit1\n')[1].split('==edit1end')[0] : '';
check('EDIT right-click raises the popup in the agent tree',
  e1full.includes('popupmenu'), e1full.slice(0, 400));
// Scope item lookups to the popupmenu section — notepad's menu BAR also
// has Undo/Cut/Copy rows in the same dump.
const popOf = (dump) => dump.split('popupmenu\n')[1] || '';
const e1 = popOf(e1full);
const item = (dump, label) =>
  dump.split('\n').find(l => l.includes(`text='${label}'`)) || '';
check('Undo is grayed (no undo buffer, the recorded 0048 scope)',
  item(e1, 'Undo').includes('grayed'), item(e1, 'Undo'));
check('Cut/Copy grayed with no selection',
  item(e1, 'Cut').includes('grayed') && item(e1, 'Copy').includes('grayed'),
  [item(e1, 'Cut'), item(e1, 'Copy')].join(' | '));
check('Select All grayed on an empty field',
  item(e1, 'Select All').includes('grayed'), item(e1, 'Select All'));
check('Paste is enabled (clipboard holds text)',
  item(e1, 'Paste') !== '' && !item(e1, 'Paste').includes('grayed'),
  item(e1, 'Paste'));
check('agent click "Paste" pastes the 0090 clipboard slot',
  out.includes('==edit2 CTXPASTE'),
  out.slice(out.indexOf('==edit2')).slice(0, 40));
const e3 = popOf(out.split('==edit3\n')[1] ? out.split('==edit3\n')[1].split('==edit3end')[0] : '');
check('reopened menu re-gates: Select All now enabled (field has text)',
  item(e3, 'Select All') !== '' && !item(e3, 'Select All').includes('grayed'),
  item(e3, 'Select All'));

// ---- taskbar-button menu ----
check('right-click the empty bar raises nothing (reserved for 0101)',
  row(section('bar1'), 'ctxmenu') === '', JSON.stringify(section('bar1')));
const b2 = section('bar2');
check(`right-click button 0 opens the window menu (${BAR_MENU_GEOM}, above the bar)`,
  row(b2, 'ctxmenu').includes(BAR_MENU_GEOM), JSON.stringify(b2));
const b3 = section('bar3');
check('grayed RESTORE click: menu stays open, window untouched',
  row(b3, 'ctxmenu') !== '' && !flags(wrow(b3)).includes('m'),
  JSON.stringify(b3));
const b4 = section('bar4');
check('MINIMIZE minimizes and dismisses',
  flags(wrow(b4)).includes('m') && row(b4, 'ctxmenu') === '',
  JSON.stringify(b4));
const b5 = section('bar5');
check('RESTORE restores + focuses (the 0014 rule)',
  flags(wrow(b5))[0] === 'f' && !flags(wrow(b5)).includes('m'),
  JSON.stringify(b5));
check('MAXIMIZE fills the work area', geom(wrow(section('bar6'))) === '1024x712+0+28',
  wrow(section('bar6')));
check('RESTORE from maximized returns the saved geometry',
  geom(wrow(section('bar7'))) === '240x160+12+36',
  wrow(section('bar7')));
const b8 = section('bar8');
check('CLOSE request-closes the window (button 0 winbox gone)',
  b8.split('\n').filter(l => l.endsWith('\twinbox')).length === 1,
  JSON.stringify(b8));

// ---- pixels: the menu face and the icon selection strip ----
{
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  const readPpm = (name, w) => {
    const ppm = COMMON.readFileBytes(ufs, '/root/' + name);
    const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1');
    const off = head.indexOf('255\n') + 4;
    return (x, y) => String(Array.from(
      ppm.subarray(off + (y * w + x) * 3, off + (y * w + x) * 3 + 3)));
  };
  // c1.ppm: the 120x116 desktop menu — raised edge, face, black item text,
  // the separator groove at y 84..92, the flyout arrows on the sub rows.
  const p = readPpm('c1.ppm', 120);
  check('menu face is the Win95 gray with a raised edge',
    p(60, 2) === '192,192,192' && p(0, 0) === '255,255,255' &&
    p(119, 50) === '96,96,96', [p(60, 2), p(0, 0), p(119, 50)].join(' | '));
  let text = 0;
  for (let y = 4; y < 24; y++)
    for (let x = 10; x < 100; x++) if (p(x, y) === '0,0,0') text++;
  check('row 0 (NEW) has black label text', text >= 10, text);
  check('separator groove present (dark over light)',
    p(60, 87) === '96,96,96' && p(60, 88) === '255,255,255',
    [p(60, 87), p(60, 88)].join(' | '));
  check('sub rows carry the flyout arrow', p(110, 13) === '0,0,0', p(110, 13));
  // d2.ppm: right-click selected the alauncher icon alone (navy strip).
  const d = readPpm('d2.ppm', 1024);
  const strip = (name, r) => {
    const len = Math.min(13, name.length);
    const lx = 16 + Math.floor((84 - len * 6) / 2);
    return d(lx - 1, 16 + r * 64 + 34 + 3);
  };
  check('right-click selected the icon alone (alauncher navy, doom teal)',
    strip('alauncher', DESK1.indexOf('alauncher')) === '0,0,128' &&
    strip('doom', DESK1.indexOf('doom')) === '0,128,128',
    [strip('alauncher', DESK1.indexOf('alauncher')),
     strip('doom', DESK1.indexOf('doom'))].join(' | '));
  // d1.ppm: zzz.txt's icon tile is up right after REFRESH (white tile
  // histogram in its cell; the coarse tick alone would allow ~1s).
  const d1 = readPpm('d1.ppm', 1024);
  let white = 0;
  const zr = DESK1.indexOf('zzz.txt');
  for (let y = 16 + zr * 64; y < 16 + zr * 64 + 48; y++)
    for (let x = 16; x < 100; x++) if (d1(x, y) === '255,255,255') white++;
  check('zzz.txt icon tile present right after REFRESH', white > 250, white);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nctxmenu e2e: ${failures} FAILED` : '\nctxmenu e2e: PASS');
process.exit(failures ? 1 : 0);
