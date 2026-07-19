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
const { driveBoot, freshImage, deskEntries, deskCell } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-wm-');

// The single-column Start menu (os/wm.c, todos/0098+0132 + follow-up): a
// FIXED 192x274 root parked above the 28px taskbar on the 1024x768 headless
// screen. A 22px gucOS branding BAND runs down the left, then a 170px
// column: pinned + MRU recents, a groove and the fixed places Settings/Run...,
// a groove, and — XP/Vista/7 style — the "All Programs" row at the BOTTOM,
// with a search box at its foot (y 248). "All Programs" cascades the menu
// tree as flyout columns snugly off the column's right edge — startmenu2
// lists the baked GROUPS (dirs-first sort), startmenu3 a group's leaves.
// Recents (~/.config/recent) grow via the wm's activate() on every real
// launch; clearing recents+pinned puts Settings/Run... at rows 0-1 and pins
// "All Programs" to the BOTTOM display row (SM_ROWS-1) above the search box,
// an empty gap between (XP/Win7). Item x is offset by the SM_SIDE band. Bump
// the leaf lists when image.json's menu tree changes.
const SM_SIDE = 22, SM_COL = 170;
const SM_W = SM_SIDE + SM_COL, SM_H = 274, SM_ROW_H = 20, SM_PAD = 4, SM_ROWS = 12;
const SM_Y = 768 - 28 - SM_H;                    // 466
const AP_ROW = SM_ROWS - 1;                       // All Programs DISPLAY row: pinned
                                                  // to the bottom (XP/Win7), above search
const SM_GEOM = `${SM_W}x${SM_H}+0+${SM_Y}`;
const SM_SEARCH_Y = SM_PAD + SM_ROWS * SM_ROW_H + 4;  // 248
const SM_ROOT = { x: 0, y: SM_Y, w: SM_W };
// Flyout columns are menucore chain levels since todos/0259: 18px rows,
// 1px border (h = 4 + 18n), WIDTH MEASURED from freetype (asserted
// structurally, never as a literal); a level parks at parent-right - 3
// with row 0 aligned to the anchor row's drawn top, clamped to the work
// area by the wm's win_create op. flyH/flyY compute the deterministic
// parts; x/w come from the live `wmctl list` rows.
const MC_ROW = 18, MC_SEP = 8;
const flyH = (n) => 4 + n * MC_ROW;
const flyClampY = (y, h) => Math.max(0, Math.min(y, 740 - h));
const flyRowY = (i) => 1 + i * MC_ROW + 9;            // window-local click y
// Parse "WxH+X+Y" out of a wmctl list row.
const g4 = (line) => {
  const m = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec((line.split('\t')[2] || ''));
  return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
};
// Context-menu row center (menucore geometry since 0259) — the 0101
// taskbar-strip menu rows (Cascade 0, Tile 1, Minimize All 2).
const rowY101 = (i) => 1 + i * MC_ROW + 9;
// Window system-menu row centers (todos/0102): Restore/Move/Size/Minimize/
// Maximize, an 8px sep, then Close — rows past the sep shift down by 8.
const rowYsys = (i) => (i < 5 ? 1 + i * MC_ROW
                              : 1 + 5 * MC_ROW + MC_SEP + (i - 6) * MC_ROW) + 9;
const MENU_GROUPS = ['Accessories', 'Demos', 'Games'];
const DEMOS = ['cairodemo', 'ctldemo', 'gdidemo', 'gpubox', 'learn-mgp', 'mgp', 'slides', 'winbox'];

// The seeded /root/Desktop icons, DERIVED from os/image.json's user section
// (the manifest that seeds a fresh root volume — these e2es always boot one),
// so a new seeded icon can't silently shift every row like 785eca2's notepad
// did (todos/0166; the 0164 rule: derive geometry, never hardcode). The
// grid model lives in drive.js (deskEntries/deskCell) since 0184 pushed the
// seeded set past one column at 1024x768 (11 rows/col) and 0185 seeded a
// DIRECTORY (Presentations, dirs-first per entcmp) — column-0 y math alone
// is no longer safe. desk() renders a name's icon-center click coords.
const DESK_ENTRIES = deskEntries();      // files + dirs + the Recycle Bin
const desk = (list, name) => {
  const c = deskCell(list, name);
  return `${c.x + 42} ${c.y + 32}`;
};
// the activate leg drops two more files in and re-sorts
const DESK_ACT = deskEntries(['alauncher', 'notes.txt']);

