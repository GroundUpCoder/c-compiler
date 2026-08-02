#!/usr/bin/env node
// Ticket #96 (todos/0432) acceptance, headless: paste legibility + robustness
// in the macOS scheme — the parts that hold under ANY keymap policy (the
// keymap itself is a CLOSED DECISION, todos/KEYMAP.md: no Ctrl edit verbs in
// the macos scheme; nothing here re-tests or re-opens it — that is
// test_keymap_e2e.js's job and it must stay green untouched).
//   - /run/host-platform: both boot paths persist the per-boot host verdict
//     ('mac' via --host-platform=mac, 'other' by default), every boot.
//   - the implicit host-native paste row (keys.h): on a Mac host, ⌘V is
//     KA_PASTE in EDIT|LIST regardless of the in-OS scheme — proven on the
//     stale-volume cell (a root whose /etc/keys never got the macos seed
//     runs the baked windows scheme; ⌘V must still paste), with NO scheme
//     flip and NO ~/.config/keys write.
//   - negative control: on a non-Mac host the implicit row does not exist —
//     ⌘V drops (the TranslateMessage GUI guard), exactly as before.
//   - the menu accel column tells the truth (menucore mc_accel_text): under
//     the windows scheme the drawn accel is 'Ctrl+V'; under macos it reads
//     'Cmd+V' — asserted through the agent tree's accel field, which reports
//     the DRAWN text (the one menucore choke), not the .rc model text.
//   - the ctlpanel Keyboard applet lists the effective chords per scheme and
//     the listing follows a scheme flip.
//
// Run: node tests/kernel/test_hostpaste_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Chord injection (the keymap-e2e pattern): scancodes v=25, mods LCTRL=64
// LGUI=1024.
const key = (sid, sc, sym, mod) =>
  `wmctl key ${sid} ${sc} ${sym}${mod ? ' ' + mod : ''}`;
const type = (sid, s) =>
  [...s].map((ch) => `wmctl key ${sid} 0 ${ch.charCodeAt(0)}`).join('\n');
const waitText = (label, s) =>
  `for i in $(seq 1 120); do wmctl gettext ${label} | grep -qx "${s}" && break; sleep 0.05; done`;

// Open the bar popup containing item $1 (the 0171 self-locating pattern).
const OPENPOPUP =
  'openpopup() { for x in 8 30 50 70 90 110 130 150 170 190 210; do ' +
  'wmctl click $SID $x 10; ' +
  'for t in 1 2 3 4 5 6; do wmctl gettext "$1" >/dev/null 2>&1 && return 0; sleep 0.05; done; ' +
  'wmctl key $SID 41 27; done; echo "POPUP-NOT-FOUND: $1"; return 1; }';

/* ---- session A: Mac host + STALE windows-scheme volume. The fresh boot
 * seeds /etc/keys (scheme macos); rm it BEFORE any app starts to recreate
 * the pre-v138 root: no scheme line anywhere -> the baked windows default.
 * ⌘V must paste via the implicit host row; ^V (the windows row) is the
 * positive control; nothing may flip the scheme or write user config. ---- */
