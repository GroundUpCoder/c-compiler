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
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-ctlpanel-');

function boot(script) {
  return driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 }).stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

// The hub and each applet are real top-level WM windows, and the volume STATIC
// is agent-queryable, so every sleep converts to a window/text wait (todos/0154)
// — except the WM_TIMER clock tick, which is genuinely waiting for a wall-clock
// second to pass (a timing subject, 0083 rule). Config writes land in a file
// after the WM_COMMAND, so poll the file for the expected state.
const waitFileHas = (p, re) =>
  `for i in $(seq 1 120); do grep -q "${re}" ${p} 2>/dev/null && break; sleep 0.05; done`;

const out = boot([
  'ctlpanel &',
  // Boot barrier: the "Sound" applet icon resolving means the hub is up + serving
  // (and listed for the SID grep).
  'wmctl wait label Sound 10000',
  'HSID=$(wmctl list | grep "Control Panel$" | sed "s/[^0-9].*//")',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // single-click activation: one agent click opens the Sound applet
  'wmctl click Sound',
  'wmctl wait win "Sound Properties" 6000',
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  // the 0048 volume drive, unchanged: step down, absolute set, step up — wait
  // for each result to land in the volume STATIC.
  'wmctl click "Vol -"',
  'wmctl wait text STATIC:0 "90%" 4000',
  'echo ==v1',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  'wmctl settext EDIT:0 55',
  'wmctl click Set',
  'wmctl wait text STATIC:0 "55%" 4000',
  'echo ==v2',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  'wmctl click "Vol +"',
  'wmctl wait text STATIC:0 "65%" 4000',
  'echo ==v3',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // per-window close (0089): closing the applet leaves the hub alive
  'SSID=$(wmctl list | grep "Sound Properties$" | sed "s/[^0-9].*//")',
  'wmctl close $SSID',
  'wmctl wait nowin "Sound Properties" 6000',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  // reopen: the applet re-reads KERNEL state (65%)
  'wmctl click Sound',
  'wmctl wait win "Sound Properties" 6000',
  'wmctl wait text STATIC:0 "65%" 4000',
  'echo ==v3b',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // keyboard on the hub: Right, Right selects System (Sounds sits between
  // Sound and System since 0094), Enter opens it
  'wmctl key $HSID 79 1073741903',
  'wmctl key $HSID 79 1073741903',
  'wmctl key $HSID 40 13',
  'wmctl wait win "System Properties" 6000',
  'echo ==tree3',
  'wmctl tree',
  'echo ==cut',
  // Display stub + Date/Time (WM_TIMER clock)
  'wmctl click Display',
  'wmctl wait win "Display Properties" 6000',
  'wmctl click "Date/Time"',
  'wmctl wait win "Date/Time Properties" 6000',
  'echo ==tree4',
  'wmctl tree',
  'echo ==cut',
  'sleep 1.5',                              // let the WM_TIMER clock advance a real second (genuine timing subject)
  'echo ==tree5',
  'wmctl tree',
  'echo ==cut',
  // the Display applet (hires-display): density radios delta-write `zoom`
  // to ~/.config/display (the Sounds mute-key pattern) — the browser side
  // of the bridge (worker watch -> page reflow) lives in os-hires.mjs.
  'wmctl click "Densest (0.5x)"',
  waitFileHas('/root/.config/display', 'zoom.0.5'),
  'echo ==dp1',
  'cat /root/.config/display',
  'echo ==cut',
  'wmctl click "Automatic (default)"',
  waitFileHas('/root/.config/display', 'zoom.auto'),
  'echo ==dp2',
  'cat /root/.config/display',
  'echo ==cut',
  // the Sounds applet (0094): the event-scheme mute toggle writes just the
  // mute key to ~/.config/sounds (CS3 cfgstore delta — baked events keep
  // reaching through the per-key overlay)
  'wmctl click Sounds',
  'wmctl wait win "Sounds Properties" 6000',
  'echo ==tree6',
  'wmctl tree',
  'echo ==cut',
  'wmctl click "Enable event sounds"',   // uncheck -> mute on
  waitFileHas('/root/.config/sounds', 'mute.on'),
  'echo ==snd1',
  'cat /root/.config/sounds',
  'echo ==cut',
  'wmctl click "Enable event sounds"',   // recheck -> mute off
  waitFileHas('/root/.config/sounds', 'mute.off'),
  'echo ==snd2',
  'cat /root/.config/sounds',
  'echo ==cut',
  'wmctl click Test',   // plays SystemDefault (mixer asserts live in test_sounds_e2e); nothing here asserts it
  // the Network applet (ticket #349, os/netcfg.h): the HTTP-bridge switch —
  // checkbox and Apply URL delta-write the `net` store (the Sounds mute-key
  // pattern). The kernel side of the live toggle AND the Test Bridge
  // round-trip live in test_netbridge_e2e (Test needs a running bridge,
  // which that test owns; no bridge runs in this boot).
  'wmctl click Network',
  'wmctl wait win "Network Properties" 6000',
  'echo ==nettree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click "Enable HTTP bridge"',    // check -> bridge on
  waitFileHas('/root/.config/net', 'bridge.on'),
  'echo ==net1',
  'cat /root/.config/net',
  'echo ==cut',
  'wmctl click "Apply URL"',             // default URL text is valid -> url key
  waitFileHas('/root/.config/net', 'url.http'),
  'wmctl click "Enable HTTP bridge"',    // uncheck -> bridge off
  waitFileHas('/root/.config/net', 'bridge.off'),
  'echo ==net2',
  'cat /root/.config/net',
  'echo ==cut',
  'NSID=$(wmctl list | grep "Network Properties$" | sed "s/[^0-9].*//")',
  'wmctl close $NSID',
  'wmctl wait nowin "Network Properties" 6000',
  // the Default Programs applet (todos/0338 + todos/0130's picker leg): the
  // COMMAND half — which implementation a dispatched name runs. This image
  // is the FAT fixture, so micropython is folded and its `commands` claim
  // sits ahead of the baked cpython-clang suggestion in /usr/share/cmdalt.
  'wmctl click "Default Programs"',
  'wmctl wait win "Default Programs" 6000',
  'DSID=$(wmctl list | grep "Default Programs" | sed "s/[^0-9].*//")',
  'echo ==dpg1',
  'wmctl tree',
  'echo ==cut',
  'echo ==dpgkeys',
  'wmctl gettext LISTBOX:0',
  'echo ==cut',
  'echo ==dpgcand',
  'wmctl gettext LISTBOX:1',
  'echo ==cut',
  // pick the SECOND candidate (the baked cpython-clang suggestion) — click
  // focuses the candidate list, HOME/DOWN move the caret (the fileman
  // row-selection idiom; no row-height pixel math)
  'wmctl click $DSID 374 60',
  'wmctl key $DSID 74 1073741898',          // HOME -> row 0
  'wmctl key $DSID 81 1073741905',          // DOWN -> row 1
  'echo ==dpgcand2',
  'wmctl gettext LISTBOX:1',
  'echo ==cut',
  'wmctl click "Set as default"',
  waitFileHas('/root/.config/cmdalt', 'python.cpython-clang'),
  'echo ==dpgset',
  'cat /root/.config/cmdalt',
  'echo ==cut',
  // the GUI wrote the store the CLI reads — one store, two editors
  'echo ==dpgwhich',
  'cmdalt which python 2>&1; echo RC=$?',
  'echo ==cut',
  // the shadow warning row: plant an earlier-PATH python, then make the
  // applet re-read the store (Use default triggers a full resync)
  "printf '#!/bin/sh\\necho shadow\\n' > /usr/local/bin/python",
  'chmod 755 /usr/local/bin/python',
  'wmctl click "Use default"',
  'echo ==dpgreset',
  'cat /root/.config/cmdalt',
  'echo ==cut',
  'echo ==dpg2',
  'wmctl tree',
  'echo ==cut',
  'rm -f /usr/local/bin/python',
  // hub close = the whole panel quits (all applet windows mid-flight)
  'wmctl close $HSID',
  'wmctl wait nowin "Control Panel" 6000',   // process exit tears down every applet surface too
  'echo ==list3',
  'wmctl list',
  'echo ==cut',
  // the gain is KERNEL state: a second ctlpanel process sees it
  'ctlpanel &',
  'wmctl wait label Sound 10000',
  'wmctl click Sound',
  'wmctl wait win "Sound Properties" 6000',
  'wmctl wait text STATIC:0 "65%" 4000',
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

// -- Display applet (density picker) + Date/Time clock --
const tree4 = section(out, 'tree4');
check('Display applet opens with the density radios (+ the 0049 wallpaper note)',
  /class=CplDisplay [^\n]*text='Display Properties'/.test(tree4) &&
  /text='Automatic \(default\)'/.test(tree4) &&
  /text='Native \(1x\)'/.test(tree4) &&
  /text='Densest \(0\.5x\)'/.test(tree4) &&
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
check('the user store is a pure override delta (CS3: no baked-table snapshot)',
  !/SystemStart/.test(snd1) && !/SystemHand/.test(snd1), snd1);
const snd2 = section(out, 'snd2');
check('rechecking flips it to mute off',
  /^mute\toff$/m.test(snd2) && !/^mute\ton$/m.test(snd2), snd2);

// -- Display applet: density radios write the display cfgstore --
const dp1 = section(out, 'dp1');
check('Densest (0.5x) delta-writes zoom 0.5 to ~/.config/display',
  /^zoom\t0\.5$/m.test(dp1), dp1);
const dp2 = section(out, 'dp2');
check('Automatic writes an explicit zoom auto (replacing, not appending)',
  /^zoom\tauto$/m.test(dp2) && !/0\.5/.test(dp2), dp2);

// -- Default Programs (todos/0338 + the 0130 picker leg) --
const dpg1 = section(out, 'dpg1');
check('Default Programs applet opens with both lists and the buttons',
  /class=CplDefProg [^\n]*text='Default Programs'/.test(dpg1) &&
  /text='Commands'/.test(dpg1) && /text='Implementations'/.test(dpg1) &&
  /text='Set as default'/.test(dpg1) && /text='Use default'/.test(dpg1),
  dpg1.slice(0, 900));
const dpgkeys = section(out, 'dpgkeys');
check('the commands list shows the python key and its effective value',
  /^> python -> \/bin\/micropython$/m.test(dpgkeys), JSON.stringify(dpgkeys));
const dpgcand = section(out, 'dpgcand');
check('the candidate list shows the folded claim first, installed',
  /^> \/bin\/micropython - \/bin\/micropython$/m.test(dpgcand), JSON.stringify(dpgcand));
check('...and the baked suggestion, marked not installed',
  /^cpython-clang - not installed$/m.test(dpgcand), JSON.stringify(dpgcand));
check('the effective line names the resolved program',
  /text='python runs: \/bin\/micropython'/.test(dpg1), dpg1.slice(0, 900));
check('HOME+DOWN moves the candidate selection to cpython-clang',
  /^> cpython-clang - not installed$/m.test(section(out, 'dpgcand2')),
  JSON.stringify(section(out, 'dpgcand2')));
check('Set as default delta-writes just that key to ~/.config/cmdalt',
  section(out, 'dpgset').trim() === 'python\tcpython-clang',
  JSON.stringify(section(out, 'dpgset')));
const dpgwhich = section(out, 'dpgwhich');
check('the CLI reads the GUI pick back (which reports it unresolved)',
  /RC=1/.test(dpgwhich) && /available: \/bin\/micropython/.test(dpgwhich),
  JSON.stringify(dpgwhich));
check('Use default drops the user pick (cfg_unset, no tombstone)',
  !/python/.test(section(out, 'dpgreset')), JSON.stringify(section(out, 'dpgreset')));
const dpg2 = section(out, 'dpg2');
check('a shadowing /usr/local/bin/python raises the warning row',
  /text='Warning: \/usr\/local\/bin\/python shadows this setting[^']*'/.test(dpg2),
  (dpg2.match(/text='Warning[^']*'/) || ['(no warning row)'])[0]);

// -- Network applet (ticket #349): the HTTP-bridge switch --
const nettree = section(out, 'nettree');
check('Network applet opens: checkbox, URL edit + buttons, honest run-it-yourself copy',
  /class=CplNetwork [^\n]*text='Network Properties'/.test(nettree) &&
  /text='Enable HTTP bridge'/.test(nettree) &&
  /text='Apply URL'/.test(nettree) && /text='Test Bridge'/.test(nettree) &&
  /text='http:\/\/127\.0\.0\.1:8199'/.test(nettree) &&
  /node tools\/net-bridge\.js/.test(nettree), nettree.slice(0, 1200));
check('checkbox check delta-writes bridge on to ~/.config/net',
  /bridge[ \t]+on/.test(section(out, 'net1')), JSON.stringify(section(out, 'net1')));
const net2 = section(out, 'net2');
check('Apply URL writes the url key; uncheck flips bridge off (per-key deltas)',
  /bridge[ \t]+off/.test(net2) && /url[ \t]+http:\/\/127\.0\.0\.1:8199/.test(net2),
  JSON.stringify(net2));

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