// One seeded session. Sids/pids are extracted IN-shell (sed) so the test
// doesn't depend on the wm-autostart vs first-command spawn race.
const script = [
  'winbox &',
  'wmctl wait win winbox',
  'echo ==list1',
  'wmctl list',
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'TSID=$(wmctl list | grep taskbar$ | sed "s/[^0-9].*//")',
  'WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")',
  'wmctl min $WSID',
  'wmctl wait flag $WSID m',
  'echo ==list2',
  'wmctl list',
  'wmctl click $TSID 60 14',                     // taskbar button 0 -> restore
  'wmctl wait flag $WSID f',
  'echo ==list3',
  'wmctl list',
  'wmctl shot screen /root/s.ppm && head -c 2 /root/s.ppm && echo',
  'wmctl focus 999 || echo bad-sid-fails',
  'winbox fixed &',                              // viewport scaling (todos/0024)
  'wmctl wait win fixbox',
  'FSID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")',
  'wmctl scale $FSID 480 320 && echo scale-ok',
  'wmctl resize $FSID 300 200 || echo resize-refused',
  'wmctl scale $WSID 300 200 || echo scale-refused',
  'echo ==list6',
  'wmctl list',
  'wmctl max $WSID && echo max-ok',              // maximize/restore (todos/0025)
  'wmctl wait dim $WSID 1024x712',               // maximize RESIZE ack landed (0155)
  'echo ==list7',
  'wmctl list',
  'wmctl max $WSID',                             // toggle back
  'wmctl wait dim $WSID 240x160',                // restore RESIZE ack landed (0155)
  'echo ==list8',
  'wmctl list',
  'wmctl max $FSID',                             // fixed-size: scale-to-fit branch
  'wmctl wait dst $FSID 960x640',                // scale-to-fit SET_DST ack landed (0155)
  'echo ==list9',
  'wmctl list',
  'wmctl max $FSID',                             // restore the pre-max dst
  'wmctl wait dst $FSID 480x320',                // restore SET_DST ack landed (0155)
  'echo ==list10',
  'wmctl list',
  'kill $WMPID',                                 // crash the WM
  'wmctl wait nowin taskbar',
  'wmctl max $WSID || echo max-refused',         // maximize IS policy: no WM, no max
  'wmctl menu || echo menu-refused',             // likewise the menu (0078)
  'echo ==list4',
  'wmctl list',                                  // endpoint is the KERNEL's: still up
  'wm &',                                        // respawn
  'wmctl wait win taskbar',
  'echo ==list5',
  'wmctl list',
  'TSID=$(wmctl list | grep taskbar$ | sed "s/[^0-9].*//")',   // new wm, new sid
  // ---- the Start menu (todos/0028; single-column todos/0098+0132) ----
  // Virgin recents so the column is [Settings, Run..., All Programs] (rows 0-2,
  // All Programs at the bottom): open, cascade All Programs -> the tree flyout
  // (GROUPS) -> a nested leaf, which launches winbox AND records a recent.
  'rm -f /root/.config/recent /root/.config/pinned',
  'wmctl click $TSID 25 14',                      // Start button (x < 50)
  'wmctl wait win startmenu',
  'echo ==menu1',
  'wmctl list',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl shot $MSID /root/m.ppm && echo menu-shot-ok',
  `wmctl hover $MSID 60 ${AP_ROW * SM_ROW_H + 14}`,   // All Programs (bottom row) -> the tree
  'wmctl wait win startmenu2',
  'echo ==menu1b',
  'wmctl list',
  'M2SID=$(wmctl list | grep startmenu2$ | sed "s/[^0-9].*//")',
  `wmctl hover $M2SID 30 ${flyRowY(MENU_GROUPS.indexOf('Demos'))}`,   // Demos group -> its leaves
  'wmctl wait win startmenu3',
  'echo ==menu1c',
  'wmctl list',
  'M3SID=$(wmctl list | grep startmenu3$ | sed "s/[^0-9].*//")',
  `wmctl click $M3SID 30 ${flyRowY(DEMOS.indexOf('winbox'))}`,        // winbox, nested (sorted)
  'wmctl wait count winbox 2',
  'echo ==menu2',
  'wmctl list',
  'echo ==menurec',
  'cat /root/.config/recent',
  'echo ==menurecend',
  'wmctl click $TSID 25 14',                      // re-open (now lists the recent)
  'wmctl wait win startmenu',
  'echo ==menu3',
  'wmctl list',
  'wmctl focus $WSID',                           // focus change dismisses
  'wmctl wait nowin startmenu',
  'echo ==menu4',
  'wmctl list',
  // ---- the desktop layer (todos/0029) ----
  'echo ==desk1',
  'wmctl list',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'wmctl shot $DSID /root/d.ppm && echo desk-shot-ok',
  `wmctl click $DSID ${desk(DESK_ENTRIES, 'gameboy')}`,   // SINGLE click the gameboy icon
  'sleep 2.5',                                   // timing subject: proves a single click does NOT spawn (the would-be spawn window)
  'echo ==desk2',
  'wmctl list',
  `wmctl dblclick $DSID ${desk(DESK_ENTRIES, 'term')}`,   // double-click the term icon
  'wmctl wait win term',
  'echo ==desk3',
  'wmctl list',
  // ---- desktop folder opens in fileman (todos/0185): dblclick the seeded
  // Presentations dir -> activate()'s S_ISDIR branch spawns fileman AT the
  // folder (title truncated to 31 chars); close it so the taskbar legs
  // below start from the same button set as before. ----
  `wmctl dblclick $DSID ${desk(DESK_ENTRIES, 'Presentations')}`,
  'wmctl wait win "File Manager - /root/Desktop/Pr"',
  'echo ==desk4',
  'wmctl list',
  'FMSID=$(wmctl list | grep "File Manager - /root/Desktop/Pr$" | sed "s/[^0-9].*//")',
  'wmctl close $FMSID',
  'wmctl wait nowin "File Manager - /root/Desktop/Pr"',
  // ---- taskbar polish (todos/0031) ----
  // Stable button order: 4 fresh winboxes; closing the SECOND must slide
  // the later buttons left (compaction), not swap the last into its slot.
  'winbox & winbox & winbox & winbox &',
  'wmctl wait count winbox 6',
  'echo ==bar1',
  'wmctl list',
  'W2=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//" | sort -n | tail -4 | head -2 | tail -1)',
  'wmctl close $W2',
  'wmctl wait gone $W2',
  // Buttons: [4 pre-existing][W1][W3][W4] now; button 5 (x center 650)
  // must focus W3 (compaction) — swap-remove would put W4 there.
  'wmctl click $TSID 650 14',
  'sleep 0.3',                                   // timing subject: taskbar-button focus/compaction settle (target sid computed post-hoc in JS)
  'echo ==bar2',
  'wmctl list',
  // Overflow: two more windows -> 9 buttons only fit shrunk left of the
  // clock; a click in the clock cell must fall on NO button (pre-0031 it
  // lands on button 8 and toggles it). Since 0101 the clock cell toggles
  // the date tooltip instead — still no window touched; toggle it back off
  // so the lingering top-layer popup doesn't perturb the z-order legs.
  'winbox & winbox &',
  'wmctl wait count winbox 7',
  'wmctl click $TSID 1000 14',
  'wmctl wait win datepop',
  'echo ==bar3',
  'wmctl list',
  'wmctl click $TSID 1000 14',                    // toggle the date tooltip off
  'wmctl wait nowin datepop',
  'wmctl shot $TSID /root/bar.ppm && echo bar-shot-ok',
  // ---- window cycling (todos/0032): wmctl cycle -> WMP CYCLE -> the same
  // EV_CYCLE -> wm.c policy. Focus fixbox then winbox so the recency
  // ladder's top three are known: [.., W6(create), fixbox, winbox]. ----
  'wmctl focus $FSID',
  'wmctl focus $WSID',
  'wmctl wait flag $WSID f',
  'echo ==cyc1',
  'wmctl list',
  'wmctl cycle -1',                              // previous window
  'wmctl wait flag $FSID f',
  'echo ==cyc2',
  'wmctl list',
  'wmctl cycle -1',                              // ...and back (the toggle)
  'wmctl wait flag $WSID f',
  'echo ==cyc3',
  'wmctl list',
  'wmctl min $FSID',                             // minimize the 2nd-recent
  'wmctl wait flag $FSID m',
  'wmctl cycle -1',                              // must skip it
  'sleep 0.3',                                   // timing subject: cycle-focus settle (skips the minimized window; target computed in JS)
  'echo ==cyc4',
  'wmctl list',
  'wmctl cycle',                                 // forward: the LRU window
  'sleep 0.3',                                   // timing subject: forward-cycle focus settle (target computed in JS)
  'echo ==cyc5',
  'wmctl list',
  // ---- z layers (todos/0038): the real wm.c pins its furniture — the
  // taskbar rides the TOP layer, the desktop the BOTTOM one; a raise (or
  // any later create) must stop below the bar. ----
  'wmctl raise $WSID',
  'sleep 0.3',                                   // timing subject: raise z-order settle (z-order verified in JS)
  'echo ==layer1',
  'wmctl list',
  // ---- the focus fall skips pinned furniture (todos/0039): SIGKILL the
  // focused winbox; with the real wm.c bar pinned +1 at the top of z, the
  // fall must land on another NORMAL window, never the furniture. ----
  'wmctl focus $WSID',
  'wmctl wait flag $WSID f',
  'FPID=$(wmctl list | cut -f2,6 | grep "\tf" | cut -f1)',
  'kill -9 $FPID',
  'wmctl wait gone $WSID',
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
  'sleep 2.5',                                   // timing subject: wm.c desk_load re-read poll (~1s tick) picks up the new icons
  'echo ==act1',
  'wmctl list',
  'ACW=$(wmctl list | grep -c winbox$)',
  `wmctl dblclick $DSID ${desk(DESK_ACT, 'alauncher')}`,      // the alauncher icon (sorted)
  'wmctl wait atleast winbox $((ACW+1))',        // #!/bin/sh launcher -> winbox spawns (0155)
  'echo ==act2',
  'wmctl list',
  `wmctl dblclick $DSID ${desk(DESK_ACT, 'notes.txt')}`,      // the notes.txt icon
  'for i in $(seq 1 200); do wmctl list | grep -q Notepad && break; sleep 0.05; done',  // plain text -> notepad opens (freetype + .res load) (0155)
  'echo ==act3',
  'wmctl list',
  // The seeded snake entry became a real launcher script (image v36; in
  // the Games group since todos/0078).
  'head -c 2 /usr/share/menu/Games/snake && echo =snake-shebang',
  // The menu takes the same path via live search: an /etc/menu override dir
  // with ONE launcher-script entry (the dir existing wins, todos/0040), so
  // the search walk sees /etc/menu; typing its name + Enter launches it.
  'mkdir /etc/menu',
  "printf '#!/bin/sh\\nwinbox\\n' > /etc/menu/go",
  'wmctl click $TSID 25 14',                     // Start
  'wmctl wait win startmenu',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $MSID 10 103',                      // 'g' -> search narrows to go
  'wmctl key $MSID 18 111',                      // 'o'
  'GC=$(wmctl list | grep -c winbox$)',
  'wmctl key $MSID 40 13',                       // Enter -> launch the top hit
  'wmctl wait atleast winbox $((GC+1))',         // live-search 'go' launcher spawns
  'echo ==act4',
  'wmctl list',
  'rm -rf /etc/menu',
  // ---- Aero effects (todos/0063) ----
  // Aero Peek: injected motion over taskbar button 0 raises the "peek"
  // thumbnail popup; motion over the Start strip drops it.
  'wmctl hover $TSID 60 14',
  'wmctl wait win peek',
  'echo ==aero1',
  'wmctl list',
  'PSID=$(wmctl list | grep peek$ | sed "s/[^0-9].*//")',
  'wmctl shot $PSID /root/p.ppm && echo peek-shot-ok',
  'wmctl hover $TSID 25 14',
  'wmctl wait nowin peek',
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
  'wmctl wait win alphabox',
  'ASID=$(wmctl list | grep alphabox$ | sed "s/[^0-9].*//")',
  'echo ==aero3',
  'wmctl list',
  'BSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//" | head -1)',
  'wmctl restore $BSID',
  'wmctl move $BSID 500 300',
  'wmctl move $ASID 480 280',
  'wmctl raise $ASID',
  'sleep 0.3',                                   // timing subject: move+raise composite settle before the alpha-blend screen shot
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
  // ---- Start menu v2 tail (todos/0098): command path, live search, Esc
  // clear-then-close, the RUN... place, and the keyboard All Programs
  // cascade. Deltas only — window counts at this point are whatever the
  // storms above left behind. ----
  'rm -f /root/.config/recent /root/.config/pinned',
  'echo ==sm1',
  'wmctl list',
  'wmctl menu && echo menu-cmd-ok',              // wmctl menu = the chord
  'wmctl wait win startmenu',
  'echo ==sm2',
  'wmctl list',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  // live search: "winbox" narrows the flat tree walk; Enter launches the top hit
  'wmctl key $MSID 26 119',                      // w
  'wmctl key $MSID 12 105',                      // i
  'wmctl key $MSID 17 110',                      // n
  'wmctl key $MSID 5 98',                        // b
  'wmctl key $MSID 18 111',                      // o
  'wmctl key $MSID 27 120',                      // x
  'wmctl shot $MSID /root/ms.ppm && echo search-shot-ok',
  'N1=$(wmctl list | grep -c winbox$)',
  'wmctl key $MSID 40 13',                       // Enter -> launch the top hit
  'wmctl wait atleast winbox $((N1+1))',         // the search top hit spawns
  'echo ==sm3',
  'wmctl list',
  'N2=$(wmctl list | grep -c winbox$)',
  'echo SEARCH-DELTA-$((N2-N1))',
  // Esc from a non-empty search clears it (menu stays); a second Esc closes.
  'wmctl menu',
  'wmctl wait win startmenu',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $MSID 26 119',                      // 'w' -> search non-empty
  'sleep 0.2',                                   // timing subject: in-surface search-box render (menu stays open, checked in JS)
  'echo ==sm4a',
  'wmctl list',
  'wmctl key $MSID 41 27',                       // Esc -> clears the search
  'sleep 0.2',                                   // timing subject: search-clear render (menu stays open, checked in JS)
  'echo ==sm4b',
  'wmctl list',
  'wmctl key $MSID 41 27',                       // Esc -> closes the menu
  'wmctl wait nowin startmenu',
  'echo ==sm4c',
  'wmctl list',
  // Run... (column row 1, after Settings): clear recents+pinned so the column
  // is deterministic [Settings, Run..., All Programs], open the dialog, type
  // "winbox", Enter.
  'rm -f /root/.config/recent /root/.config/pinned',
  'wmctl menu',
  'wmctl wait win startmenu',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $MSID 60 ${SM_PAD + 1 * SM_ROW_H + 10}`,
  'wmctl wait win startrun',
  'echo ==sm5',
  'wmctl list',
  'RSID=$(wmctl list | grep startrun$ | sed "s/[^0-9].*//")',
  'wmctl key $RSID 26 119',                      // w
  'wmctl key $RSID 12 105',                      // i
  'wmctl key $RSID 17 110',                      // n
  'wmctl key $RSID 5 98',                        // b
  'wmctl key $RSID 18 111',                      // o
  'wmctl key $RSID 27 120',                      // x
  'GR=$(wmctl list | grep -c winbox$)',
  'wmctl key $RSID 40 13',                       // Enter -> sh -c winbox
  'wmctl wait atleast winbox $((GR+1))',         // RUN... dialog sh -c winbox spawns
  'echo ==sm6',
  'wmctl list',
  // Keyboard All Programs cascade over an /etc/menu override tree: Up wraps to
  // All Programs (the bottom row), Right cascades the tree, Right descends the
  // group, Enter runs the launcher.
  'mkdir -p /etc/menu/Apps',
  "printf '#!/bin/sh\\nwinbox\\n' > /etc/menu/Apps/go",
  'rm -f /root/.config/recent /root/.config/pinned',   // column = [Settings, Run..., All Programs]
  'wmctl menu',
  'wmctl wait win startmenu',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $MSID 82 1073741906',               // Up -> All Programs (bottom row)
  'wmctl key $MSID 79 1073741903',               // Right -> the tree flyout (the
                                                 // UNION since 0259: /etc/menu's
                                                 // Apps ALONGSIDE the baked
                                                 // Accessories/Demos/Games —
                                                 // pre-union /etc SHADOWED the
                                                 // whole baked tree)
  'wmctl wait win startmenu2',
  'echo ==sm7',
  'wmctl list',
  'wmctl key $MSID 81 1073741905',               // Down -> Apps (sorted after
                                                 // Accessories)
  'wmctl key $MSID 79 1073741903',               // Right -> into the Apps group
  'wmctl wait win startmenu3',
  'GK=$(wmctl list | grep -c winbox$)',
  'wmctl key $MSID 40 13',                       // Enter -> go -> winbox
  'wmctl wait atleast winbox $((GK+1))',         // keyboard All-Programs cascade launcher spawns
  'echo ==sm8',
  'wmctl list',
  'rm -rf /etc/menu',
  // ---- depth-cap CURE (todos/0259 red→green): a 4-dir-deep tree
  // cascades to startmenu6 — SIX open Start windows (root + 5 chain
  // levels). The old fork engine's MENU_DEPTH 4 refused past startmenu4,
  // so the `wait win startmenu5` here times out RED on the pre-0259 wm.
  'mkdir -p /etc/menu/D1/D2/D3/D4',
  "printf '#!/bin/sh\nwinbox\n' > /etc/menu/D1/D2/D3/D4/deepgo",
  'chmod +x /etc/menu/D1/D2/D3/D4/deepgo',
  'wmctl menu',
  'wmctl wait win startmenu',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl key $MSID 82 1073741906',               // Up -> All Programs
  'wmctl key $MSID 79 1073741903',               // Right -> the tree (union:
                                                 // Accessories, D1, Demos, Games)
  'wmctl wait win startmenu2',
  'wmctl key $MSID 81 1073741905',               // Down -> D1
  'wmctl key $MSID 79 1073741903',               // Right -> D1 leaves
  'wmctl wait win startmenu3',
  'wmctl key $MSID 79 1073741903',               // -> D2 leaves
  'wmctl wait win startmenu4',
  'wmctl key $MSID 79 1073741903',               // -> D3 leaves (PAST the old cap)
  'wmctl wait win startmenu5',
  'wmctl key $MSID 79 1073741903',               // -> D4 leaves
  'wmctl wait win startmenu6',
  'echo ==deep1',
  'wmctl list',
  'DK=$(wmctl list | grep -c winbox$)',
  'wmctl key $MSID 40 13',                       // Enter -> deepgo -> winbox
  'wmctl wait atleast winbox $((DK+1))',
  'wmctl wait nowin startmenu2',
  'echo ==deep2',
  'wmctl list',
  'rm -rf /etc/menu',
  // ---- desktop icon selection & manipulation (todos/0077) ----
  // /root/Desktop is DESK_ACT here (seeds + 2 dropped files, wrapping into
  // column 1 since 0184). Click coordinates ride desk(); label-strip pixels
  // are asserted from surface shots after the run. The first click also
  // focuses the desktop (wm.c policy), so the later keyboard legs land on
  // the grid.
  `wmctl click $DSID ${desk(DESK_ACT, 'gameboy')}`,           // plain select
  'sleep 0.5',                                   // timing subject: in-surface desktop-selection render (navy label strip, no window observable)
  'wmctl shot $DSID /root/s1.ppm && echo s1-ok',
  // ctrl+click doom: additive toggle (keydown/keyup hold the modifier
  // across the separate click injection — todos/0077 wmctl growth)
  'wmctl keydown $DSID 224 1073742048 64',                    // LCTRL down
  `wmctl click $DSID ${desk(DESK_ACT, 'doom')}`,
  'wmctl keyup $DSID 224 1073742048 0',
  'sleep 0.5',                                   // timing subject: in-surface desktop-selection render (ctrl+click additive, no window observable)
  'wmctl shot $DSID /root/s2.ppm && echo s2-ok',
  // shift+click mario: range from the anchor (doom, entry order)
  'wmctl keydown $DSID 225 1073742049 1',                     // LSHIFT down
  `wmctl click $DSID ${desk(DESK_ACT, 'mario')}`,
  'wmctl keyup $DSID 225 1073742049 0',
  'sleep 0.5',                                   // timing subject: in-surface desktop-selection render (shift+click range, no window observable)
  'wmctl shot $DSID /root/s2b.ppm && echo s2b-ok',
  // marquee from empty desktop over the column-0 tiles of rows 0-2:
  // REPLACES the set (x stays short of column 1's tiles at x>=130)
  'wmctl drag $DSID 128 10 40 200',
  'sleep 0.5',                                   // timing subject: in-surface desktop-selection render (marquee replace, no window observable)
  'wmctl shot $DSID /root/s3.ppm && echo s3-ok',
  // drag-move: press term (its sorted DESK_ACT cell, column 1) and drop at
  // (2,1); the plain press on the unselected icon first collapses the set
  `wmctl drag $DSID ${desk(DESK_ACT, 'term')} 226 112`,
  'sleep 2.5',                                   // timing subject: wm.c desk_load re-read poll (~1s tick) persists the moved .icons
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
  'sleep 0.5',                                   // timing subject: in-surface desktop-selection render (Ctrl+A select-all, no window observable)
  'wmctl shot $DSID /root/s5.ppm && echo s5-ok',
  'wmctl key $DSID 40 13',                       // Enter: multi -> no-op
  'sleep 2',                                     // timing subject: proves no spawn
  'N2=$(wmctl list | grep -c winbox$)',
  'echo NOOP-DELTA-$((N2-N1))',
  'wmctl key $DSID 41 27',                       // Esc clears
  'sleep 0.5',                                   // timing subject: in-surface desktop-selection render (Esc clears, no window observable)
  'wmctl shot $DSID /root/s6.ppm && echo s6-ok',
  // arrows: Right with nothing selected takes the top-left icon (the
  // Presentations dir since 0185 — dirs sort first), Down steps to
  // alauncher at (0,1); Enter on the single selection launches it
  // (-> winbox)
  'wmctl key $DSID 79 1073741903',               // Right -> top-left (Presentations)
  'wmctl key $DSID 81 1073741905',               // Down -> alauncher
  'sleep 0.3',                                   // timing subject: in-surface arrow-select render before Enter (no window observable)
  'wmctl key $DSID 40 13',                       // Enter
  'wmctl wait atleast winbox $((N2+1))',         // arrow-select + Enter launches alauncher
  'N3=$(wmctl list | grep -c winbox$)',
  'echo LAUNCH-DELTA-$((N3-N2))',
  'echo ==sel3',
  'wmctl list',
  // ---- taskbar polish (todos/0101): strip menu, Minimize All, Show
  // Desktop, clock date. Screen 1024x768 -> clock_left = 1024-14-45 = 965;
  // the Show Desktop sliver is [1010,1024). Two fresh winboxes anchor the
  // reasoning (the two highest sids). ----
  'PWC0=$(wmctl list | grep -c winbox$)',
  'winbox & winbox &',
  'wmctl wait atleast winbox $((PWC0+2))',        // two fresh winboxes up (0155)
  'echo ==tp0',
  'wmctl list',
  // The two fresh winboxes are the two highest sids; TWA (the lower of them)
  // is the flag/dim sync target for the Minimize All / Show Desktop / Cascade
  // legs below — Minimize All & co. set every window in one wm.c pass, so once
  // TWA's flag flips in a list snapshot, TWB's has too (checked in JS).
  'TWA=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//" | sort -n | tail -2 | head -1)',
  // right-click the strip in the clock cell (x=970: always past the button
  // run, whatever the window count) -> the taskbar-strip menu (0101)
  'wmctl click $TSID 970 14 3',
  'wmctl wait win ctxmenu',
  'echo ==tp1',
  'wmctl list',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 30 ${rowY101(2)}`,          // Minimize All (row 2)
  'wmctl wait nowin ctxmenu',
  'echo ==tp2',
  'wmctl list',
  'wmctl click $TSID 1017 14',                    // Show Desktop: restore the stash
  'wmctl wait noflag $TWA m',                      // both restored (0155)
  'echo ==tp3',
  'wmctl list',
  'wmctl click $TSID 1017 14',                    // Show Desktop: minimize all again
  'wmctl wait flag $TWA m',                        // both re-minimized (0155)
  'echo ==tp4',
  'wmctl list',
  'wmctl click $TSID 1017 14',                    // ...and restore before Cascade
  'wmctl wait noflag $TWA m',                      // both restored (0155)
  'wmctl click $TSID 970 14 3',
  'wmctl wait win ctxmenu',
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $CXSID 30 ${rowY101(0)}`,          // Cascade (row 0)
  'wmctl wait dim $TWA 614x427',                   // Cascade resized to the uniform box (0155)
  'echo ==tp5',
  'wmctl list',
  // clock date tooltip: a click in the clock cell (x=980) raises "datepop"
  'wmctl click $TSID 980 14',
  'wmctl wait win datepop',
  'echo ==tp6',
  'wmctl list',
  'DPSID=$(wmctl list | grep datepop$ | sed "s/[^0-9].*//")',
  'wmctl shot $DPSID /root/date.ppm && echo date-shot-ok',
  'wmctl click $TSID 980 14',                     // click again toggles it off
  'wmctl wait nowin datepop',
  'echo ==tp7',
  'wmctl list',

  // ---- window system menu (todos/0102): Alt+Space / wmctl sysmenu opens
  // the sysmenu on the FOCUSED window; Move enters keyboard-move mode (the
  // popup stays up as the key grabber), arrows nudge 8px, Enter commits,
  // Esc reverts; Size grows a resizable window and is disabled on fixbox;
  // Close via the menu tears the window down. Fresh winbox + fixbox so the
  // leg is independent of the earlier state churn. ----
  'PWCsm=$(wmctl list | grep -c winbox$)',
  'PFCsm=$(wmctl list | grep -c fixbox$)',
  'winbox & winbox fixed &',
  'wmctl wait atleast winbox $((PWCsm+1))',       // fresh winbox up (0155)
  'wmctl wait atleast fixbox $((PFCsm+1))',       // fresh fixbox up (0155)
  'SWSID=$(wmctl list | grep winbox$ | tail -1 | sed "s/[^0-9].*//")',
  'SFSID=$(wmctl list | grep fixbox$ | tail -1 | sed "s/[^0-9].*//")',
  'echo swsid=$SWSID sfsid=$SFSID',
  'wmctl focus $SWSID',
  'wmctl wait flag $SWSID f',
  'echo ==smB',
  'wmctl list',                                   // pre-move geom
  'wmctl sysmenu && echo sysmenu-ok',
  'wmctl wait win ctxmenu',
  'echo ==smC',
  'wmctl list',                                   // ctxmenu (sysmenu) up
  'SMSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $SMSID 30 ${rowYsys(1)}`,          // MOVE -> keyboard-move mode
  'sleep 0.3',                                   // timing subject: keyboard-move mode engage (popup stays as key grabber, no observable)
  'echo ==smD',
  'wmctl list',                                   // popup STILL up (grabber)
  'wmctl key $SMSID 79 1073741903',               // Right x4 = +32 x
  'wmctl key $SMSID 79 1073741903',
  'wmctl key $SMSID 79 1073741903',
  'wmctl key $SMSID 79 1073741903',
  'wmctl key $SMSID 81 1073741905',               // Down x2 = +16 y
  'wmctl key $SMSID 81 1073741905',
  'sleep 0.3',                                   // timing subject: keyboard-move arrow nudges settle (position change, no dim observable)
  'echo ==smE',
  'wmctl list',                                   // winbox moved +32,+16
  'wmctl key $SMSID 40 13',                        // Enter -> commit + dismiss
  'wmctl wait nowin ctxmenu',
  'echo ==smF',
  'wmctl list',                                   // popup gone, at moved pos
  // Esc reverts: re-open, Move, nudge, Esc -> back to the smF position
  'wmctl focus $SWSID',
  'wmctl sysmenu',
  'wmctl wait win ctxmenu',
  'SMSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $SMSID 30 ${rowYsys(1)}`,          // MOVE again
  'sleep 0.3',                                   // timing subject: keyboard-move mode engage (popup stays as key grabber, no observable)
  'wmctl key $SMSID 80 1073741904',               // Left x3 = -24 x (mid-mode)
  'wmctl key $SMSID 80 1073741904',
  'wmctl key $SMSID 80 1073741904',
  'sleep 0.2',                                   // timing subject: mid-mode arrow nudges settle (position change, no dim observable)
  'echo ==smG',
  'wmctl list',                                   // shows the -24 mid-move
  'wmctl key $SMSID 41 27',                        // Esc -> revert
  'wmctl wait nowin ctxmenu',
  'echo ==smH',
  'wmctl list',                                   // back to the smF position
  // Size grows the resizable winbox
  'wmctl focus $SWSID',
  'wmctl sysmenu',
  'wmctl wait win ctxmenu',
  'SMSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $SMSID 30 ${rowYsys(2)}`,          // SIZE -> keyboard-size mode
  'sleep 0.3',                                   // timing subject: keyboard-size mode engage (popup stays as key grabber, no observable)
  'wmctl key $SMSID 79 1073741903',               // Right x4 = +32 w
  'wmctl key $SMSID 79 1073741903',
  'wmctl key $SMSID 79 1073741903',
  'wmctl key $SMSID 79 1073741903',
  'wmctl key $SMSID 81 1073741905',               // Down x4 = +32 h
  'wmctl key $SMSID 81 1073741905',
  'wmctl key $SMSID 81 1073741905',
  'wmctl key $SMSID 81 1073741905',
  'wmctl wait dim $SWSID 272x192',                 // Size-mode RESIZE ack landed (+32,+32) (0155)
  'wmctl key $SMSID 40 13',                        // Enter -> commit
  'wmctl wait nowin ctxmenu',
  'echo ==smSize',
  'wmctl list',                                   // winbox grew +32,+32
  // Size is disabled on the fixed-size fixbox: the row is grayed, so a click
  // never enters size mode and an arrow leaves the window untouched.
  'wmctl focus $SFSID',
  'wmctl sysmenu',
  'wmctl wait win ctxmenu',
  'echo ==smFixPre',
  'wmctl list',
  'SMSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $SMSID 30 ${rowYsys(2)}`,          // SIZE (grayed) -> no-op
  'wmctl key $SMSID 79 1073741903',               // Right -> ignored (no mode)
  'wmctl key $SMSID 79 1073741903',
  'sleep 0.3',                                   // timing subject: proves the grayed Size row + arrows are no-ops on fixbox (unchanged geometry checked in JS)
  'echo ==smFix',
  'wmctl list',                                   // fixbox unchanged, popup up
  'wmctl key $SMSID 41 27',                        // Esc -> dismiss the popup
  'wmctl wait nowin ctxmenu',
  // Close via the menu tears the winbox down
  'wmctl focus $SWSID',
  'wmctl sysmenu',
  'wmctl wait win ctxmenu',
  'SMSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $SMSID 30 ${rowYsys(6)}`,          // CLOSE (row 6, after the sep)
  'wmctl wait gone $SWSID',
  'echo ==smClose',
  'wmctl list',                                   // winbox gone

  // ---- desktop icon rename-in-place (todos/0103): F2 or the icon menu's
  // Rename opens an inline editor over the label; Enter commits rename(2),
  // Esc cancels, renaming onto an existing name keeps both files. Two fresh
  // 'aa*' files (sort before every seeded FILE icon) make the leg
  // independent of the earlier desktop churn without pixel math: clear the
  // selection with an empty-cell click, Right selects the top-left icon,
  // F2 edits it. The seeded Presentations DIR would sort ahead of them
  // (entcmp dirs-first, todos/0185), so drop it first — the later
  // long-name leg wipes the whole Desktop anyway. ----
  'rm -f /root/Desktop/.icons',                   // auto-flow: predictable order
  'rm -rf /root/Desktop/Presentations',           // dirs-first would steal top-left
  'printf x > /root/Desktop/aaa',                 // the icon we rename
  'printf y > /root/Desktop/aab',                 // the EEXIST target / menu target
  'sleep 2.5',                                     // timing subject: wm.c desk_load re-read poll (~1s tick) picks up aaa/aab
  'echo ==rn0',
  'ls /root/Desktop | tr "\\n" " "; echo',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  // F2 rename: focus the desktop (empty cell col5), select top-left (aaa),
  // F2, clear "aaa" with 3 Backspaces, type "zzz", Enter -> rename aaa->zzz
  'wmctl click $DSID 500 400',                    // empty cell: focus + clear
  'sleep 0.5',                                    // timing subject: desktop focus + selection-clear render (no observable)
  'wmctl key $DSID 79 1073741903',                // Right -> top-left = aaa
  'sleep 0.3',                                    // timing subject: arrow-select render (no observable)
  'wmctl key $DSID 59 1073741883',                // F2 -> inline editor on aaa
  'sleep 0.3',                                    // timing subject: inline-editor-open render (no observable)
  'wmctl key $DSID 42 8',                         // Backspace x3 clears "aaa"
  'wmctl key $DSID 42 8',
  'wmctl key $DSID 42 8',
  'wmctl key $DSID 29 122',                       // z
  'wmctl key $DSID 29 122',                       // z
  'wmctl key $DSID 29 122',                       // z
  'wmctl key $DSID 40 13',                        // Enter -> commit
  'for i in $(seq 1 120); do [ -e /root/Desktop/zzz ] && break; sleep 0.05; done',  // rename aaa->zzz landed (bounded poll, 0155)
  'echo ==rn2',
  'ls /root/Desktop | tr "\\n" " "; echo',        // aaa gone, zzz present
  // EEXIST: rename aab -> zzz (now exists) keeps both, editor stays open
  'wmctl click $DSID 500 400',
  'sleep 0.5',                                    // timing subject: desktop focus + selection-clear render (no observable)
  'wmctl key $DSID 79 1073741903',                // top-left now aab
  'sleep 0.3',                                    // timing subject: arrow-select render (no observable)
  'wmctl key $DSID 59 1073741883',                // F2 on aab
  'sleep 0.3',                                    // timing subject: inline-editor-open render (no observable)
  'wmctl key $DSID 42 8',                         // clear "aab"
  'wmctl key $DSID 42 8',
  'wmctl key $DSID 42 8',
  'wmctl key $DSID 29 122',                       // type "zzz" (exists)
  'wmctl key $DSID 29 122',
  'wmctl key $DSID 29 122',
  'wmctl key $DSID 40 13',                        // Enter -> EEXIST: no rename
  'sleep 0.5',                                    // timing subject: proves EEXIST kept both files (editor stays open, checked in JS)
  'echo ==rn3',
  'ls /root/Desktop | tr "\\n" " "; echo',        // aab AND zzz both present
  'wmctl key $DSID 41 27',                         // Esc -> drop the stuck editor
  'sleep 0.3',                                    // timing subject: editor-dismiss render (no observable)
  // Esc cancels an edit: F2 on aab, type a char, Esc -> file untouched
  'wmctl click $DSID 500 400',
  'sleep 0.5',                                    // timing subject: desktop focus + selection-clear render (no observable)
  'wmctl key $DSID 79 1073741903',                // top-left = aab
  'sleep 0.3',                                    // timing subject: arrow-select render (no observable)
  'wmctl key $DSID 59 1073741883',                // F2
  'sleep 0.3',                                    // timing subject: inline-editor-open render (no observable)
  'wmctl key $DSID 29 122',                       // append 'z' -> "aabz" (pending)
  'wmctl key $DSID 41 27',                         // Esc -> cancel, aab untouched
  'sleep 0.5',                                    // timing subject: proves Esc left the file untouched (no aabz, checked in JS)
  'echo ==rn4',
  'ls /root/Desktop | tr "\\n" " "; echo',        // aab present, no aabz
  // icon-menu Rename path (exercises the focus-race fix): right-click aab ->
  // menu -> Rename row -> editor -> rename aab -> mmm
  'wmctl click $DSID 58 48 3',                     // right-click col0 row0 = aab
  'wmctl wait win ctxmenu',
  'echo ==rn5',
  'wmctl list',                                    // ctxmenu (icon menu) up
  'CXSID=$(wmctl list | grep ctxmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $CXSID 30 108',                     // Rename row (row 6 on a document — Edit precedes, 0202; 1 + 2*18 + 8 + 3*18 + 9)
  'wmctl wait nowin ctxmenu',
  'wmctl key $DSID 42 8',                          // clear "aab"
  'wmctl key $DSID 42 8',
  'wmctl key $DSID 42 8',
  'wmctl key $DSID 16 109',                        // m
  'wmctl key $DSID 16 109',                        // m
  'wmctl key $DSID 16 109',                        // m
  'wmctl key $DSID 40 13',                         // Enter -> commit
  'for i in $(seq 1 120); do [ -e /root/Desktop/mmm ] && break; sleep 0.05; done',  // rename aab->mmm landed (bounded poll, 0155)
  'echo ==rn6',
  'ls /root/Desktop | tr "\\n" " "; echo',         // aab gone, mmm present

  // ---- long/spaced Desktop-icon launch (todos/0151): menu_ent.name[32]
  // truncation. A launcher whose filename is >= 32 chars WITH spaces used to
  // be snprintf-truncated into name[32]; desk_launch then built a path to a
  // file that didn't exist and activate()'s stat() failed -> the icon
  // silently never launched. Clear the Desktop to two known launchers so the
  // sorted auto-flow grid is deterministic ('My App' row 0, the long name
  // row 1 — Recycle Bin pins to the tail); both dblclicks must spawn winbox
  // now (the 36-char name is the regression witness). ----
  'rm -f /root/Desktop/.icons',
  'for f in /root/Desktop/*; do rm -rf "$f"; done',
  "printf '#!/bin/sh\\nwinbox\\n' > '/root/Desktop/My Really Long Application Name Here'",
  "printf '#!/bin/sh\\nwinbox\\n' > '/root/Desktop/My App'",
  'sleep 3',                                       // timing subject: wm.c desk_load re-read poll (~1s tick) picks up the two launchers
  'echo ==ln0',
  'ls /root/Desktop | tr "\\n" "|"; echo',
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  'LN0=$(wmctl list | grep -c winbox$)',
  'wmctl dblclick $DSID 58 48',                    // row 0 = 'My App' (short spaced)
  'wmctl wait atleast winbox $((LN0+1))',          // the short-name launcher spawns
  'LN1=$(wmctl list | grep -c winbox$)',
  'echo LN-SHORT-DELTA-$((LN1-LN0))',
  'wmctl dblclick $DSID 58 112',                   // row 1 = the 36-char spaced name
  'wmctl wait atleast winbox $((LN1+1))',          // the 36-char launcher spawns (0151 witness)
  'LN2=$(wmctl list | grep -c winbox$)',
  'echo LN-LONG-DELTA-$((LN2-LN1))',
  'echo ==ln1',
  'wmctl list',
  '',
].join('\n');

