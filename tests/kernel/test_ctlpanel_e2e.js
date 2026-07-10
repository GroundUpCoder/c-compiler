#!/usr/bin/env node
// 0048 acceptance, headless: /bin/ctlpanel (the wave-1 control panel).
// Covers the AUDIO_GAIN path end to end — the app queries the kernel's
// master mixer gain through host.js's __audio_gain import, the buttons/
// EDIT set it (percent 0..200), and the value is KERNEL state: a second
// ctlpanel process sees what the first one set. (The mixing math itself
// is unit-tested in test_audio.js — this is the control-plane story.)
// Plus the system info panel: os-release + /proc/uptime, plain POSIX.
//
// Run: node tests/kernel/test_ctlpanel_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ctlpanel-'));
const image = path.join(tmp, 'os.img');

function boot(script) {
  const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r.stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

const out = boot([
  'ctlpanel &',
  'sleep 5',
  'SID=$(wmctl list | grep "Control Panel$" | sed "s/[^0-9].*//")',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // step down, absolute set, step up
  'wmctl click "Vol -"',
  'sleep 0.5',
  'echo ==v1',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  'wmctl settext EDIT:0 55',
  'wmctl click Set',
  'sleep 0.5',
  'echo ==v2',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  'wmctl click "Vol +"',
  'sleep 0.5',
  'echo ==v3',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // the gain is KERNEL state: a second panel sees it
  'wmctl close $SID',
  'sleep 1',
  'ctlpanel &',
  'sleep 5',
  'echo ==v4',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  '',
].join('\n'));

const tree1 = section(out, 'tree1');
check('control panel comes up with the volume group',
  /class=CtlPanel [^\n]*text='Control Panel'/.test(tree1) &&
  /text='Volume: 100%'/.test(tree1), tree1.slice(0, 400));
check('scrollbar + step buttons + Set present',
  /class=SCROLLBAR/.test(tree1) && /text='Vol -'/.test(tree1) &&
  /text='Vol \+'/.test(tree1) && /text='Set'/.test(tree1), tree1);
check('system panel reads os-release + /proc/uptime',
  /NAME=wasm-os/.test(tree1) && /VERSION_ID=/.test(tree1) && /UPTIME=/.test(tree1),
  tree1);

check('Vol - steps the kernel gain to 90%',
  section(out, 'v1').trim() === 'Volume: 90%', section(out, 'v1'));
check('EDIT + Set goes absolute (55%)',
  section(out, 'v2').trim() === 'Volume: 55%', section(out, 'v2'));
check('Vol + steps back up (65%)',
  section(out, 'v3').trim() === 'Volume: 65%', section(out, 'v3'));
check('the gain is kernel state: a fresh ctlpanel reads 65%',
  section(out, 'v4').trim() === 'Volume: 65%', section(out, 'v4'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