function sessionStaleVolume() {
  const { dir: tmp, image } = freshImage('os-hostpaste-mac-');
  const out = driveBoot([
    'echo ==verdict',
    'cat /run/host-platform',
    'echo ==cut',
    'rm -f /etc/keys',                            // the stale-volume cell
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    'SID=$NSID',
    OPENPOPUP,
    // ⌘V pastes through the implicit host row (windows scheme active)
    'printf "IMPLICIT-96" | clip',
    'wmctl settext EDIT:0 ""',
    key('$NSID', 25, 118, 1024),                  // ⌘V
    'wmctl wait text EDIT:0 "IMPLICIT-96" 6000',
    'echo ==gui_paste',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // ^V still pastes (the windows scheme row — the implicit row adds, the
    // native row stays)
    'printf "CTRL-96" | clip',
    'wmctl settext EDIT:0 ""',
    key('$NSID', 25, 118, 64),                    // ^V
    'wmctl wait text EDIT:0 "CTRL-96" 6000',
    'echo ==ctrl_paste',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // no scheme flip, no user config write
    'echo ==keysfile',
    'cat /etc/keys 2>&1',
    'echo ==cut',
    'echo ==usercfg',
    'ls /root/.config/keys 2>&1',
    'echo ==cut',
    // the menu accel column under the windows scheme reads Ctrl+V
    'openpopup "Time/Date"',
    'echo ==accel_win',
    'wmctl tree | grep "text=.Paste."',
    'echo ==cut',
    'wmctl key $SID 41 27',
    'echo ==done',
    '',
  ].join('\n'), { image, args: ['--host-platform=mac'], maxBuffer: 32 * 1024 * 1024 },
  ).stdout;

  check('mac host: /run/host-platform records the verdict',
    section(out, 'verdict').trim() === 'mac', JSON.stringify(section(out, 'verdict')));
  check('stale windows-scheme volume: ⌘V pastes (the implicit host row)',
    section(out, 'gui_paste').trim() === 'IMPLICIT-96',
    JSON.stringify(section(out, 'gui_paste')));
  check('stale windows-scheme volume: ^V still pastes (native row intact)',
    section(out, 'ctrl_paste').trim() === 'CTRL-96',
    JSON.stringify(section(out, 'ctrl_paste')));
  check('no scheme flip: /etc/keys stays absent',
    /No such file/.test(section(out, 'keysfile')), JSON.stringify(section(out, 'keysfile')));
  check('no user config write: ~/.config/keys stays absent',
    /No such file/.test(section(out, 'usercfg')), JSON.stringify(section(out, 'usercfg')));
  check('windows scheme: the drawn menu accel is Ctrl+V (tree accel field)',
    /menuitem [^\n]*text='Paste'[^\n]*accel='Ctrl\+V'/.test(section(out, 'accel_win')),
    JSON.stringify(section(out, 'accel_win')));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---- session B: non-Mac host (the default boot) — the implicit row does
 * NOT exist. ⌘V must drop like any unbound ⌘chord: the sentinel slot stays
 * unpasted and no 'v' leaks into the EDIT. ---- */
function sessionOtherHost() {
  const { dir: tmp, image } = freshImage('os-hostpaste-other-');
  const out = driveBoot([
    'echo ==verdict',
    'cat /run/host-platform',
    'echo ==cut',
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    'printf "MUST-NOT-PASTE" | clip',
    'wmctl settext EDIT:0 "CLEAN"',
    key('$NSID', 25, 118, 1024),                  // ⌘V — unbound: must drop
    type('$NSID', '!'),                           // lands at the unmoved caret 0
    waitText('EDIT:0', '!CLEAN'),
    'echo ==guidrop',
    'wmctl gettext EDIT:0',
    'echo ==done',
    '',
  ].join('\n'), { image, maxBuffer: 32 * 1024 * 1024 },
  ).stdout;

  check('non-mac host: /run/host-platform records other',
    section(out, 'verdict').trim() === 'other', JSON.stringify(section(out, 'verdict')));
  check('non-mac host: ⌘V drops (no implicit row, no paste, no typed v)',
    section(out, 'guidrop').trim() === '!CLEAN', JSON.stringify(section(out, 'guidrop')));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---- session C: the macos-scheme legibility pair — the drawn menu accel
 * reads Cmd+V, and the ctlpanel Keyboard applet lists the effective chords
 * (Cmd row under macos; a Windows radio click flips the listing live). ---- */
function sessionMacScheme() {
  const { dir: tmp, image } = freshImage('os-hostpaste-legible-');
  const out = driveBoot([
    'printf "scheme\\tmacos\\n" > /etc/keys',
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'SID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    OPENPOPUP,
    'openpopup "Time/Date"',
    'echo ==accel_mac',
    'wmctl tree | grep "text=.Paste."',
    'echo ==cut',
    'wmctl key $SID 41 27',
    // the Keyboard applet's effective-chord listing
    'ctlpanel Keyboard &',
    'wmctl wait win "Keyboard Properties" 12000',
    'wmctl wait label "Terminal Paste" 8000',
    // the chord value statics — pinned to class=STATIC lines so notepad's
    // menu accel field (also Cmd+V) can never satisfy this assert
    'echo ==applet_mac',
    'wmctl tree | grep "class=STATIC" | grep "Cmd+V"',
    'echo ==cut',
    // flip to windows via the radio: the listing follows (kb_sync on write)
    'wmctl click "Windows (Ctrl)"',
    'for i in $(seq 1 100); do wmctl tree | grep "class=STATIC" | grep -q "Ctrl+Shift+V" && break; sleep 0.05; done',
    'echo ==applet_win',
    'wmctl tree | grep "class=STATIC" | grep "Ctrl+Shift+V"',
    'echo ==done',
    '',
  ].join('\n'), { image, maxBuffer: 32 * 1024 * 1024 },
  ).stdout;

  check('macos scheme: the drawn menu accel is Cmd+V (tree accel field)',
    /menuitem [^\n]*text='Paste'[^\n]*accel='Cmd\+V'/.test(section(out, 'accel_mac')),
    JSON.stringify(section(out, 'accel_mac')));
  check('applet lists the macos-scheme chords (Cmd+V)',
    /Cmd\+V/.test(section(out, 'applet_mac')), JSON.stringify(section(out, 'applet_mac')));
  check('a Windows radio click flips the listing live (Ctrl+Shift+V shown)',
    /Ctrl\+Shift\+V/.test(section(out, 'applet_win')),
    JSON.stringify(section(out, 'applet_win')));
  fs.rmSync(tmp, { recursive: true, force: true });
}

sessionStaleVolume();
sessionOtherHost();
sessionMacScheme();

console.log(failures ? `\nhostpaste e2e: ${failures} FAILED` : '\nhostpaste e2e: PASS');
process.exit(failures ? 1 : 0);