const r = driveBoot(script, { image });

const out = r.stdout;
const err = String(r.stderr || '');   // guest fd2 rides boot.js's stderr
function section(name) {
  const m = out.split('==' + name + '\n');
  return m.length > 1 ? m[1].split('==')[0] : '';
}
const l1 = section('list1'), l2 = section('list2'), l3 = section('list3'),
      l4 = section('list4'), l5 = section('list5'), l6 = section('list6'),
      l7 = section('list7'), l8 = section('list8'), l9 = section('list9'),
      l10 = section('list10'),
      m1 = section('menu1'), m1b = section('menu1b'), m1c = section('menu1c'),
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
// Distinct causes end-to-end (todos/0242): the R_ERR errno reaches wmctl's
// stderr as strerror text — a bad sid and a mode-refusal read DIFFERENTLY.
check('wmctl focus bogus sid names the cause (EINVAL)',
  err.includes('wmctl: focus: Invalid argument'), err.slice(-400));

// ---- viewport scaling (todos/0024): wmctl scale on the real binaries ----
check('wmctl scale on a fixed-size window succeeds', out.includes('scale-ok'));
check('wmctl resize on a fixed-size window is refused', out.includes('resize-refused'));
check('wmctl scale on a RESIZABLE window is refused', out.includes('scale-refused'));
check('wmctl resize on a fixed-size window names the cause (EPERM, todos/0242)',
  err.includes('wmctl: resize: Operation not permitted'), err.slice(-400));
