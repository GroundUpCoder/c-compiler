#!/usr/bin/env node
// 0014 acceptance, headless: the REAL /bin/wm + /bin/wmctl (compiled from
// os/wm.c / os/wmctl.c at seed time), driven through os/boot.js the way an
// agent would drive it. Covers: wm autostart (kernel service), taskbar as a
// borderless surface parked at the bottom edge, the wm's placement policy
// (not the kernel cascade), wmctl list/min/click/shot/focus, taskbar-click
// restore (injected through the real input ring into the wm's SDL loop),
// wmctl max maximize/restore on both branches of the resizable dispatch
// (todos/0025), and the crashed-WM story — kill the wm, the system stays
// driveable (kernel-chrome fallback + kernel-owned endpoint), `wm &`
// respawns it.
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
  'wmctl click $MSID 20 134',                    // entry 6 = winbox (sorted)
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
  'wmctl click $DSID 58 112',                    // SINGLE click icon 1 (gameboy)
  'sleep 2.5',                                   // would-be spawn time
  'echo ==desk2',
  'wmctl list',
  'wmctl dblclick $DSID 58 240',                 // double-click icon 3 (term)
  'sleep 4',                                     // term loads freetype
  'echo ==desk3',
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
      m1 = section('menu1'), m2 = section('menu2'), m3 = section('menu3'),
      m4 = section('menu4'),
      d1 = section('desk1'), d2 = section('desk2'), d3 = section('desk3');
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
check('Start click opens the menu: borderless surface above the taskbar (150x148+0+592 — 7 entries)',
  menu1.includes('150x148+0+592') && menu1.includes('b'), JSON.stringify(m1));
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

// Icon pixels: read the shot back OUT of the user volume (0026 split) and
// histogram icon cell 0 (doom at 16,16): white tile, navy center, black
// link notch on the teal ground.
{
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const bytes = fs.readFileSync(path.join(tmp, 'os-user.img'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  // /root strips to / inside the user volume (mount-prefix routing, 0026).
  const ppm = COMMON.readFileBytes(ufs, '/d.ppm');
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
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nwm service e2e: ${failures} FAILED` : '\nwm service e2e: PASS');
process.exit(failures ? 1 : 0);
