#!/usr/bin/env node
// 0014 acceptance, headless: the REAL /bin/wm + /bin/wmctl (compiled from
// os/wm.c / os/wmctl.c at seed time), driven through os/boot.js the way an
// agent would drive it. Covers: wm autostart (kernel service), taskbar as a
// borderless surface parked at the bottom edge, the wm's placement policy
// (not the kernel cascade), wmctl list/min/click/shot/focus, taskbar-click
// restore (injected through the real input ring into the wm's SDL loop),
// wmctl max maximize/restore on both branches of the resizable dispatch
// (todos/0025), the crashed-WM story — kill the wm, the system stays
// driveable (kernel-chrome fallback + kernel-owned endpoint), `wm &`
// respawns it — and the unified activate mechanism (todos/0066): desktop
// and Start menu share one launch rule (symlink/runnable spawn, else vi).
//
// Run: node tests/kernel/test_wm_service_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-wm-'));
const image = path.join(tmp, 'os.img');

// The baked /usr/share/menu TREE (os/image.json, todos/0078): the root
// column lists the GROUP directories (dirs-first sort) plus the fixed
// section (SETTINGS, RUN...) below a separator groove; groups cascade
// flyout columns. Geometry mirrors os/wm.c: 150px list + the 18px sidebar
// band on the root (168 total), rows 20px, 4px pad, 8px separator, parked
// above the 28px taskbar on the 1024x768 headless screen; a flyout parks
// at parent-right - 3 with its first row aligned to the group row,
// bottom-clamped to the work area. Bump the lists when image.json's menu
// tree changes; everything below derives from them.
const MENU_GROUPS = ['Accessories', 'Demos', 'Games'];
const MENU_FIXED = 2;                            // SETTINGS, RUN...
const MENU_H = 2 * 4 + (MENU_GROUPS.length + MENU_FIXED) * 20 + 8;
const MENU_Y = 768 - 28 - MENU_H;
const MENU_GEOM = `168x${MENU_H}+0+${MENU_Y}`;
const rootRowY = (name) => 4 + MENU_GROUPS.indexOf(name) * 20 + 10;
const SETTINGS_ROW_Y = 4 + MENU_GROUPS.length * 20 + 8 + 10;
const RUN_ROW_Y = SETTINGS_ROW_Y + 20;
const flyGeom = (list, group) => {
  const h = 2 * 4 + list.length * 20;
  const y = Math.min(MENU_Y + 4 + MENU_GROUPS.indexOf(group) * 20 - 4,
                     768 - 28 - h);
  return `150x${h}+165+${y}`;
};
const DEMOS = ['cairodemo', 'ctldemo', 'gdidemo', 'gpubox', 'winbox'];
const GAMES = ['doom', 'gameboy', 'quake', 'sameboy', 'snake', 'winmine'];
const winboxFlyY = 4 + DEMOS.indexOf('winbox') * 20 + 10;

// The seeded /root/Desktop icons, sorted (os/image.json user section) —
// same rule: bump when the image gains one. wm.c grid: column-major,
// 16px margin, 84x64 cells, 11 rows on the 1024x768 screen; icon centers
// in column 0 sit at x=58, y = 16 + row*64 + 32.
const DESK_ENTRIES = ['doom', 'drmario', 'gameboy', 'mario', 'pokemon',
                      'quake', 'term'];
const deskY = (list, name) => 16 + list.indexOf(name) * 64 + 32;
// the activate leg drops two more files in and re-sorts
const DESK_ACT = [...DESK_ENTRIES, 'alauncher', 'notes.txt'].sort();