check('wmctl scale on a RESIZABLE window names the cause (EPERM, todos/0242)',
  err.includes('wmctl: scale: Operation not permitted'), err.slice(-400));
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
check('wmctl max with no WM names the cause (ENODEV, todos/0242)',
  err.includes('wmctl: max: No such device (no WM subscribed)'), err.slice(-400));
const bar5 = row(l5, 'taskbar');
check('wm & respawns: taskbar back at the bottom edge',
  bar5.includes('1024x28+0+740'), JSON.stringify(l5));

// ---- the Start menu (todos/0028; single-column todos/0098+0132) ----
const menu1 = row(m1, 'startmenu');
check(`Start click opens the single-column root above the taskbar (${SM_GEOM}, borderless)`,
  menu1.includes(SM_GEOM) && menu1.includes('b'), JSON.stringify(m1));
check('menu shot written', out.includes('menu-shot-ok'));
// All Programs at the bottom row: level 0 anchors at root-right - 3,
// y = rooty + AP_ROW * SM_ROW_H, clamped; h = 4 + 18 * groups.
const treeH = flyH(MENU_GROUPS.length);
const treeY = flyClampY(SM_Y + AP_ROW * SM_ROW_H, treeH);
const fly1 = row(m1b, 'startmenu2');
const fg1 = g4(fly1);
check(`All Programs cascades the tree flyout of GROUPS (h ${treeH} at root-right - 3, y ${treeY})`,
  fg1 && fg1.h === treeH && fg1.x === SM_ROOT.x + SM_ROOT.w - 3 &&
  fg1.y === treeY && fly1.includes('b'), JSON.stringify(m1b));
