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

// The baked /usr/share/menu (os/image.json), sorted the way load_entries
// sorts. Geometry mirrors os/wm.c: MENU_W 150, rows 20px, 4px pad, parked
// above the 28px taskbar on the 1024x768 headless screen. Bump the list
// when image.json gains a menu entry; everything below derives from it.
const MENU_ENTRIES = ['calc', 'ctldemo', 'doom', 'fileman', 'gameboy', 'gdidemo',
                      'gpubox', 'notepad', 'quake', 'snake', 'term', 'winbox', 'winmine'];
const MENU_H = 2 * 4 + MENU_ENTRIES.length * 20;
const MENU_GEOM = `150x${MENU_H}+0+${768 - 28 - MENU_H}`;
const winboxRowY = 4 + MENU_ENTRIES.indexOf('winbox') * 20 + 10;

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
  'echo ==list4',
  'wmctl list',                                  // endpoint is the KERNEL's: still up
  'wm &',                                        // respawn
  'sleep 2.5',
  'echo ==list5',
  'wmctl list',
  'TSID=$(wmctl list | grep taskbar$ | sed "s/[^0-9].*//")',   // new wm, new sid
  // ---- the Start menu (todos/0028) ----
  'wmctl click $TSID 25 14',                     // Start button (x < 50)
  'sleep 0.5',
  'echo ==menu1',
  'wmctl list',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  `wmctl click $MSID 20 ${winboxRowY}`,          // the winbox entry (sorted)
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
  // (shebang exec, todos/0065), a plain text file opens in `term vi`,
  // symlinks keep running their target (the desk3 leg above). ----
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
  'sleep 4',                                     // term loads freetype
  'echo ==act3',
  'wmctl list',
  // The seeded snake entry became a real launcher script (image v36).
  'head -c 2 /usr/share/menu/snake && echo =snake-shebang',
  // The menu takes the same path: an /etc/menu override dir with ONE
  // launcher-script entry (the dir existing wins, todos/0040).
  'mkdir /etc/menu',
  "printf '#!/bin/sh\\nwinbox\\n' > /etc/menu/go",
  'wmctl click $TSID 25 14',                     // Start
  'sleep 0.5',
  'MSID=$(wmctl list | grep startmenu$ | sed "s/[^0-9].*//")',
  'wmctl click $MSID 20 14',                     // entry 0 (the only one)
  'sleep 3',
  'echo ==act4',
  'wmctl list',
  'rm -rf /etc/menu',
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
      m1 = section('menu1'), m2 = section('menu2'), m3 = section('menu3'),
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
  win1.includes('\tf---R\t'), win1);

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

// ---- the Start menu (todos/0028) ----
const menu1 = row(m1, 'startmenu');
check(`Start click opens the menu: borderless surface above the taskbar (${MENU_GEOM} — ${MENU_ENTRIES.length} entries)`,
  menu1.includes(MENU_GEOM) && menu1.includes('b'), JSON.stringify(m1));
check('menu entry click launches winbox (second instance)',
  m2.split('\n').filter(l => l.endsWith('\twinbox')).length === 2, JSON.stringify(m2));
check('selection dismissed the menu', row(m2, 'startmenu') === '', JSON.stringify(m2));
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
// files open in the viewer. Window-count deltas cross-check the peek: if
// is_runnable() misfired, the launcher would open in vi (term, not
// winbox) and notes.txt would fail to spawn (no term).
{
  const count = (sec, title) =>
    sec.split('\n').filter(l => l.endsWith('\t' + title)).length;
  check('desktop dblclick on a #!/bin/sh launcher runs it (winbox +1)',
    count(a2, 'winbox') === count(a1, 'winbox') + 1,
    JSON.stringify([count(a1, 'winbox'), count(a2, 'winbox')]));
  check('desktop dblclick on plain text still opens the viewer (term +1)',
    count(a3, 'term') === count(a2, 'term') + 1,
    JSON.stringify([count(a2, 'term'), count(a3, 'term')]));
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
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nwm service e2e: ${failures} FAILED` : '\nwm service e2e: PASS');
process.exit(failures ? 1 : 0);
