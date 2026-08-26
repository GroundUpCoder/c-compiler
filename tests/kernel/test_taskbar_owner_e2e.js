#!/usr/bin/env node
// #740 acceptance: the taskbar / window-cycle contract keys on OWNERSHIP,
// not on a window class name.
//
// `WMP_F_TRANSIENT` (os/wm_proto.h) means "a framed, focusable modal that
// Win95 never lists in the taskbar" — /bin/wm keeps such a surface out of
// `wins[]`, so it gets no taskbar button and cycle/cascade/tile/minimize-all
// all skip it. user32 used to decide that by asking whether the window class
// was "#32770", which conflates "is of the dialog class" with "is an owned
// modal". The two diverge in BOTH directions, and both directions ship:
//
//   - calc's MAIN window is an UNOWNED "#32770" (vendor/calc/winmain.c:1986
//     CreateDialog(..., NULL, DlgMainProc)) — it lost its taskbar button and
//     was unrecoverable once another window covered it. That leg lives in
//     tests/kernel/test_calc_e2e.js, on the real shipped app.
//   - sedit's Find/Goto and comdlg32's Open/Find/Font dialogs are OWNED but
//     are not of that class — they wrongly gained taskbar buttons.
//
// This file pins the RULE itself, on a fixture whose four top-level windows
// all share ONE window class, so nothing here can be passing for the old
// reason. The rule (os/win32/user32.c, create_window_impl):
//
//   WS_EX_APPWINDOW       -> listed, even when owned
//   else owner != NULL    -> not listed
//   else WS_EX_TOOLWINDOW -> not listed
//   else                  -> listed
//
// Run: node tests/kernel/test_taskbar_owner_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function section(out, name) {
  return (String(out).split('==' + name + '\n')[1] || '').split('==cut')[0];
}
// `wmctl list` row for an exact title -> { sid, flags }
function row(listOut, title) {
  for (const line of String(listOut).split('\n')) {
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[6] === title) return { sid: +cols[0], flags: cols[5] };
  }
  return null;
}
// the focused row's title, or null
function focused(listOut) {
  for (const line of String(listOut).split('\n')) {
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[5][0] === 'f') return cols[6];
  }
  return null;
}

const { dir, image } = freshImage('tbown-');

// ---- build + inject the fixture (the oomdlg/menubox pattern: seed a boot
// first so the root volume exists, then write the compiled wasm into it) ----
driveBoot('echo seeded', { image });
const wasm = COMMON.buildProject(CompilerJS,
  'tests/kernel/fixtures/tbown/bin.json',
  (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'));
{
  const rootImg = image.slice(0, -4) + '-root.img';     // boot.js pairing rule
  const store = new COMMON.NodeFileStore(fs, rootImg, false);
  const rfs = BLOCK_FS.createV4(store);
  const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
  const fd = rfs.open('/root/tbown', O_WRONLY | O_CREAT | O_TRUNC, 0o755);
  if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
  rfs.write(fd, wasm, wasm.length);
  rfs.close(fd);
  store.close();
}

// Six cycles is more than the four fixture windows: whatever the LRU order
// is, every window /bin/wm is willing to cycle to has been visited.
const CYCLES = 6;
const cycleScript = [];
for (let i = 0; i < CYCLES; i++) {
  cycleScript.push('wmctl cycle',
                   'echo ==cyc' + i, 'wmctl list', 'echo ==cut');
}

const r = driveBoot([
  '/root/tbown &',
  // Boot barrier (todos/0154): the LAST window created resolving in the
  // window list means all four are up and the app is pumping messages.
  'wmctl wait win tb-appwin 20000',
  'echo ==l1',
  'wmctl list',
  'echo ==cut',
  ...cycleScript,
  'exit',
  '',
].join('\n'), { image, timeout: 600000, maxBuffer: 64 * 1024 * 1024 });

const out = r.stdout;
const l1 = section(out, 'l1');

for (const [title, listed, why] of [
  ['tb-main',   true,  'unowned, no ex-style -> an ordinary app window'],
  ['tb-owned',  false, 'OWNED -> an owned secondary window is never listed'],
  ['tb-tool',   false, 'WS_EX_TOOLWINDOW -> a floating palette is never listed'],
  ['tb-appwin', true,  'WS_EX_APPWINDOW overrides ownership'],
]) {
  const rec = row(l1, title);
  check(title + ': surface exists', !!rec, l1);
  if (!rec) continue;
  const isTransient = rec.flags.includes('U');
  check(title + ': ' + (listed ? 'no' : 'the') + ' WMP_F_TRANSIENT flag (' + why + ')',
        isTransient === !listed, 'FLAGS=' + rec.flags);
}

// The policy consequence, read directly off /bin/wm's wins[]: a transient
// surface is skipped by the window cycle. Pre-#740 all four were cycled to.
const visited = new Set();
for (let i = 0; i < CYCLES; i++) {
  const f = focused(section(out, 'cyc' + i));
  if (f) visited.add(f);
}
check('cycle reaches the unowned app window', visited.has('tb-main'),
      [...visited].join(' | '));
check('cycle reaches the WS_EX_APPWINDOW window', visited.has('tb-appwin'),
      [...visited].join(' | '));
check('cycle NEVER reaches the owned window', !visited.has('tb-owned'),
      [...visited].join(' | '));
check('cycle NEVER reaches the tool window', !visited.has('tb-tool'),
      [...visited].join(' | '));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? '\nFAILURES: ' + failures : '\nall ok');
process.exit(failures ? 1 : 0);