const demosH = flyH(DEMOS.length);
const demosY = flyClampY(fg1 ? fg1.y + 1 + MENU_GROUPS.indexOf('Demos') * MC_ROW
                             : 0, demosH);
const fly2 = row(m1c, 'startmenu3');
const fg2 = g4(fly2);
check(`hovering the Demos group cascades its leaves (h ${demosH}, parent-right - 3)`,
  fg1 && fg2 && fg2.h === demosH && fg2.x === fg1.x + fg1.w - 3 &&
  fg2.y === demosY && fly2.includes('b'), JSON.stringify(m1c));
check('nested flyout click launches winbox (second instance)',
  m2.split('\n').filter(l => l.endsWith('\twinbox')).length === 2, JSON.stringify(m2));
check('selection dismissed the whole cascade',
  row(m2, 'startmenu') === '' && row(m2, 'startmenu2') === '' &&
  row(m2, 'startmenu3') === '', JSON.stringify(m2));
const menuRec = (out.split('==menurec\n')[1] || '').split('==menurecend')[0].trim();
check('the launch recorded an MRU recent (~/.config/recent grew)',
  /\/winbox$/.test(menuRec), JSON.stringify(menuRec));
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
check('dblclick on the Presentations folder opens fileman AT it (todos/0185)',
  row(section('desk4'), 'File Manager - /root/Desktop/Pr') !== '',
  JSON.stringify(section('desk4')));

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
  check('menu search launch takes the same activate path (winbox +1)',
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
    // Cell 0 is the Presentations DIR (0185): white tile + navy folder
    // glyph on teal, and NO black link notch (labels are white text).
    check('icon cell 0 histogram: tile + glyph + ground (no notch on a dir)',
      white > 250 && navy > 100 && black === 0 && teal > 3000,
      JSON.stringify({ white, navy, black, teal }));
    // Cell 1 is calc, a symlink: the black launcher notch sits at the
    // tile's bottom-left (ix+2..7, iy+16..21).
    check('link notch on the calc symlink icon (cell 1)',
      String(px(46 + 4, 22 + 64 + 18)) === '0,0,0', px(46 + 4, 22 + 64 + 18));
    check('empty desktop area is pure teal', String(px(500, 400)) === '0,128,128', px(500, 400));
    // Folder glyph (todos/0185): cell 0 is the Presentations dir — tab +
    // body leave (ix+16, iy+6) WHITE where a launcher's solid block is
    // navy (cell 1 = calc); the folder body itself is navy.
    check('folder glyph distinct from launcher block (Presentations vs calc)',
      String(px(46 + 16, 22 + 6)) === '255,255,255' &&
      String(px(46 + 8, 22 + 12)) === '0,0,128' &&
      String(px(46 + 16, 22 + 64 + 6)) === '0,0,128',
      [px(46 + 16, 22 + 6), px(46 + 8, 22 + 12), px(46 + 16, 22 + 64 + 6)].join(' | '));
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
    // clock cell moved left of the 0101 Show Desktop sliver: left edge is
    // clock_left()=1024-14-45=965, digits drawn at cx+8=973.
    for (let y = 8; y < 20; y++) {
      for (let x = 973; x < 1010; x++) {
        const i = boff + (y * BW + x) * 3;
        if (bppm[i] === 0 && bppm[i + 1] === 0 && bppm[i + 2] === 0) clock++;
      }
    }
    check('clock digits present in the taskbar shot (black-pixel histogram)',
      clock >= 15, clock);
  }

  // The Start menu shot (todos/0098+0132 + follow-up): a gucOS branding band
  // down the left (x < SM_SIDE), then the column — with recents+pinned cleared
  // it is [Settings (row 0), Run... (row 1), All Programs (row 2, cascade
  // arrow)] with grooves, and the search box with its "Search" ghost at the
  // foot. Hover is -1 before the shot, so nothing is navy-highlighted.
  const mppm = COMMON.readFileBytes(ufs, '/root/m.ppm');
  const mhead = Buffer.from(mppm.subarray(0, 20)).toString('latin1');
  const mmm = /^P6\n(\d+) (\d+)\n255\n/.exec(mhead);
  check(`menu shot is a ${SM_W}x${SM_H} P6`,
    !!mmm && mmm[1] === String(SM_W) && mmm[2] === String(SM_H), mhead);
  if (mmm) {
    const moff = mhead.indexOf('255\n') + 4, MW = SM_W;
    const mpx = (x, y) =>
      Array.from(mppm.subarray(moff + (y * MW + x) * 3, moff + (y * MW + x) * 3 + 3));
    // the gucOS branding band: a blue gradient (blue channel high, red low)
    const band = mpx(10, Math.floor(SM_H / 2));
    check('gucOS branding band is a blue gradient down the left',
      band[2] > 60 && band[0] < 40, band);
    // All Programs is the BOTTOM row (row 2) and carries the cascade arrow at
    // the column's right edge
    const apY = SM_PAD + AP_ROW * SM_ROW_H;
    check('All Programs (bottom row) carries the cascade arrow',
      String(mpx(SM_W - 12, apY + 9)) === '0,0,0', mpx(SM_W - 12, apY + 9));
    let lBlack = 0;
    for (let y = apY; y < apY + SM_ROW_H; y++)
      for (let x = SM_SIDE + 8; x < SM_W - 14; x++)
        if (String(mpx(x, y)) === '0,0,0') lBlack++;
    check('All Programs label text present (bottom row)', lBlack >= 20, lBlack);
    // the fixed places sit in the column above it, rows 0-1 (Settings, Run...)
    let fBlack = 0;
    for (let y = SM_PAD; y < SM_PAD + 2 * SM_ROW_H; y++)
      for (let x = SM_SIDE + 8; x < SM_SIDE + 70; x++)
        if (String(mpx(x, y)) === '0,0,0') fBlack++;
    check('fixed places text present in the column (Settings / Run...)', fBlack >= 30, fBlack);
    // Sample clear of the "Search" ghost: the freetype glyphs (Phase C)
    // cover x up to ~SM_SIDE+45, where the old 5x7 left this spot blank.
    check('search box is a sunken white field',
      String(mpx(SM_SIDE + 150, SM_SEARCH_Y + 8)) === '255,255,255',
      mpx(SM_SIDE + 150, SM_SEARCH_Y + 8));
    let ghost = 0;
    for (let y = SM_SEARCH_Y; y < SM_SEARCH_Y + 20; y++)
      for (let x = SM_SIDE + 8; x < SM_SIDE + 60; x++)
        if (String(mpx(x, y)) === '128,128,128') ghost++;
    check('search box "Search" ghost text', ghost >= 8, ghost);
  }
}