// One seeded session. Sids/pids are extracted IN-shell (sed) so the test
// doesn't depend on the wm-autostart vs first-command spawn race.
const script = [
  'winbox &',
  'sleep 2.5',                                   // wasm instantiation is real time
  'echo ==list1',
  'wmctl list',
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'TSID=$(wmctl list | grep taskbar$ | sed "s/[^0-9].*//")',
  'WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")',
  'wmctl min $WSID',
  'sleep 0.3',
  'echo ==list2',
  'wmctl list',
  'wmctl click $TSID 60 14',                     // taskbar button 0 -> restore
  'sleep 0.5',
  'echo ==list3',
  'wmctl list',
  'wmctl shot screen /root/s.ppm && head -c 2 /root/s.ppm && echo',
  'wmctl focus 999 || echo bad-sid-fails',
  'winbox fixed &',                              // viewport scaling (todos/0024)
  'sleep 2.5',
  'FSID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")',
  'wmctl scale $FSID 480 320 && echo scale-ok',
  'wmctl resize $FSID 300 200 || echo resize-refused',
  'wmctl scale $WSID 300 200 || echo scale-refused',
  'echo ==list6',
  'wmctl list',
  'wmctl max $WSID && echo max-ok',              // maximize/restore (todos/0025)
  'sleep 1',                                     // RESIZE round-trips the client ack
  'echo ==list7',
  'wmctl list',
  'wmctl max $WSID',                             // toggle back
  'sleep 1',
  'echo ==list8',
  'wmctl list',
  'wmctl max $FSID',                             // fixed-size: scale-to-fit branch
  'sleep 0.5',
  'echo ==list9',
  'wmctl list',
  'wmctl max $FSID',                             // restore the pre-max dst
  'sleep 0.5',
  'echo ==list10',
  'wmctl list',
  'kill $WMPID',                                 // crash the WM
  'sleep 0.5',
  'wmctl max $WSID || echo max-refused',         // maximize IS policy: no WM, no max
  'wmctl menu || echo menu-refused',             // likewise the menu (0078)
  'echo ==list4',
  'wmctl list',                                  // endpoint is the KERNEL's: still up
  'wm &',                                        // respawn
  'sleep 2.5',
  'echo ==list5',
  'wmctl list',
  'TSID=$(wmctl list | grep taskbar$ | sed "s/[^0-9].*//")',   // new wm, new sid
  // ---- the Start menu (todos/0028, Win95-classic v2 todos/0078) ----
  'wmctl click $TSID 25 14',                     // Start button (x < 50)
  'sleep 0.5',
  'echo ==menu1',
  'wmctl list',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl shot $MSID /root/m.ppm && echo menu-shot-ok',
  `wmctl hover $MSID 60 ${rootRowY('Demos')}`,   // group hover -> flyout
  'sleep 0.5',
  'echo ==menu1b',
  'wmctl list',
  'M2SID=$(wmctl list | grep startmenu2$ | sed "s/[^0-9].*//")',
  `wmctl click $M2SID 60 ${winboxFlyY}`,         // winbox, nested (sorted)
  'sleep 2.5',                                   // real wasm spawn
  'echo ==menu2',
  'wmctl list',
  'wmctl click $TSID 25 14',                     // re-open
  'sleep 0.5',
  'echo ==menu3',
  'wmctl list',
  'wmctl focus $WSID',                           // focus change dismisses
  'sleep 0.5',
  'echo ==menu4',
  'wmctl list',
  // ---- the desktop layer (todos/0029) ----
  'echo ==desk1',
  'wmctl list',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'wmctl shot $DSID /root/d.ppm && echo desk-shot-ok',
  `wmctl click $DSID 58 ${deskY(DESK_ENTRIES, 'gameboy')}`,   // SINGLE click the gameboy icon
  'sleep 2.5',                                   // would-be spawn time
  'echo ==desk2',
  'wmctl list',
  `wmctl dblclick $DSID 58 ${deskY(DESK_ENTRIES, 'term')}`,   // double-click the term icon
  'sleep 4',                                     // term loads freetype
  'echo ==desk3',
  'wmctl list',
  // ---- taskbar polish (todos/0031) ----
  // Stable button order: 4 fresh winboxes; closing the SECOND must slide
  // the later buttons left (compaction), not swap the last into its slot.
  'winbox & winbox & winbox & winbox &',
  'sleep 6',
  'echo ==bar1',
  'wmctl list',
  'W2=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//" | sort -n | tail -4 | head -2 | tail -1)',
  'wmctl close $W2',
  'sleep 0.5',
  // Buttons: [4 pre-existing][W1][W3][W4] now; button 5 (x center 650)
  // must focus W3 (compaction) — swap-remove would put W4 there.
  'wmctl click $TSID 650 14',
  'sleep 0.3',
  'echo ==bar2',
  'wmctl list',
  // Overflow: two more windows -> 9 buttons only fit shrunk left of the
  // clock; a click in the clock cell must fall on NO button (pre-0031 it
  // lands on button 8 and toggles it).
  'winbox & winbox &',
  'sleep 5',
  'wmctl click $TSID 1000 14',
  'sleep 0.3',
  'echo ==bar3',
  'wmctl list',
  'wmctl shot $TSID /root/bar.ppm && echo bar-shot-ok',
  // ---- window cycling (todos/0032): wmctl cycle -> WMP CYCLE -> the same
  // EV_CYCLE -> wm.c policy. Focus fixbox then winbox so the recency
  // ladder's top three are known: [.., W6(create), fixbox, winbox]. ----
  'wmctl focus $FSID',
  'wmctl focus $WSID',
  'sleep 0.3',
  'echo ==cyc1',
  'wmctl list',
  'wmctl cycle -1',                              // previous window
  'sleep 0.3',
  'echo ==cyc2',
  'wmctl list',
  'wmctl cycle -1',                              // ...and back (the toggle)
  'sleep 0.3',
  'echo ==cyc3',
  'wmctl list',
  'wmctl min $FSID',                             // minimize the 2nd-recent
  'sleep 0.3',
  'wmctl cycle -1',                              // must skip it
  'sleep 0.3',
  'echo ==cyc4',
  'wmctl list',
  'wmctl cycle',                                 // forward: the LRU window
  'sleep 0.3',
  'echo ==cyc5',
  'wmctl list',
  // ---- z layers (todos/0038): the real wm.c pins its furniture — the
  // taskbar rides the TOP layer, the desktop the BOTTOM one; a raise (or
  // any later create) must stop below the bar. ----
  'wmctl raise $WSID',
  'sleep 0.3',
  'echo ==layer1',
  'wmctl list',
  // ---- the focus fall skips pinned furniture (todos/0039): SIGKILL the
  // focused winbox; with the real wm.c bar pinned +1 at the top of z, the
  // fall must land on another NORMAL window, never the furniture. ----
  'wmctl focus $WSID',
  'sleep 0.3',
  'FPID=$(wmctl list | cut -f2,6 | grep "\tf" | cut -f1)',
  'kill -9 $FPID',
  'sleep 1',
  'echo ==fall1',
  'wmctl list',
  // ---- unified activate (todos/0066): the desktop and the Start menu
  // share ONE launch mechanism — a #!/bin/sh launcher script spawns
  // (shebang exec, todos/0065), a plain text file opens through the
  // openwith associations (todos/0072 — default.gui is notepad in the
  // baked store), symlinks keep running their target (the desk3 leg
  // above). ----
  "printf '#!/bin/sh\\nwinbox\\n' > /root/Desktop/alauncher",
  "printf 'plain notes, not a program\\n' > /root/Desktop/notes.txt",
  'sleep 2.5',                                   // desk_load re-read tick (~1s)
  'echo ==act1',
  'wmctl list',
  `wmctl dblclick $DSID 58 ${deskY(DESK_ACT, 'alauncher')}`,  // the alauncher icon (sorted)
  'sleep 3',                                     // sh -> winbox spawn
  'echo ==act2',
  'wmctl list',
  `wmctl dblclick $DSID 58 ${deskY(DESK_ACT, 'notes.txt')}`,  // the notes.txt icon
  'sleep 5',                                     // notepad loads freetype + .res
  'echo ==act3',
  'wmctl list',
  // The seeded snake entry became a real launcher script (image v36; in
  // the Games group since todos/0078).
  'head -c 2 /usr/share/menu/Games/snake && echo =snake-shebang',
  // The menu takes the same path: an /etc/menu override dir with ONE
  // launcher-script entry (the dir existing wins, todos/0040). x=60
  // clears the 18px sidebar band (todos/0078).
  'mkdir /etc/menu',
  "printf '#!/bin/sh\\nwinbox\\n' > /etc/menu/go",
  'wmctl click $TSID 25 14',                     // Start
  'sleep 0.5',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $MSID 60 14',                     // entry 0 (the only one)
  'sleep 3',
  'echo ==act4',
  'wmctl list',
  'rm -rf /etc/menu',
  // ---- Aero effects (todos/0063) ----
  // Aero Peek: injected motion over taskbar button 0 raises the "peek"
  // thumbnail popup; motion over the Start strip drops it.
  'wmctl hover $TSID 60 14',
  'sleep 1',                                     // THUMB round trip + park
  'echo ==aero1',
  'wmctl list',
  'PSID=$(wmctl list | grep peek$ | sed "s/[^0-9].*//")',
  'wmctl shot $PSID /root/p.ppm && echo peek-shot-ok',
  'wmctl hover $TSID 25 14',
  'sleep 0.5',
  'echo ==aero2',
  'wmctl list',
  // wmctl thumb: fixbox (240x160 orange, white 4px border) into 60x40 —
  // dst(0,0) averages the pure-white border block, the center pure orange.
  'wmctl thumb $FSID 60 40 /root/t.ppm',
  'head -c 13 /root/t.ppm && echo =thumb-hdr',   // "P6\\n60 40\\n255\\n"
  'tail -c +14 /root/t.ppm | head -c 3 > /root/tpx.bin',
  "printf '\\377\\377\\377' > /root/texp.bin",
  'cmp /root/tpx.bin /root/texp.bin && echo thumb-border-white',
  `tail -c +${14 + ((20 * 60) + 30) * 3} /root/t.ppm | head -c 3 > /root/tpx2.bin`,
  "printf '\\377\\214\\000' > /root/texp2.bin",  // orange 255,140,0
  'cmp /root/tpx2.bin /root/texp2.bin && echo thumb-center-orange',
  // Per-pixel alpha end to end: SDL_WINDOW_TRANSPARENT -> kernel bit3 ->
  // the deterministic src-over composite. A CHROMED window's client blends
  // over its own frame fill (the face gray drawn under title+client — same
  // painter's order in both compositors; true see-through needs borderless,
  // unit-tested in test_wm_aero.js): 50%-alpha blue over gray 192 is
  // exactly (96, 96, 224).
  'winbox alpha &',
  'sleep 2.5',
  'ASID=$(wmctl list | grep alphabox$ | sed "s/[^0-9].*//")',
  'echo ==aero3',
  'wmctl list',
  'BSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//" | head -1)',
  'wmctl restore $BSID',
  'wmctl move $BSID 500 300',
  'wmctl move $ASID 480 280',
  'wmctl raise $ASID',
  'sleep 0.3',
  'wmctl shot screen /root/a.ppm',
  // (560,360): inside alphabox AND the winbox interior. PPM header is 16
  // bytes on the 1024x768 screen; tail -c is 1-based.
  `tail -c +${17 + ((360 * 1024) + 560) * 3} /root/a.ppm | head -c 3 > /root/apx.bin`,
  "printf '\\140\\140\\340' > /root/aexp.bin",   // 96, 96, 224
  'cmp /root/apx.bin /root/aexp.bin && echo alpha-blend-ok',
  // Glass is browser-only: toggling it must not change the headless
  // composite at that pixel (nor anything else — unit-tested bit-exactly).
  'wmctl glass 1 && echo glass-on-ok',
  'wmctl shot screen /root/g.ppm',
  `tail -c +${17 + ((360 * 1024) + 560) * 3} /root/g.ppm | head -c 3 > /root/gpx.bin`,
  'cmp /root/gpx.bin /root/aexp.bin && echo glass-headless-invariant',
  'wmctl glass 0 && echo glass-off-ok',
  // ---- Start menu v2 tail (todos/0078): command path, keyboard nav,
  // type-ahead, Esc, the RUN... builtin. Deltas only — window counts at
  // this point are whatever the storms above left behind. ----
  'echo ==sm1',
  'wmctl list',
  'wmctl menu && echo menu-cmd-ok',              // wmctl menu = the chord
  'sleep 0.5',
  'echo ==sm2',
  'wmctl list',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $MSID 10 103',                      // type-ahead: g -> Games
  'wmctl key $MSID 79 1073741903',               // Right -> Games flyout
  'sleep 0.5',
  'echo ==sm3',
  'wmctl list',
  'wmctl key $MSID 41 27',                       // Esc dismisses everything
  'sleep 0.3',
  'echo ==sm4',
  'wmctl list',
  // RUN...: open Start, click the fixed row, type "winbox", Enter.
  'wmctl click $TSID 25 14',
  'sleep 0.5',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $MSID 60 ${RUN_ROW_Y}`,
  'sleep 0.5',
  'echo ==sm5',
  'wmctl list',
  'RSID=$(wmctl list | grep startrun$ | sed "s/[^0-9].*//")',
  'wmctl key $RSID 26 119',                      // w
  'wmctl key $RSID 12 105',                      // i
  'wmctl key $RSID 17 110',                      // n
  'wmctl key $RSID 5 98',                        // b
  'wmctl key $RSID 18 111',                      // o
  'wmctl key $RSID 27 120',                      // x
  'wmctl key $RSID 40 13',                       // Enter -> sh -c winbox
  'sleep 3',
  'echo ==sm6',
  'wmctl list',
  // Keyboard-only nested launch over an /etc/menu override tree: Down
  // walks to the group, Right cascades, Enter runs the launcher.
  'mkdir -p /etc/menu/Apps',
  "printf '#!/bin/sh\\nwinbox\\n' > /etc/menu/Apps/go",
  'wmctl menu',
  'sleep 0.5',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $MSID 81 1073741905',               // Down -> the Apps group
  'wmctl key $MSID 79 1073741903',               // Right -> its flyout
  'sleep 0.5',
  'echo ==sm7',
  'wmctl list',
  'wmctl key $MSID 40 13',                       // Enter -> go -> winbox
  'sleep 3',
  'echo ==sm8',
  'wmctl list',
  'rm -rf /etc/menu',
  // ---- desktop icon selection & manipulation (todos/0077) ----
  // /root/Desktop is DESK_ACT here (9 entries, column 0 rows 0-8). Click
  // coordinates ride deskY; label-strip pixels are asserted from surface
  // shots after the run. The first click also focuses the desktop (wm.c
  // policy), so the later keyboard legs land on the grid.
  `wmctl click $DSID 58 ${deskY(DESK_ACT, 'gameboy')}`,       // plain select
  'sleep 0.5',
  'wmctl shot $DSID /root/s1.ppm && echo s1-ok',
  // ctrl+click doom: additive toggle (keydown/keyup hold the modifier
  // across the separate click injection — todos/0077 wmctl growth)
  'wmctl keydown $DSID 224 1073742048 64',                    // LCTRL down
  `wmctl click $DSID 58 ${deskY(DESK_ACT, 'doom')}`,
  'wmctl keyup $DSID 224 1073742048 0',
  'sleep 0.5',
  'wmctl shot $DSID /root/s2.ppm && echo s2-ok',
  // shift+click mario: range from the anchor (doom, entry order 1..4)
  'wmctl keydown $DSID 225 1073742049 1',                     // LSHIFT down
  `wmctl click $DSID 58 ${deskY(DESK_ACT, 'mario')}`,
  'wmctl keyup $DSID 225 1073742049 0',
  'sleep 0.5',
  'wmctl shot $DSID /root/s2b.ppm && echo s2b-ok',
  // marquee from empty desktop over the tiles of rows 0-2: REPLACES the set
  'wmctl drag $DSID 150 10 40 200',
  'sleep 0.5',
  'wmctl shot $DSID /root/s3.ppm && echo s3-ok',
  // drag-move: press term (0,8) and drop 2 cols right, 7 rows up -> (2,1);
  // the plain press on the unselected icon first collapses the set to it
  `wmctl drag $DSID 58 ${deskY(DESK_ACT, 'term')} 226 112`,
  'sleep 2.5',                                   // survive the re-read tick
  'echo ==sel1',
  'cat /root/Desktop/.icons',
  'echo ==sel2',
  'wmctl shot $DSID /root/s4.ppm && echo s4-ok',
  'N1=$(wmctl list | grep -c winbox$)',
  // Ctrl+A selects all; Enter on a multi-selection is the multi-launch
  // guard no-op (never silently spawn N windows)
  'wmctl keydown $DSID 224 1073742048 64',
  'wmctl key $DSID 4 97 64',                     // a
  'wmctl keyup $DSID 224 1073742048 0',
  'sleep 0.5',
  'wmctl shot $DSID /root/s5.ppm && echo s5-ok',
  'wmctl key $DSID 40 13',                       // Enter: multi -> no-op
  'sleep 2',
  'N2=$(wmctl list | grep -c winbox$)',
  'echo NOOP-DELTA-$((N2-N1))',
  'wmctl key $DSID 41 27',                       // Esc clears
  'sleep 0.5',
  'wmctl shot $DSID /root/s6.ppm && echo s6-ok',
  // arrows: Right with nothing selected takes the top-left icon
  // (alauncher); Enter on the single selection launches it (-> winbox)
  'wmctl key $DSID 79 1073741903',               // Right
  'sleep 0.3',
  'wmctl key $DSID 40 13',                       // Enter
  'sleep 3',
  'N3=$(wmctl list | grep -c winbox$)',
  'echo LAUNCH-DELTA-$((N3-N2))',
  'echo ==sel3',
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
const l1 = section('list1'), l2 = section('list2'), l3 = section('list3'),
      l4 = section('list4'), l5 = section('list5'), l6 = section('list6'),
      l7 = section('list7'), l8 = section('list8'), l9 = section('list9'),
      l10 = section('list10'),
      m1 = section('menu1'), m1b = section('menu1b'),
      m2 = section('menu2'), m3 = section('menu3'),
      m4 = section('menu4'),
      d1 = section('desk1'), d2 = section('desk2'), d3 = section('desk3'),
      b1 = section('bar1'), b2 = section('bar2'), b3 = section('bar3'),
      c1s = section('cyc1'), c2s = section('cyc2'), c3s = section('cyc3'),
      c4s = section('cyc4'), c5s = section('cyc5'),
      lay1 = section('layer1'),
      a1 = section('act1'), a2 = section('act2'), a3 = section('act3'),
      a4 = section('act4');
const row = (sec, title) =>
  sec.split('\n').find(l => l.endsWith('\t' + title)) || '';
const geom = (line) => line.split('\t')[2] || '';   // the GEOMETRY column
const dst = (line) => line.split('\t')[3] || '';    // the DST column

// ---- autostart + placement ----
const bar1 = row(l1, 'taskbar'), win1 = row(l1, 'winbox');
check('wm autostarted: taskbar surface exists', bar1 !== '', JSON.stringify(l1));
check('taskbar is borderless, parked at the bottom edge (0,740 @1024x768)',
  bar1.includes('1024x28+0+740') && bar1.includes('b'), bar1);
check('winbox placed by the WM policy (12,36 — not the kernel cascade)',
  win1.includes('240x160+12+36'), win1);
check('winbox focused + resizable (R flag, todos/0021)',
  win1.includes('\tf---R-\t'), win1);   // FLAGS grew the 0063 'A' slot

// ---- minimize via wmctl -> EV to the wm ----
const win2 = row(l2, 'winbox');
check('wmctl min: winbox minimized', win2.includes('-m--'), win2);

// ---- taskbar click (real input ring -> wm SDL loop) restores ----
const win3 = row(l3, 'winbox');
check('taskbar click restores + focuses winbox', win3.includes('f---'), win3);

// ---- shot + errors ----
check('wmctl shot screen writes a PPM', out.includes('P6'), out.slice(0, 400));
check('wmctl focus on a bogus sid fails', out.includes('bad-sid-fails'));

// ---- viewport scaling (todos/0024): wmctl scale on the real binaries ----
check('wmctl scale on a fixed-size window succeeds', out.includes('scale-ok'));
check('wmctl resize on a fixed-size window is refused', out.includes('resize-refused'));
check('wmctl scale on a RESIZABLE window is refused', out.includes('scale-refused'));
const fix6 = row(l6, 'fixbox');
check('fixbox scaled: buffer geometry intact, DST column shows 480x320',
  fix6.includes('240x160+') && fix6.includes('\t480x320\t'), fix6);
check('fixbox is not resizable (no R flag)', fix6 !== '' && !fix6.includes('R'), fix6);
const win6 = row(l6, 'winbox');
check('winbox unscaled: DST column is -', win6.includes('\t-\t'), win6);

// ---- maximize/restore (todos/0025): wmctl max -> EV_TITLE_ACTIVATE ->
// wm.c policy, dispatching on the RESIZABLE bit ----
check('wmctl max on the resizable winbox succeeds', out.includes('max-ok'));
check('maximized winbox fills the work area (1024x712+0+28: screen minus taskbar, below the title bar)',
  geom(row(l7, 'winbox')) === '1024x712+0+28', row(l7, 'winbox'));
check('second max restores the exact saved geometry',
  geom(row(l8, 'winbox')) === geom(win1) && geom(win1) === '240x160+12+36',
  row(l8, 'winbox'));
check('max on the fixed-size fixbox: aspect-fit scale-to-fit (960x640, integer-snapped 4x), centered',
  dst(row(l9, 'fixbox')) === '960x640' && geom(row(l9, 'fixbox')) === '240x160+32+64',
  row(l9, 'fixbox'));
check('fixbox buffer untouched by max (still 240x160)',
  geom(row(l9, 'fixbox')).startsWith('240x160'), row(l9, 'fixbox'));
check('second max restores the pre-max dst and position',
  dst(row(l10, 'fixbox')) === dst(row(l6, 'fixbox')) &&
  geom(row(l10, 'fixbox')) === geom(row(l6, 'fixbox')), row(l10, 'fixbox'));

// ---- crashed-WM story ----
check('WM killed: taskbar gone, endpoint still serves wmctl',
  row(l4, 'taskbar') === '' && row(l4, 'winbox') !== '', JSON.stringify(l4));
check('wmctl max with no WM is refused (maximize IS policy)',
  out.includes('max-refused'));
const bar5 = row(l5, 'taskbar');
check('wm & respawns: taskbar back at the bottom edge',
  bar5.includes('1024x28+0+740'), JSON.stringify(l5));

// ---- the Start menu (todos/0028; Win95-classic v2 todos/0078) ----
const menu1 = row(m1, 'startmenu');
check(`Start click opens the menu: borderless root column above the taskbar (${MENU_GEOM} — ${MENU_GROUPS.length} groups + ${MENU_FIXED} fixed rows)`,
  menu1.includes(MENU_GEOM) && menu1.includes('b'), JSON.stringify(m1));
check('menu shot written', out.includes('menu-shot-ok'));
const fly1 = row(m1b, 'startmenu2');
check(`hovering the Demos group cascades its flyout column (${flyGeom(DEMOS, 'Demos')})`,
  fly1.includes(flyGeom(DEMOS, 'Demos')) && fly1.includes('b'), JSON.stringify(m1b));
check('nested flyout click launches winbox (second instance)',
  m2.split('\n').filter(l => l.endsWith('\twinbox')).length === 2, JSON.stringify(m2));
check('selection dismissed the whole cascade',
  row(m2, 'startmenu') === '' && row(m2, 'startmenu2') === '', JSON.stringify(m2));
check('Start click re-opens the menu', row(m3, 'startmenu') !== '', JSON.stringify(m3));
check('focus change dismisses the menu', row(m4, 'startmenu') === '', JSON.stringify(m4));

// ---- the desktop layer (todos/0029) ----
const dl = row(d1, 'desktop');
check('desktop layer: fullscreen borderless surface', dl.includes('1024x768+0+0') && dl.includes('b'),
  JSON.stringify(d1));
check('desktop layer sits at the BOTTOM of z', dl.split('\t')[4] === '0', dl);
check('taskbar and app windows composite above it',
  row(d1, 'taskbar').split('\t')[4] !== '0' && row(d1, 'winbox').split('\t')[4] !== '0',
  JSON.stringify([row(d1, 'taskbar'), row(d1, 'winbox')]));
check('desktop shot written', out.includes('desk-shot-ok'));
check('single click does NOT launch (no gameboy window)',
  d2.split('\n').every(l => !l.endsWith('\tgameboy')), JSON.stringify(d2));
check('injected double-click on the term icon spawns term',
  row(d3, 'term') !== '', JSON.stringify(d3));

// ---- taskbar polish (todos/0031) ----
// wins[] order is creation order (sids ascend); the wmctl-list winbox rows
// give us the sid ladder to reason about button indices.
const wsids = (sec) => sec.split('\n').filter(l => l.endsWith('\twinbox'))
  .map(l => parseInt(l)).sort((a, b) => a - b);
const flagsOf = (sec, sid) => {
  const l = sec.split('\n').find(l => parseInt(l) === sid && l.endsWith('\twinbox'));
  return l ? l.split('\t')[5] : '';
};
check('four more winboxes up (6 winbox windows total)', wsids(b1).length === 6,
  JSON.stringify(wsids(b1)));
// After closing the 2nd of the new four, button 5 is the NEXT window (W3,
// now the second-highest sid) under compaction; swap-remove would have put
// the LAST window there (already focused -> the click would minimize it).
const s2 = wsids(b2);
check('close-middle keeps launch order: button 5 click focuses the slid-left window',
  flagsOf(b2, s2[s2.length - 2])[0] === 'f' && flagsOf(b2, s2[s2.length - 2])[1] !== 'm',
  JSON.stringify(b2));
// Overflow: 9 windows shrink the buttons clear of the clock — a click in
// the clock cell hits NO button (unshrunk it lands on button 8, the
// focused window, and would minimize it).
const s3 = wsids(b3);
check('clock-cell click falls on no button (focused window untouched)',
  flagsOf(b3, s3[s3.length - 1])[0] === 'f' && flagsOf(b3, s3[s3.length - 1])[1] !== 'm',
  JSON.stringify(b3));
check('taskbar shot written', out.includes('bar-shot-ok'));

// ---- window cycling (todos/0032) ----
// Recency ladder set up in-script: [.., W6, fixbox, winbox]. wmctl cycle -1
// is "previous window"; forward is the LRU walk; minimized are skipped.
const fsidOf = (sec) => {
  const l = sec.split('\n').find(l => ((l.split('\t')[5] || ''))[0] === 'f');
  return l ? parseInt(l) : -1;
};
const fixSid = parseInt(row(c1s, 'fixbox'));
const wLow = wsids(c1s)[0], wHigh = wsids(c1s)[wsids(c1s).length - 1];
check('pre-cycle: the original winbox is focused', fsidOf(c1s) === wLow,
  JSON.stringify([fsidOf(c1s), wLow]));
check('wmctl cycle -1 focuses the previous window (fixbox)', fsidOf(c2s) === fixSid,
  JSON.stringify([fsidOf(c2s), fixSid]));
check('cycle -1 again toggles back (winbox)', fsidOf(c3s) === wLow,
  JSON.stringify([fsidOf(c3s), wLow]));
check('minimized window skipped: cycle -1 lands on the 3rd-recent (W6)',
  fsidOf(c4s) === wHigh && row(c4s, 'fixbox').includes('m'),
  JSON.stringify([fsidOf(c4s), wHigh, row(c4s, 'fixbox')]));
check('forward cycle walks to the LRU window (focus moved, minimized still skipped)',
  fsidOf(c5s) !== fsidOf(c4s) && fsidOf(c5s) !== fixSid && fsidOf(c5s) > 0,
  JSON.stringify([fsidOf(c5s), fsidOf(c4s)]));

// ---- z layers (todos/0038): wm.c pins the taskbar to the TOP layer and
// the desktop to the BOTTOM one; the raised winbox stops below the bar.
// The wmctl FLAGS column grows a layer char (T/B) for pinned surfaces.
const zOf = (line) => parseInt((line || '').split('\t')[4]);
{
  const zAll = lay1.split('\n').filter(l => /\t/.test(l) && !/^SID\t/.test(l)).map(zOf);
  check('taskbar rides the top of z after a wmctl raise (todos/0038)',
    row(lay1, 'taskbar') !== '' && zOf(row(lay1, 'taskbar')) === Math.max(...zAll),
    JSON.stringify(lay1));
  check('raised winbox sits directly below the pinned bar',
    zOf(row(lay1, 'taskbar')) - 1 ===
      Math.max(...lay1.split('\n').filter(l => l.endsWith('\twinbox')).map(zOf)),
    JSON.stringify(lay1));
  check('desktop layer stays pinned at the bottom of z', zOf(row(lay1, 'desktop')) === 0,
    row(lay1, 'desktop'));
  check('FLAGS carry the layer char (taskbar T, desktop B, winbox neither)',
    (row(lay1, 'taskbar').split('\t')[5] || '').includes('T') &&
    (row(lay1, 'desktop').split('\t')[5] || '').includes('B') &&
    !/[TB]/.test(row(lay1, 'winbox').split('\t')[5] || ''),
    JSON.stringify([row(lay1, 'taskbar'), row(lay1, 'desktop'), row(lay1, 'winbox')]));
}

// ---- the focus fall skips pinned furniture (todos/0039 storm find):
// after SIGKILL of the focused winbox, focus must land on another NORMAL
// window — with the bar pinned +1, a raw top-of-z fall would park the
// focus on the taskbar and typed keys would vanish into the furniture.
{
  const fl1 = section('fall1');
  const focusedRow = fl1.split('\n')
    .find(l => ((l.split('\t')[5] || ''))[0] === 'f') || '';
  check('SIGKILL of the focused winbox: focus falls to a normal window, not the bar',
    focusedRow.endsWith('\twinbox'), JSON.stringify(fl1));
}

// ---- unified activate (todos/0066): both launch paths are activate() —
// runnable regular files (a #!/bin/sh launcher) spawn directly, plain
// files open through the openwith associations (todos/0072: default.gui
// -> notepad). Window-count deltas cross-check the peek: if
// ow_is_runnable() misfired, the launcher would open in notepad (not
// winbox) and notes.txt would fail to spawn (no notepad).
{
  const count = (sec, title) =>
    sec.split('\n').filter(l => l.endsWith('\t' + title)).length;
  const countIn = (sec, part) =>
    sec.split('\n').filter(l => l.includes(part)).length;
  check('desktop dblclick on a #!/bin/sh launcher runs it (winbox +1)',
    count(a2, 'winbox') === count(a1, 'winbox') + 1,
    JSON.stringify([count(a1, 'winbox'), count(a2, 'winbox')]));
  check('desktop dblclick on plain text opens the GUI default (notepad +1)',
    countIn(a3, 'Notepad') === countIn(a2, 'Notepad') + 1,
    JSON.stringify([countIn(a2, 'Notepad'), countIn(a3, 'Notepad')]));
  check('menu launcher script takes the same activate path (winbox +1)',
    count(a4, 'winbox') === count(a2, 'winbox') + 1,
    JSON.stringify([count(a2, 'winbox'), count(a4, 'winbox')]));
  check('seeded menu/snake is a real #! script now (image v36)',
    out.includes('#!=snake-shebang'));
}

// Icon pixels: read the shot back OUT of the root (writable) volume (the
// 0040 flip: /root lives on the root volume, full path preserved) and
// histogram icon cell 0 (doom at 16,16): white tile, navy center, black
// link notch on the teal ground.
{
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  const ppm = COMMON.readFileBytes(ufs, '/root/d.ppm');
  const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1');
  const m = /^P6\n(\d+) (\d+)\n255\n/.exec(head);
  check('desktop shot is a 1024x768 P6', !!m && m[1] === '1024' && m[2] === '768', head);
  if (m) {
    const off = head.indexOf('255\n') + 4, W = 1024;
    const px = (x, y) => Array.from(ppm.subarray(off + (y * W + x) * 3, off + (y * W + x) * 3 + 3));
    let white = 0, navy = 0, black = 0, teal = 0;
    for (let y = 16; y < 80; y++) {
      for (let x = 16; x < 100; x++) {
        const p = px(x, y), s = String(p);
        if (s === '255,255,255') white++;
        else if (s === '0,0,128') navy++;
        else if (s === '0,0,0') black++;
        else if (s === '0,128,128') teal++;
      }
    }
    check('icon cell 0 histogram: tile + glyph + notch + ground',
      white > 250 && navy > 100 && black > 20 && teal > 3000,
      JSON.stringify({ white, navy, black, teal }));
    check('empty desktop area is pure teal', String(px(500, 400)) === '0,128,128', px(500, 400));
  }

  // The taskbar shot (todos/0031): clock digits render in the right-aligned
  // HH.MM cell — histogram the black text pixels over the clock area.
  const bppm = COMMON.readFileBytes(ufs, '/root/bar.ppm');
  const bhead = Buffer.from(bppm.subarray(0, 20)).toString('latin1');
  const bm = /^P6\n(\d+) (\d+)\n255\n/.exec(bhead);
  check('taskbar shot is a 1024x28 P6', !!bm && bm[1] === '1024' && bm[2] === '28', bhead);
  if (bm) {
    const boff = bhead.indexOf('255\n') + 4, BW = 1024;
    let clock = 0;
    for (let y = 8; y < 20; y++) {
      for (let x = 979; x < 1021; x++) {
        const i = boff + (y * BW + x) * 3;
        if (bppm[i] === 0 && bppm[i + 1] === 0 && bppm[i + 2] === 0) clock++;
      }
    }
    check('clock digits present in the taskbar shot (black-pixel histogram)',
      clock >= 15, clock);
  }

  // The Start menu shot (todos/0078): the root column shows the sidebar
  // band, group rows with flyout arrows, the separator groove, and the
  // fixed-section text (hover is -1 — nothing injected before the shot).
  const mppm = COMMON.readFileBytes(ufs, '/root/m.ppm');
  const mhead = Buffer.from(mppm.subarray(0, 20)).toString('latin1');
  const mmm = /^P6\n(\d+) (\d+)\n255\n/.exec(mhead);
  check(`menu shot is a 168x${MENU_H} P6`,
    !!mmm && mmm[1] === '168' && mmm[2] === String(MENU_H), mhead);
  if (mmm) {
    const moff = mhead.indexOf('255\n') + 4, MW = 168;
    const mpx = (x, y) =>
      Array.from(mppm.subarray(moff + (y * MW + x) * 3, moff + (y * MW + x) * 3 + 3));
    check('sidebar band is navy', String(mpx(8, 20)) === '0,0,128', mpx(8, 20));
    const sepY = 4 + MENU_GROUPS.length * 20 + 8 / 2 - 1;
    check('separator groove above the fixed section (dark line over light)',
      String(mpx(80, sepY)) === '96,96,96' && String(mpx(80, sepY + 1)) === '255,255,255',
      [mpx(80, sepY), mpx(80, sepY + 1)]);
    check('group rows carry the flyout arrow', String(mpx(158, 13)) === '0,0,0',
      mpx(158, 13));
    let fixedBlack = 0;
    for (let y = 4 + MENU_GROUPS.length * 20 + 8; y < MENU_H - 4; y++)
      for (let x = 20; x < 120; x++)
        if (String(mpx(x, y)) === '0,0,0') fixedBlack++;
    check('fixed-section text present (SETTINGS / RUN...)', fixedBlack >= 40, fixedBlack);
  }
}

// ---- Start menu v2 tail (todos/0078): the command path, keyboard nav,
// type-ahead, Esc, and the RUN... builtin — window counts as deltas.
{
  const s1 = section('sm1'), s2 = section('sm2'), s3 = section('sm3'),
        s4 = section('sm4'), s5 = section('sm5'), s6 = section('sm6'),
        s7 = section('sm7'), s8 = section('sm8');
  const count = (sec, title) =>
    sec.split('\n').filter(l => l.endsWith('\t' + title)).length;
  check('wmctl menu with no WM was refused (the menu IS policy)',
    out.includes('menu-refused'));
  check('wmctl menu opens the Start menu (the chord path)',
    out.includes('menu-cmd-ok') && row(s1, 'startmenu') === '' && row(s2, 'startmenu') !== '',
    JSON.stringify(s2));
  check(`type-ahead g + Right cascades the Games flyout (${flyGeom(GAMES, 'Games')})`,
    row(s3, 'startmenu2').includes(flyGeom(GAMES, 'Games')), JSON.stringify(s3));
  check('Esc dismisses the whole cascade',
    row(s4, 'startmenu') === '' && row(s4, 'startmenu2') === '', JSON.stringify(s4));
  check('the RUN... fixed row opens the run dialog (240x70, above the bar)',
    row(s5, 'startrun').includes('240x70+6+664') && row(s5, 'startmenu') === '',
    JSON.stringify(s5));
  check('typed command + Enter launches it (sh -c winbox: +1) and closes the dialog',
    count(s6, 'winbox') === count(s5, 'winbox') + 1 && row(s6, 'startrun') === '',
    JSON.stringify([count(s5, 'winbox'), count(s6, 'winbox')]));
  check('keyboard Down+Right cascades an /etc/menu group flyout',
    row(s7, 'startmenu2') !== '', JSON.stringify(s7));
  check('keyboard Enter runs the nested launcher (winbox +1)',
    count(s8, 'winbox') === count(s7, 'winbox') + 1,
    JSON.stringify([count(s7, 'winbox'), count(s8, 'winbox')]));
}

// ---- Aero effects (todos/0063) ----
{
  const ae1 = section('aero1'), ae2 = section('aero2'), ae3 = section('aero3');
  // Aero Peek: injected hover over button 0 raised the popup (wm furniture,
  // borderless, 160x120, parked above the 28px bar); hover elsewhere drops it.
  const peek = row(ae1, 'peek');
  check('taskbar hover raises the Aero Peek popup (todos/0063)',
    peek.includes('160x120') && peek.includes('b') && peek.includes('+616'),
    JSON.stringify(ae1));   // parked at 768 - 28(bar) - 120 - 4
  check('peek popup rides the TOP layer like the bar',
    (peek.split('\t')[5] || '').includes('T'), peek);
  check('peek popup is shot-able (pixels live)', out.includes('peek-shot-ok'));
  check('hover off the buttons dismisses the peek', row(ae2, 'peek') === '',
    JSON.stringify(ae2));
  // wmctl thumb: exact box-filter goldens out of the real fixbox frame.
  check('wmctl thumb writes the aspect-fit PPM header', out.includes('60 40'),
    out.slice(out.indexOf('=thumb-hdr') - 20, out.indexOf('=thumb-hdr') + 12));
  check('thumb corner averages fixbox\'s white border', out.includes('thumb-border-white'));
  check('thumb center averages fixbox\'s orange fill', out.includes('thumb-center-orange'));
  // Per-pixel alpha end to end (SDL_WINDOW_TRANSPARENT -> record flag 'A'
  // -> the deterministic src-over composite).
  const ab = row(ae3, 'alphabox');
  check('alphabox carries the A flag (todos/0063)',
    (ab.split('\t')[5] || '').includes('A'), ab);
  check('winbox rows carry no A flag',
    !((row(ae3, 'winbox').split('\t')[5] || '').includes('A')), row(ae3, 'winbox'));
  check('50%-alpha client composites to the exact src-over blend',
    out.includes('alpha-blend-ok'), out.slice(-2000));
  // Glass: accepted by the endpoint, invisible to the headless composite.
  check('wmctl glass toggles on and off',
    out.includes('glass-on-ok') && out.includes('glass-off-ok'));
  check('glass never changes the headless composite',
    out.includes('glass-headless-invariant'));
}

// ---- desktop icon selection & manipulation (todos/0077) ----
// Selection = the navy label strip under an icon (the 0029 highlight,
// per-set since 0077). Sample 1px left of the label text: navy when
// selected, teal when not. Cells are (col, row); term moves to (2,1).
{
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  const readPpm = (name) => {
    const ppm = COMMON.readFileBytes(ufs, '/root/' + name);
    const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1');
    const off = head.indexOf('255\n') + 4;
    return (x, y) => String(Array.from(
      ppm.subarray(off + (y * 1024 + x) * 3, off + (y * 1024 + x) * 3 + 3)));
  };
  const NAVY = '0,0,128', TEAL = '0,128,128', WHITE = '255,255,255';
  const strip = (px, name, c, r) => {
    const len = Math.min(13, name.length);
    const lx = 16 + c * 84 + Math.floor((84 - len * 6) / 2);
    return px(lx - 1, 16 + r * 64 + 34 + 3);
  };
  const at = (name) => [name, 0, DESK_ACT.indexOf(name)];   // pre-move cells
  for (const s of ['s1', 's2', 's2b', 's3', 's4', 's5', 's6'])
    check(`${s} shot written`, out.includes(s + '-ok'));
  const p1 = readPpm('s1.ppm');
  check('plain click selects one (gameboy navy, doom teal)',
    strip(p1, ...at('gameboy')) === NAVY && strip(p1, ...at('doom')) === TEAL,
    [strip(p1, ...at('gameboy')), strip(p1, ...at('doom'))]);
  const p2 = readPpm('s2.ppm');
  check('ctrl+click adds (gameboy AND doom navy)',
    strip(p2, ...at('gameboy')) === NAVY && strip(p2, ...at('doom')) === NAVY,
    [strip(p2, ...at('gameboy')), strip(p2, ...at('doom'))]);
  const p2b = readPpm('s2b.ppm');
  check('shift+click ranges from the anchor (doom..mario navy, ends teal)',
    strip(p2b, ...at('doom')) === NAVY && strip(p2b, ...at('drmario')) === NAVY &&
    strip(p2b, ...at('gameboy')) === NAVY && strip(p2b, ...at('mario')) === NAVY &&
    strip(p2b, ...at('alauncher')) === TEAL && strip(p2b, ...at('quake')) === TEAL,
    [strip(p2b, ...at('doom')), strip(p2b, ...at('mario')), strip(p2b, ...at('quake'))]);
  const p3 = readPpm('s3.ppm');
  check('marquee REPLACES with the intersected tiles (rows 0-2)',
    strip(p3, ...at('alauncher')) === NAVY && strip(p3, ...at('doom')) === NAVY &&
    strip(p3, ...at('drmario')) === NAVY && strip(p3, ...at('gameboy')) === TEAL &&
    strip(p3, ...at('mario')) === TEAL,
    [strip(p3, ...at('alauncher')), strip(p3, ...at('gameboy'))]);
  const icons = section('sel1');
  check('.icons persists the whole layout (term at 2,1; alauncher pinned 0,0)',
    icons.includes('2 1 term') && icons.includes('0 0 alauncher'), icons);
  const p4 = readPpm('s4.ppm');
  check('drag-move relocated term to (2,1): tile there, old cell teal, still selected',
    p4(216, 88) === WHITE && p4(58, 546) === TEAL && strip(p4, 'term', 2, 1) === NAVY,
    [p4(216, 88), p4(58, 546), strip(p4, 'term', 2, 1)]);
  const p5 = readPpm('s5.ppm');
  check('Ctrl+A selects all (alauncher, notes.txt, moved term navy)',
    strip(p5, ...at('alauncher')) === NAVY && strip(p5, ...at('notes.txt')) === NAVY &&
    strip(p5, 'term', 2, 1) === NAVY,
    [strip(p5, ...at('alauncher')), strip(p5, ...at('notes.txt'))]);
  check('Enter on the multi-selection is a no-op (the multi-launch guard)',
    out.includes('NOOP-DELTA-0'), out.slice(out.indexOf('NOOP-DELTA')).slice(0, 20));
  const p6 = readPpm('s6.ppm');
  check('Esc clears the selection',
    strip(p6, ...at('gameboy')) === TEAL && strip(p6, 'term', 2, 1) === TEAL,
    [strip(p6, ...at('gameboy')), strip(p6, 'term', 2, 1)]);
  check('Right selects the top-left icon; Enter launches it (winbox +1)',
    out.includes('LAUNCH-DELTA-1'), out.slice(out.indexOf('LAUNCH-DELTA')).slice(0, 20));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nwm service e2e: ${failures} FAILED` : '\nwm service e2e: PASS');
process.exit(failures ? 1 : 0);
