#!/usr/bin/env node
// 0048 + 0089 acceptance, headless: /bin/ctlpanel (the control panel).
//
// 0089 shape: the main window is an applet-icon HUB (Win95 Control Panel
// folder — CplIcon children, single-click activation); each applet is its
// own sibling top-level window. This extends the 0048 e2e rather than
// replacing it: the AUDIO_GAIN volume drive (buttons/EDIT absolute set,
// kernel-state persistence across processes) runs exactly as before, just
// inside the Sound applet. New legs: per-window close (the 0089
// SDL_EVENT_WINDOW_CLOSE_REQUESTED veneer growth — closing an applet
// leaves the hub alive), keyboard hub navigation (arrows + Enter), the
// System/Display/Date/Time applets, and WM_TIMER's live clock.
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
  'HSID=$(wmctl list | grep "Control Panel$" | sed "s/[^0-9].*//")',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // single-click activation: one agent click opens the Sound applet
  'wmctl click Sound',
  'sleep 1',
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  // the 0048 volume drive, unchanged: step down, absolute set, step up
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
  // per-window close (0089): closing the applet leaves the hub alive
  'SSID=$(wmctl list | grep "Sound Properties$" | sed "s/[^0-9].*//")',
  'wmctl close $SSID',
  'sleep 1',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  // reopen: the applet re-reads KERNEL state (65%)
  'wmctl click Sound',
  'sleep 1',
  'echo ==v3b',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // keyboard on the hub: Right, Right selects System (Sounds sits between
  // Sound and System since 0094), Enter opens it
  'wmctl key $HSID 79 1073741903',
  'wmctl key $HSID 79 1073741903',
  'wmctl key $HSID 40 13',
  'sleep 1',
  'echo ==tree3',
  'wmctl tree',
  'echo ==cut',
  // Display stub + Date/Time (WM_TIMER clock)
  'wmctl click Display',
  'wmctl click "Date/Time"',
  'sleep 1',
  'echo ==tree4',
  'wmctl tree',
  'echo ==cut',
  'sleep 1.5',
  'echo ==tree5',
  'wmctl tree',
  'echo ==cut',
  // the Sounds applet (0094): the event-scheme mute toggle writes
  // ~/.config/sounds with the baked table carried forward
  'wmctl click Sounds',
  'sleep 1',
  'echo ==tree6',
  'wmctl tree',
  'echo ==cut',
  'wmctl click "Enable event sounds"',   // uncheck -> mute on
  'sleep 0.5',
  'echo ==snd1',
  'cat /root/.config/sounds',
  'echo ==cut',
  'wmctl click "Enable event sounds"',   // recheck -> mute off
  'sleep 0.5',
  'echo ==snd2',
  'cat /root/.config/sounds',
  'echo ==cut',
  'wmctl click Test',   // plays SystemDefault (mixer asserts live in test_sounds_e2e)
  'sleep 0.5',
  // hub close = the whole panel quits (all applet windows mid-flight)
  'wmctl close $HSID',
  'sleep 1',
  'echo ==list3',
  'wmctl list',
  'echo ==cut',
  // the gain is KERNEL state: a second ctlpanel process sees it
  'ctlpanel &',
  'sleep 3',
  'wmctl click Sound',
  'sleep 1',
  'echo ==v4',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  '',
].join('\n'));

// -- the hub folder --
const tree1 = section(out, 'tree1');
check('hub comes up: class=CtlPanel + five applet icons',
  /class=CtlPanel [^\n]*text='Control Panel'/.test(tree1) &&
  /class=CplIcon [^\n]*text='Sound'/.test(tree1) &&
  /class=CplIcon [^\n]*text='Sounds'/.test(tree1) &&
  /class=CplIcon [^\n]*text='System'/.test(tree1) &&
  /class=CplIcon [^\n]*text='Display'/.test(tree1) &&
  /class=CplIcon [^\n]*text='Date\/Time'/.test(tree1), tree1.slice(0, 600));