// ---- Start menu v2 tail (todos/0098): the command path, live search, Esc
// clear-then-close, the RUN... place, the keyboard All Programs cascade —
// window counts as deltas.
{
  const s1 = section('sm1'), s2 = section('sm2'), s3 = section('sm3'),
        s4a = section('sm4a'), s4b = section('sm4b'), s4c = section('sm4c'),
        s5 = section('sm5'), s6 = section('sm6'),
        s7 = section('sm7'), s8 = section('sm8');
  const count = (sec, title) =>
    sec.split('\n').filter(l => l.endsWith('\t' + title)).length;
  check('wmctl menu with no WM was refused (the menu IS policy)',
    out.includes('menu-refused'));
  check('wmctl menu opens the single-column root (the chord path)',
    out.includes('menu-cmd-ok') && row(s1, 'startmenu') === '' && row(s2, 'startmenu') !== '',
    JSON.stringify(s2));
  check('live search + Enter launches the top hit (winbox +1)',
    out.includes('SEARCH-DELTA-1'), out.slice(out.indexOf('SEARCH-DELTA')).slice(0, 18));
  check('search shot written', out.includes('search-shot-ok'));
  check('Esc clears a non-empty search but keeps the menu open',
    row(s4a, 'startmenu') !== '' && row(s4b, 'startmenu') !== '',
    JSON.stringify([row(s4a, 'startmenu') !== '', row(s4b, 'startmenu') !== '']));
  check('a second Esc dismisses the menu', row(s4c, 'startmenu') === '',
    JSON.stringify(s4c));
  check('the Run... place (column row 1) opens the run dialog (240x70, above the bar)',
    row(s5, 'startrun').includes('240x70+6+664') && row(s5, 'startmenu') === '',
    JSON.stringify(s5));
  check('typed command + Enter launches it (sh -c winbox: +1) and closes the dialog',
    count(s6, 'winbox') === count(s5, 'winbox') + 1 && row(s6, 'startrun') === '',
    JSON.stringify([count(s5, 'winbox'), count(s6, 'winbox')]));
  // The 0259 menu-tree UNION red→green: with /etc/menu/Apps present the
  // tree flyout lists it ALONGSIDE the baked groups — pre-union,
  // first-existing-dir made /etc/menu shadow the ENTIRE baked tree, so
  // the flyout would have held ONLY Apps (h 22, one row) and this height
  // assert fails on the old wm.c.
  const s7g = (() => {
    const l = row(s7, 'startmenu2');
    const m = /(\d+)x(\d+)\+/.exec(l.split('\t')[2] || '');
    return m ? +m[2] : 0;
  })();
  check('keyboard Up+Right cascades the All Programs tree flyout, and the ' +
        'union lists /etc/menu Apps ALONGSIDE the baked groups (0259)',
    row(s7, 'startmenu2') !== '' && s7g === flyH(MENU_GROUPS.length + 1),
    JSON.stringify(s7));
  check('keyboard Right+Enter runs the nested launcher (winbox +1)',
    count(s8, 'winbox') === count(s7, 'winbox') + 1,
    JSON.stringify([count(s7, 'winbox'), count(s8, 'winbox')]));
  // ---- the 0259 depth-cap cure ----
  const d1 = section('deep1'), d2 = section('deep2');
  check('a 4-dir tree cascades to startmenu6 — past the old MENU_DEPTH-4 cap (0259)',
    row(d1, 'startmenu2') !== '' && row(d1, 'startmenu3') !== '' &&
    row(d1, 'startmenu4') !== '' && row(d1, 'startmenu5') !== '' &&
    row(d1, 'startmenu6') !== '', JSON.stringify(d1));
  const d6 = row(d1, 'startmenu6'), d5 = row(d1, 'startmenu5');
  check('each deeper level advances x (a real cascade, not a re-park)',
    g4(d6) && g4(d5) && g4(d6).x > g4(d5).x, JSON.stringify([d5, d6]));
  check('Enter at depth 5 fires the leaf (winbox +1) and closes the chain',
    count(d2, 'winbox') === count(d1, 'winbox') + 1 &&
    row(d2, 'startmenu2') === '' && row(d2, 'startmenu6') === '',
    JSON.stringify(d2));
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
  const at = (name) => {                                    // pre-move cells
    const c = deskCell(DESK_ACT, name);
    return [name, c.col, c.row];
  };
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
    strip(p2b, ...at('fileman')) === NAVY && strip(p2b, ...at('gameboy')) === NAVY &&
    strip(p2b, ...at('mario')) === NAVY &&
    strip(p2b, ...at('alauncher')) === TEAL && strip(p2b, ...at('notepad')) === TEAL,
    [strip(p2b, ...at('doom')), strip(p2b, ...at('mario')), strip(p2b, ...at('notepad'))]);
  const p3 = readPpm('s3.ppm');
  check('marquee REPLACES with the intersected tiles (col 0 rows 0-2)',
    strip(p3, ...at('Presentations')) === NAVY && strip(p3, ...at('alauncher')) === NAVY &&
    strip(p3, ...at('calc')) === NAVY && strip(p3, ...at('ctlpanel')) === TEAL &&
    strip(p3, ...at('gameboy')) === TEAL && strip(p3, ...at('mario')) === TEAL,
    [strip(p3, ...at('Presentations')), strip(p3, ...at('gameboy'))]);
  const icons = section('sel1');
  check('.icons persists the whole layout (term at 2,1; Presentations pinned 0,0)',
    icons.includes('2 1 term') && icons.includes('0 0 Presentations') &&
    icons.includes('0 1 alauncher'), icons);
  const termCell = deskCell(DESK_ACT, 'term');
  const p4 = readPpm('s4.ppm');
  check('drag-move relocated term to (2,1): tile there, old cell teal, still selected',
    p4(216, 88) === WHITE &&
    p4(termCell.x + 42, termCell.y + 18) === TEAL &&   // old cell, derived (todos/0166)
    strip(p4, 'term', 2, 1) === NAVY,
    [p4(216, 88), p4(termCell.x + 42, termCell.y + 18), strip(p4, 'term', 2, 1)]);
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

