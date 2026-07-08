#!/usr/bin/env node
// 0014 acceptance, headless: the REAL /bin/wm + /bin/wmctl (compiled from
// os/wm.c / os/wmctl.c at seed time), driven through os/boot.js the way an
// agent would drive it. Covers: wm autostart (kernel service), taskbar as a
// borderless surface parked at the bottom edge, the wm's placement policy
// (not the kernel cascade), wmctl list/min/click/shot/focus, taskbar-click
// restore (injected through the real input ring into the wm's SDL loop),
// and the crashed-WM story — kill the wm, the system stays driveable
// (kernel-chrome fallback + kernel-owned endpoint), `wm &` respawns it.
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
  'kill $WMPID',                                 // crash the WM
  'sleep 0.5',
  'echo ==list4',
  'wmctl list',                                  // endpoint is the KERNEL's: still up
  'wm &',                                        // respawn
  'sleep 2.5',
  'echo ==list5',
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
      l4 = section('list4'), l5 = section('list5'), l6 = section('list6');
const row = (sec, title) =>
  sec.split('\n').find(l => l.endsWith('\t' + title)) || '';

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

// ---- crashed-WM story ----
check('WM killed: taskbar gone, endpoint still serves wmctl',
  row(l4, 'taskbar') === '' && row(l4, 'winbox') !== '', JSON.stringify(l4));
const bar5 = row(l5, 'taskbar');
check('wm & respawns: taskbar back at the bottom edge',
  bar5.includes('1024x28+0+740'), JSON.stringify(l5));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nwm service e2e: ${failures} FAILED` : '\nwm service e2e: PASS');
process.exit(failures ? 1 : 0);