check('no applet window open yet',
  !/CplSound |CplSndScheme|CplSystem|CplDisplay|CplDateTime/.test(tree1), tree1.slice(0, 600));

// -- Sound applet (0048 controls, lifted) --
const tree2 = section(out, 'tree2');
check('click Sound opens the Sound applet with the volume group',
  /class=CplSound [^\n]*text='Sound Properties'/.test(tree2) &&
  /text='Volume: 100%'/.test(tree2), tree2.slice(0, 800));
check('scrollbar + step buttons + Set present',
  /class=SCROLLBAR/.test(tree2) && /text='Vol -'/.test(tree2) &&
  /text='Vol \+'/.test(tree2) && /text='Set'/.test(tree2), tree2);

check('Vol - steps the kernel gain to 90%',
  section(out, 'v1').trim() === 'Volume: 90%', section(out, 'v1'));
check('EDIT + Set goes absolute (55%)',
  section(out, 'v2').trim() === 'Volume: 55%', section(out, 'v2'));
check('Vol + steps back up (65%)',
  section(out, 'v3').trim() === 'Volume: 65%', section(out, 'v3'));

// -- per-window close (0089) --
const list2 = section(out, 'list2');
check('closing the Sound applet leaves the hub alive',
  /Control Panel/.test(list2) && !/Sound Properties/.test(list2), list2);
check('reopened Sound applet reads the kernel gain (65%)',
  section(out, 'v3b').trim() === 'Volume: 65%', section(out, 'v3b'));

// -- keyboard nav: Right + Enter opens System --
const tree3 = section(out, 'tree3');
check('hub keyboard (Right, Enter) opens the System applet',
  /class=CplSystem [^\n]*text='System Properties'/.test(tree3), tree3.slice(0, 800));
check('System applet reads os-release + /proc/uptime',
  /NAME=gucOS/.test(tree3) && /VERSION_ID=/.test(tree3) && /UPTIME=/.test(tree3),
  tree3);

// -- Display stub + Date/Time clock --
const tree4 = section(out, 'tree4');
check('Display applet opens (the 0049 stub)',
  /class=CplDisplay [^\n]*text='Display Properties'/.test(tree4) &&
  /todos\/0049/.test(tree4), tree4.slice(0, 800));
const CLOCK_RE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
const clock1 = (section(out, 'tree4').match(CLOCK_RE) || [''])[0];
const clock2 = (section(out, 'tree5').match(CLOCK_RE) || [''])[0];
check('Date/Time applet shows a clock', CLOCK_RE.test(clock1), section(out, 'tree4').slice(0, 400));
check('the clock ticks (WM_TIMER)', clock2 !== '' && clock1 !== clock2,
  clock1 + ' -> ' + clock2);

// -- Sounds applet (0094): the event-scheme mute toggle --
const tree6 = section(out, 'tree6');
check('Sounds applet opens with the enable checkbox + Test',
  /class=CplSndScheme [^\n]*text='Sounds Properties'/.test(tree6) &&
  /text='Enable event sounds'/.test(tree6) && /text='Test'/.test(tree6),
  tree6.slice(0, 800));
const snd1 = section(out, 'snd1');
check('unchecking writes mute on to ~/.config/sounds',
  /^mute\ton$/m.test(snd1), snd1);
check('the baked table carries forward past the first write',
  /^SystemStart\t\/usr\/share\/sounds\/startup\.wav$/m.test(snd1) &&
  /^SystemHand\t\/usr\/share\/sounds\/chord\.wav$/m.test(snd1), snd1);
const snd2 = section(out, 'snd2');
check('rechecking flips it to mute off',
  /^mute\toff$/m.test(snd2) && !/^mute\ton$/m.test(snd2), snd2);

// -- hub close quits the whole panel --
const list3 = section(out, 'list3');
check('hub close quits the panel (all windows gone)',
  !/Control Panel|Properties/.test(list3), list3);

// -- kernel state across processes --
check('the gain is kernel state: a fresh ctlpanel reads 65%',
  section(out, 'v4').trim() === 'Volume: 65%', section(out, 'v4'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