// ---- taskbar polish (todos/0101): the strip menu + Minimize All + Show
// Desktop + the clock date tooltip. The two fresh winboxes are the two
// highest sids; Minimize All / Show Desktop must move exactly those.
{
  const tp1 = section('tp1'), tp2 = section('tp2'), tp3 = section('tp3'),
        tp4 = section('tp4'), tp5 = section('tp5'), tp6 = section('tp6'),
        tp7 = section('tp7');
  const wsids = (sec) => sec.split('\n').filter(l => l.endsWith('\twinbox'))
    .map(l => parseInt(l)).sort((a, b) => a - b);
  const rowSid = (sec, sid) =>
    sec.split('\n').find(l => parseInt(l) === sid && l.endsWith('\twinbox')) || '';
  const flg = (sec, sid) => (rowSid(sec, sid).split('\t')[5] || '');
  const two = wsids(section('tp0')).slice(-2);   // the two fresh winboxes
  const [A, B] = two;
  // right-click the clock cell -> the taskbar-strip menu (Cascade, Tile,
  // Minimize All, sep, Properties -> h = 4 + 4*18 + 8 = 84 on the engine
  // rows, 0259; width measured), clamped right (x = 1024 - w) and above
  // the bar (y = 740 - 84 = 656).
  const cm = row(tp1, 'ctxmenu');
  const cmg = g4(cm);
  check('right-click the taskbar strip opens the menu (h 84, clamped above the bar)',
    cmg && cmg.h === 84 && cmg.x === 1024 - cmg.w && cmg.y === 740 - 84 &&
    cm.includes('b'), JSON.stringify(tp1));
  check('the strip menu rides the TOP layer like the bar',
    (cm.split('\t')[5] || '').includes('T'), cm);
  check('Minimize All minimizes both fresh winboxes and dismisses the menu',
    flg(tp2, A).includes('m') && flg(tp2, B).includes('m') && row(tp2, 'ctxmenu') === '',
    JSON.stringify([flg(tp2, A), flg(tp2, B), row(tp2, 'ctxmenu')]));
  check('Show Desktop click restores the minimized set',
    !flg(tp3, A).includes('m') && !flg(tp3, B).includes('m'),
    JSON.stringify([flg(tp3, A), flg(tp3, B)]));
  check('Show Desktop click again re-minimizes everything',
    flg(tp4, A).includes('m') && flg(tp4, B).includes('m'),
    JSON.stringify([flg(tp4, A), flg(tp4, B)]));
  // Cascade resizes every visible resizable window to the uniform 3/5 box
  // (1024*3/5 = 614, (768-28-28)*3/5 = 427) and diagonally offsets them.
  check('Cascade resizes the fresh winboxes to the uniform 614x427 box',
    geom(rowSid(tp5, A)).startsWith('614x427') && geom(rowSid(tp5, B)).startsWith('614x427'),
    JSON.stringify([geom(rowSid(tp5, A)), geom(rowSid(tp5, B))]));
  check('Cascade offsets them (the two boxes are at different origins)',
    geom(rowSid(tp5, A)) !== geom(rowSid(tp5, B)),
    JSON.stringify([geom(rowSid(tp5, A)), geom(rowSid(tp5, B))]));
  // the clock date tooltip: a click raises "datepop" (borderless, top layer,
  // DATE_W x DATE_H = 104x22, right-aligned above the bar: 768-28-22-4 = 714).
  const dp = row(tp6, 'datepop');
  check('a clock-cell click raises the datepop tooltip (104x22, above the bar)',
    dp.includes('104x22+920+714') && dp.includes('b'), JSON.stringify(tp6));
  check('datepop rides the TOP layer', (dp.split('\t')[5] || '').includes('T'), dp);
  check('datepop is shot-able (pixels live)', out.includes('date-shot-ok'));
  check('a second clock-cell click toggles the tooltip off',
    row(tp7, 'datepop') === '', JSON.stringify(tp7));
}

// ---- window system menu (todos/0102): Alt+Space / wmctl sysmenu, keyboard
// move (Enter commits / Esc reverts), keyboard size, Close via the menu ----
{
  const smB = section('smB'), smC = section('smC'), smD = section('smD'),
        smE = section('smE'), smF = section('smF'), smG = section('smG'),
        smH = section('smH'), smSize = section('smSize'),
        smFixPre = section('smFixPre'), smFix = section('smFix'),
        smClose = section('smClose');
  const swsid = parseInt((/swsid=(\d+)/.exec(out) || [])[1]);
  const sfsid = parseInt((/sfsid=(\d+)/.exec(out) || [])[1]);
  const rowSid = (sec, sid) => sec.split('\n').find(l => parseInt(l) === sid) || '';
  const xy = (line) => {
    const m = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(geom(line));
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  };
  check('wmctl sysmenu succeeds on the focused window', out.includes('sysmenu-ok'));
  check('sysmenu opens the popup (anchored at the window top-left)',
    row(smC, 'ctxmenu') !== '', JSON.stringify(smC));
  check('picking Move keeps the popup up as the key grabber',
    row(smD, 'ctxmenu') !== '', JSON.stringify(smD));
  const pre = xy(rowSid(smB, swsid)), moved = xy(rowSid(smE, swsid));
  check('Move + arrows relocate the window (+32 x, +16 y)',
    pre && moved && moved.x === pre.x + 32 && moved.y === pre.y + 16,
    JSON.stringify([pre, moved]));
  const committed = xy(rowSid(smF, swsid));
  check('Enter commits the move and dismisses the popup',
    row(smF, 'ctxmenu') === '' && committed &&
    committed.x === moved.x && committed.y === moved.y,
    JSON.stringify([committed, row(smF, 'ctxmenu')]));
  const midEsc = xy(rowSid(smG, swsid)), reverted = xy(rowSid(smH, swsid));
  check('mid-mode arrows nudge (-24 x) before Esc',
    midEsc && committed && midEsc.x === committed.x - 24,
    JSON.stringify([committed, midEsc]));
  check('Esc reverts to the pre-mode position and dismisses',
    row(smH, 'ctxmenu') === '' && reverted && committed &&
    reverted.x === committed.x && reverted.y === committed.y,
    JSON.stringify([committed, reverted]));
  const sized = xy(rowSid(smSize, swsid));
  check('Size grows the resizable winbox (+32 w, +32 h)',
    sized && pre && sized.w === pre.w + 32 && sized.h === pre.h + 32,
    JSON.stringify([pre, sized]));
  const fixPre = xy(rowSid(smFixPre, sfsid)), fixPost = xy(rowSid(smFix, sfsid));
  check('Size is disabled on the fixed-size fixbox (gray row: click + arrows are no-ops)',
    row(smFix, 'ctxmenu') !== '' && fixPre && fixPost &&
    fixPre.w === fixPost.w && fixPre.h === fixPost.h &&
    fixPre.x === fixPost.x && fixPre.y === fixPost.y,
    JSON.stringify([fixPre, fixPost, row(smFix, 'ctxmenu') !== '']));
  check('Close via the sysmenu tears the window down',
    rowSid(smClose, swsid) === '', JSON.stringify(
      smClose.split('\n').filter(l => l.endsWith('\twinbox'))));
}

// ---- desktop icon rename-in-place (todos/0103) ----
{
  const names = (name) => section(name).trim().split(/\s+/);
  const rn0 = names('rn0'), rn2 = names('rn2'), rn3 = names('rn3'),
        rn4 = names('rn4'), rn6 = names('rn6');
  check('baseline: aaa + aab seeded on the desktop',
    rn0.includes('aaa') && rn0.includes('aab'), JSON.stringify(rn0));
  check('F2 + typed name + Enter renames the icon (aaa -> zzz)',
    !rn2.includes('aaa') && rn2.includes('zzz'), JSON.stringify(rn2));
  check('rename onto an existing name keeps both files (EEXIST)',
    rn3.includes('aab') && rn3.includes('zzz'), JSON.stringify(rn3));
  check('Esc leaves the file untouched (no partial "aabz")',
    rn4.includes('aab') && !rn4.includes('aabz'), JSON.stringify(rn4));
  check('icon-menu Rename renames via the inline editor (aab -> mmm)',
    !rn6.includes('aab') && rn6.includes('mmm'), JSON.stringify(rn6));
}

// ---- long/spaced Desktop-icon launch (todos/0151): the menu_ent.name[32]
// truncation regression. Both a short spaced name and a 36-char spaced name
// must launch on double-click; pre-fix the long one truncated and stat()'d a
// path that didn't exist, so nothing spawned. ----
{
  const ln0 = section('ln0').trim();
  check('both launchers are present on the desktop (long name not lost)',
    ln0.includes('My App') &&
    ln0.includes('My Really Long Application Name Here'), JSON.stringify(ln0));
  check('short spaced Desktop name launches on dblclick (winbox +1)',
    out.includes('LN-SHORT-DELTA-1'),
    (out.match(/LN-SHORT-DELTA-\S*/) || ['(none)'])[0]);
  check('36-char spaced Desktop name launches on dblclick (winbox +1) — no name[32] truncation',
    out.includes('LN-LONG-DELTA-1'),
    (out.match(/LN-LONG-DELTA-\S*/) || ['(none)'])[0]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nwm service e2e: ${failures} FAILED` : '\nwm service e2e: PASS');
process.exit(failures ? 1 : 0);
