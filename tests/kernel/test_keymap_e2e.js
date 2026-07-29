#!/usr/bin/env node
// 0149/0150 acceptance, headless: the system keyboard scheme (os/keys.h) —
// ONE config-driven table + ONE key_action dispatch, consumed by user32
// (EDIT verbs + the TranslateAccelerator FCONTROL swap), term (copy/paste
// chord + the ⌘-drops-not-types rule) and ctlpanel (the Keyboard applet).
// Covers:
//   - windows scheme (the baked default): EDIT ^A/^C/^V verbs round-trip
//     the kernel clip slot; Ctrl+arrow word-nav; an unbound ⌘chord in an
//     EDIT drops instead of typing its letter (the TranslateMessage GUI
//     guard)
//   - macos scheme (/etc/keys admin layer): ⌘A/⌘C/⌘V are the EDIT verbs;
//     ^C neither copies nor types (Ctrl freed); the readline rows ^E/^A/^K
//     edit in a GUI EDIT; ⌥→ word-nav; `readline off` disarms the rows;
//     the 1 Hz cached revalidate carries a live /etc/keys flip into a
//     RUNNING app (~1s, no restart — the decision-4 mechanism)
//   - accelerators: fileman's runtime FCONTROL table fires on ⌘C/⌘V under
//     macos (zero per-app work) and NOT on Ctrl+C/Ctrl+V (a swap, not an
//     alias)
//   - term: ⌘V pastes / ⌘C drops under macos (the ⌘C-typed-'c' bug); a
//     live flip back to windows re-arms Ctrl+Shift+V
//   - ctlpanel Keyboard applet: radios + the readline checkbox delta-write
//     ~/.config/keys (the user layer)
//
// Run: node tests/kernel/test_keymap_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-keymap-');

function boot(script, timeout) {
  return driveBoot(script, { image, timeout, maxBuffer: 32 * 1024 * 1024 }).stdout;
}

// Chord injection (the 0090 pattern): `wmctl key SID SCANCODE KEYSYM MOD`
// sends both edges with the modifier word on the event — user32's g_mod /
// term's k->mod see exactly what a held modifier produces. Scancodes: a=4
// c=6 e=8 k=14 v=25; mods: LSHIFT=1 LCTRL=64 LALT=256 LGUI=1024.
const key = (sid, sc, sym, mod) =>
  `wmctl key ${sid} ${sc} ${sym}${mod ? ' ' + mod : ''}`;
const type = (sid, s) =>
  [...s].map((ch) => `wmctl key ${sid} 0 ${ch.charCodeAt(0)}`).join('\n');

// Bounded condition polls (todos/0154 — not fixed sync sleeps).
const waitClipHas = (s) =>
  `for i in $(seq 1 120); do clip -o 2>/dev/null | grep -q "${s}" && break; sleep 0.05; done`;
const waitFile = (p) =>
  `for i in $(seq 1 200); do [ -e "${p}" ] && break; sleep 0.05; done`;
const waitText = (label, s) =>
  `for i in $(seq 1 120); do wmctl gettext ${label} | grep -qx "${s}" && break; sleep 0.05; done`;

/* ---- session A: windows scheme (the baked default), notepad EDIT ---- */
function sessionWindows() {
  const out = boot([
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    // ^A + ^C fill the slot
    'wmctl settext EDIT:0 "hello world"',
    key('$NSID', 4, 97, 64),                     // ^A select all
    key('$NSID', 6, 99, 64),                     // ^C copy
    waitClipHas('hello world'),
    'echo ==copy',
    'clip -o',
    'echo ==cut',
    // ^V pastes the (shell-set) slot
    'printf "PASTE-ME" | clip',
    'wmctl settext EDIT:0 ""',
    key('$NSID', 25, 118, 64),                   // ^V paste
    'wmctl wait text EDIT:0 "PASTE-ME" 6000',
    'echo ==paste',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // Ctrl+Right = word right (caret 0 after settext; lands before "beta")
    'wmctl settext EDIT:0 "alpha beta"',
    key('$NSID', 79, 1073741903, 64),            // Ctrl+Right
    type('$NSID', 'x'),
    waitText('EDIT:0', 'alpha xbeta'),
    'echo ==wordnav',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // an unbound ⌘chord must DROP, not type its letter: ⌘C then '!' —
    // '!' lands at the (unmoved) caret 0; a leaked 'c' would show up
    'wmctl settext EDIT:0 "CLEAN"',
    key('$NSID', 6, 99, 1024),                   // ⌘C — unbound in windows scheme
    type('$NSID', '!'),
    waitText('EDIT:0', '!CLEAN'),
    'echo ==guidrop',
    'wmctl gettext EDIT:0',
    'echo ==done',
    '',
  ].join('\n'));

  check('windows: ^A+^C fill the kernel slot', section(out, 'copy') === 'hello world',
    JSON.stringify(section(out, 'copy')));
  check('windows: ^V pastes the slot', section(out, 'paste').trim() === 'PASTE-ME',
    JSON.stringify(section(out, 'paste')));
  check('windows: Ctrl+Right word-nav', section(out, 'wordnav').trim() === 'alpha xbeta',
    JSON.stringify(section(out, 'wordnav')));
  check('windows: unbound ⌘C drops instead of typing', section(out, 'guidrop').trim() === '!CLEAN',
    JSON.stringify(section(out, 'guidrop')));
}

/* ---- session B: macos scheme (admin layer, set BEFORE launch) +
 * the readline rows + the live 1 Hz revalidate ---- */
function sessionMac() {
  const out = boot([
    'printf "scheme\\tmacos\\n" > /etc/keys',
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    // ⌘A + ⌘C are the verbs now
    'wmctl settext EDIT:0 "mac verbs"',
    key('$NSID', 4, 97, 1024),                   // ⌘A
    key('$NSID', 6, 99, 1024),                   // ⌘C
    waitClipHas('mac verbs'),
    'echo ==copy',
    'clip -o',
    'echo ==cut',
    // ^C must neither copy nor type: select all, set a sentinel slot,
    // hit ^C, then ⌘V — the paste must deliver the SENTINEL (had ^C
    // copied, the selection would come back instead)
    'wmctl settext EDIT:0 "AB"',
    key('$NSID', 4, 97, 1024),                   // ⌘A select all
    'printf "SENTINEL-1" | clip',
    key('$NSID', 6, 99, 64),                     // ^C — freed register, no-op
    key('$NSID', 25, 118, 1024),                 // ⌘V
    'wmctl wait text EDIT:0 "SENTINEL-1" 6000',
    'echo ==ctrlfree',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // the readline rows (0150): ^E end, ^A start, ^K kill-to-eol
    'wmctl settext EDIT:0 "hello"',
    key('$NSID', 8, 101, 64),                    // ^E -> line end
    type('$NSID', '!'),
    waitText('EDIT:0', 'hello!'),
    'echo ==rl_e',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    key('$NSID', 4, 97, 64),                     // ^A -> line start
    type('$NSID', '@'),
    waitText('EDIT:0', '@hello!'),
    key('$NSID', 14, 107, 64),                   // ^K -> kill to eol
    waitText('EDIT:0', '@'),
    'echo ==rl_k',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // ⌥Right word-nav (the macos word chord; ⌘arrows are line/doc nav below)
    'wmctl settext EDIT:0 "one two"',
    key('$NSID', 79, 1073741903, 256),           // ⌥Right
    type('$NSID', 'x'),
    waitText('EDIT:0', 'one xtwo'),
    'echo ==wordnav',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // ⌘←/→ line nav + ⌘↑/↓ doc nav — the META-ARROW feature, LIVE now that
    // tiling relocated to Ctrl+Alt+arrow (keys.h macos rows). `wmctl key`
    // injects straight to the app (INJECT_KEY bypasses the kernel grab), so
    // this proves the APP-side verb routing under the macos scheme; that the
    // kernel PASSES ⌘+arrow through (not snap) is os-keybind.mjs's leg — the
    // two together are the full path. Each verb is tested from a FRESH settext
    // with a single caret-setup chord and a single TRAILING gettext: a gettext
    // RPC interleaved between a chord and the next injected key races the
    // agent's key delivery (a test-harness ordering quirk, not a product bug),
    // so state is read only after the 'Z' marker lands. Marker at buffer start
    // vs end is unambiguous ('abc' -> 'Zabc' means the caret was at 0).
    'wmctl settext EDIT:0 "abc"',
    key('$NSID', 80, 1073741904, 1024),          // ⌘Left  -> caret 0
    key('$NSID', 79, 1073741903, 1024),          // ⌘Right -> line end
    type('$NSID', 'Z'),
    'echo ==lineend', 'wmctl gettext EDIT:0', 'echo ==cut',
    'wmctl settext EDIT:0 "abc"',
    key('$NSID', 79, 1073741903, 1024),          // ⌘Right -> line end
    key('$NSID', 80, 1073741904, 1024),          // ⌘Left  -> line start
    type('$NSID', 'Z'),
    'echo ==linestart', 'wmctl gettext EDIT:0', 'echo ==cut',
    'wmctl settext EDIT:0 "abc"',
    key('$NSID', 79, 1073741903, 1024),          // ⌘Right -> line end
    key('$NSID', 82, 1073741906, 1024),          // ⌘Up    -> doc start
    type('$NSID', 'Z'),
    'echo ==docstart', 'wmctl gettext EDIT:0', 'echo ==cut',
    'wmctl settext EDIT:0 "abc"',
    key('$NSID', 80, 1073741904, 1024),          // ⌘Left  -> line start
    key('$NSID', 81, 1073741905, 1024),          // ⌘Down  -> doc end
    type('$NSID', 'Z'),
    'echo ==docend', 'wmctl gettext EDIT:0', 'echo ==cut',
    // readline off (the escape hatch): ^E must go inert — poll until the
    // 1 Hz cache picks the flip up (stale iterations produce "abz")
    'printf "scheme\\tmacos\\nreadline\\toff\\n" > /etc/keys',
    'for i in $(seq 1 60); do',
    '  wmctl settext EDIT:0 "ab"',
    '  ' + key('$NSID', 8, 101, 64),             // ^E — inert once off
    '  ' + type('$NSID', 'z'),
    '  wmctl gettext EDIT:0 | grep -qx "zab" && break',
    '  sleep 0.2',
    'done',
    'echo ==rloff',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // the decision-4 mechanism: flip the ADMIN layer to windows while the
    // app RUNS; within ~1s ^A/^C are the verbs again (idempotent poll)
    'printf "scheme\\twindows\\n" > /etc/keys',
    'wmctl settext EDIT:0 "REVALIDATED"',
    'for i in $(seq 1 60); do',
    '  ' + key('$NSID', 4, 97, 64),              // ^A
    '  ' + key('$NSID', 6, 99, 64),              // ^C
    '  clip -o 2>/dev/null | grep -q REVALIDATED && break',
    '  sleep 0.2',
    'done',
    'echo ==reval',
    'clip -o',
    'echo ==done',
    '',
  ].join('\n'));

  check('macos: ⌘A+⌘C fill the kernel slot', section(out, 'copy') === 'mac verbs',
    JSON.stringify(section(out, 'copy')));
  // POLICY ASSERTION — NOT a description of current behavior. jku decided,
  // three times by email on 2026-07-29, that the macos scheme is a SWAP and
  // never an alias: ⌘ carries the edit verbs and Ctrl stays RESERVED for the
  // readline rows and future emacs bindings. If this goes red, someone has
  // dual-bound Ctrl+C/V/X in the macos table and BROKEN the policy. Fix the
  // code; do NOT flip the assertion. See the CLOSED DECISION section at the
  // top of todos/KEYMAP.md before touching this line.
  check('macos: ^C is freed (paste delivers the sentinel, not the selection)',
    section(out, 'ctrlfree').trim() === 'SENTINEL-1',
    JSON.stringify(section(out, 'ctrlfree')));
  check('macos readline: ^E moves to line end', section(out, 'rl_e').trim() === 'hello!',
    JSON.stringify(section(out, 'rl_e')));
  check('macos readline: ^A + ^K edit the line', section(out, 'rl_k').trim() === '@',
    JSON.stringify(section(out, 'rl_k')));
  check('macos: ⌥Right word-nav', section(out, 'wordnav').trim() === 'one xtwo',
    JSON.stringify(section(out, 'wordnav')));
  check('macos: ⌘Right = line end', section(out, 'lineend').trim() === 'abcZ',
    JSON.stringify(section(out, 'lineend')));
  check('macos: ⌘Left = line start', section(out, 'linestart').trim() === 'Zabc',
    JSON.stringify(section(out, 'linestart')));
  check('macos: ⌘Up = doc start', section(out, 'docstart').trim() === 'Zabc',
    JSON.stringify(section(out, 'docstart')));
  check('macos: ⌘Down = doc end', section(out, 'docend').trim() === 'abcZ',
    JSON.stringify(section(out, 'docend')));
  check('readline off disarms the rows (live, no restart)',
    section(out, 'rloff').trim() === 'zab', JSON.stringify(section(out, 'rloff')));
  check('live /etc/keys flip reaches a running app within the 1 Hz revalidate',
    section(out, 'reval') === 'REVALIDATED', JSON.stringify(section(out, 'reval')));
}

/* ---- session C: the accelerator swap — fileman's runtime FCONTROL
 * table under macos (⌘ fires, Ctrl doesn't) ---- */
function sessionAccel() {
  const out = boot([
    'printf "scheme\\tmacos\\n" > /etc/keys',
    'mkdir -p /root/kmt',
    'touch /root/kmt/f.txt',
    'fileman /root/kmt &',
    'wmctl wait label Go 10000',
    'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
    'wmctl click $SID 100 100',                  // focus the listbox
    'wmctl key $SID 74 1073741898',              // HOME: select row 0 (f.txt)
    key('$SID', 6, 99, 1024),                    // ⌘C — the FCONTROL Copy accel
    key('$SID', 25, 118, 1024),                  // ⌘V — the FCONTROL Paste accel
    waitFile('/root/kmt/Copy of f.txt'),
    'echo ==pasted',
    'ls /root/kmt',
    'echo ==cut',
    // the swap is a SWAP: Ctrl chords must NOT fire the accels under
    // macos. Inject them, then a second ⌘V as the positive control — the
    // final listing must show exactly one extra copy (the ⌘ one).
    key('$SID', 6, 99, 64),                      // Ctrl+C — must not re-fill
    key('$SID', 25, 118, 64),                    // Ctrl+V — must not paste
    key('$SID', 25, 118, 1024),                  // ⌘V — pastes again
    waitFile('/root/kmt/Copy (2) of f.txt'),
    'echo ==after',
    'ls /root/kmt',
    'echo ==done',
    '',
  ].join('\n'));

  check('macos: fileman ⌘C+⌘V fire the FCONTROL accels (file pasted)',
    section(out, 'pasted').includes('Copy of f.txt'),
    JSON.stringify(section(out, 'pasted')));
  const after = section(out, 'after').split('\n').filter(Boolean).sort();
  // POLICY ASSERTION — see the note at the '^C is freed' check above and the
  // CLOSED DECISION section at the top of todos/KEYMAP.md. The accelerator
  // layer is a SWAP: under macos, Ctrl+C/Ctrl+V must fire NOTHING. A red here
  // means the swap became an alias. Fix the code; do NOT flip the assertion.
  check('macos: Ctrl chords do NOT fire the accels (exactly the two ⌘ copies)',
    after.length === 3 && after.includes('Copy (2) of f.txt'),
    JSON.stringify(after));
}

/* ---- session D: term — ⌘V paste / ⌘C drop under macos; live flip back
 * to windows re-arms Ctrl+Shift+V ---- */
function sessionTerm() {
  const out = boot([
    'printf "scheme\\tmacos\\n" > /etc/keys',
    'term &',
    'wmctl wait win term 12000',
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    // ⌘V executes the pasted line over the pty
    'printf "touch /root/km_mac\\n" | clip',
    key('$TSID', 25, 118, 1024),                 // ⌘V
    waitFile('/root/km_mac'),
    'echo ==mac',
    'ls /root/km_mac',
    'echo ==cut',
    // ⌘C with nothing selected must neither copy nor TYPE a 'c' — the
    // very next typed command must run clean (a leaked 'c' would corrupt
    // it into `ctouch ...` and the waitFile would fail loud)
    key('$TSID', 6, 99, 1024),                   // ⌘C
    type('$TSID', 'touch /root/km_clean\r'),
    waitFile('/root/km_clean'),
    'echo ==clean',
    'ls /root/km_clean',
    'echo ==cut',
    // live flip back to windows: Ctrl+Shift+V is the chord again.
    // sleep is the 1 Hz keys.h cache revalidate — a genuine no-marker
    // settle (an early Ctrl+Shift+V under a stale macos cache would fold
    // to a literal-next ^V byte on the pty and corrupt the line, so this
    // must NOT be an injection poll).
    'printf "scheme\\twindows\\n" > /etc/keys',
    'sleep 2',
    'printf "touch /root/km_win\\n" | clip',
    key('$TSID', 25, 86, 65),                    // Ctrl+Shift+V
    waitFile('/root/km_win'),
    'echo ==win',
    'ls /root/km_win',
    'echo ==done',
    '',
  ].join('\n'), 420000);

  check('macos: term ⌘V pastes (hush executed the line)',
    section(out, 'mac').trim() === '/root/km_mac', JSON.stringify(section(out, 'mac')));
  check('macos: term ⌘C drops (no stray letter on the command line)',
    section(out, 'clean').trim() === '/root/km_clean', JSON.stringify(section(out, 'clean')));
  check('windows (live flip): Ctrl+Shift+V pastes again',
    section(out, 'win').trim() === '/root/km_win', JSON.stringify(section(out, 'win')));
}

/* ---- session E: the ctlpanel Keyboard applet delta-writes the user
 * layer ---- */
function sessionApplet() {
  const out = boot([
    'ctlpanel Keyboard &',
    'wmctl wait win "Keyboard Properties" 12000',
    'wmctl wait label "macOS (Cmd)" 8000',
    'wmctl click "macOS (Cmd)"',
    'for i in $(seq 1 100); do grep -q macos /root/.config/keys 2>/dev/null && break; sleep 0.05; done',
    'echo ==cfg1',
    'cat /root/.config/keys',
    'echo ==cut',
    'wmctl click "Emacs editing in text fields (macOS)"',   // on -> off
    'for i in $(seq 1 100); do grep -q off /root/.config/keys 2>/dev/null && break; sleep 0.05; done',
    'echo ==cfg2',
    'cat /root/.config/keys',
    'echo ==cut',
    'wmctl click "Windows (Ctrl)"',
    'for i in $(seq 1 100); do grep -q windows /root/.config/keys 2>/dev/null && break; sleep 0.05; done',
    'echo ==cfg3',
    'cat /root/.config/keys',
    'echo ==done',
    '',
  ].join('\n'));

  check('applet: macOS radio writes scheme to the user layer',
    /scheme\tmacos/.test(section(out, 'cfg1')), JSON.stringify(section(out, 'cfg1')));
  check('applet: readline checkbox delta-writes (scheme line kept)',
    /scheme\tmacos/.test(section(out, 'cfg2')) && /readline\toff/.test(section(out, 'cfg2')),
    JSON.stringify(section(out, 'cfg2')));
  check('applet: Windows radio flips the scheme back',
    /scheme\twindows/.test(section(out, 'cfg3')) && /readline\toff/.test(section(out, 'cfg3')),
    JSON.stringify(section(out, 'cfg3')));
}

/* ---- session F: host keyboard-scheme auto-detect (META-ARROW-KEYBIND.md
 * decision 4). boot.js --host-platform=mac (the headless twin of os.html's
 * navigator probe) seeds the macos scheme as the DEFAULT on a fresh root
 * volume's admin /etc/keys — proven behaviorally: under the seed, ⌘A/⌘C ARE
 * the EDIT verbs (fill the slot) with no /etc/keys or user config written by
 * the test. A non-mac hint would leave the baked windows default (that path is
 * every other session here). ---- */
function sessionAutodetectMac() {
  const { image: img } = freshImage('os-keymap-hostmac-');
  const out = driveBoot([
    'echo ==keysfile',
    'cat /etc/keys 2>/dev/null',                 // the admin seed the boot wrote
    'echo ==cut',
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    'wmctl settext EDIT:0 "auto mac"',
    key('$NSID', 4, 97, 1024),                   // ⌘A  (a macos verb)
    key('$NSID', 6, 99, 1024),                   // ⌘C  (a macos verb)
    waitClipHas('auto mac'),
    'echo ==maccopy',
    'clip -o',
    'echo ==done',
    '',
  ], { image: img, args: ['--host-platform=mac'], maxBuffer: 32 * 1024 * 1024 }).stdout;

  check('autodetect: Mac host seeds scheme macos into the admin /etc/keys',
    /scheme\tmacos/.test(section(out, 'keysfile')), JSON.stringify(section(out, 'keysfile')));
  check('autodetect: the seeded macos default makes ⌘A/⌘C the EDIT verbs',
    section(out, 'maccopy').trim() === 'auto mac', JSON.stringify(section(out, 'maccopy')));
}

/* ---- session G: the manual override still wins over the host default. Same
 * Mac host (admin /etc/keys seeded macos), but the user picked windows in
 * ~/.config/keys (the HIGHER cfgstore layer the ctlpanel applet writes). The
 * effective scheme must be windows: ^A/^C are the verbs and ⌘C is unbound
 * (drops, does not type). ---- */
function sessionAutodetectOverride() {
  const { image: img } = freshImage('os-keymap-hostovr-');
  const out = driveBoot([
    'mkdir -p /root/.config',
    'printf "scheme\\twindows\\n" > /root/.config/keys',   // the manual override
    'echo ==keysfile',
    'cat /etc/keys 2>/dev/null',                 // admin layer is STILL macos-seeded
    'echo ==cut',
    'notepad &',
    'wmctl wait label EDIT:0 12000',
    'NSID=$(wmctl list | grep "Notepad" | sed "s/[^0-9].*//")',
    'wmctl settext EDIT:0 "user win"',
    key('$NSID', 4, 97, 64),                     // ^A  (windows verb)
    key('$NSID', 6, 99, 64),                     // ^C  (windows verb)
    waitClipHas('user win'),
    'echo ==wincopy',
    'clip -o',
    'echo ==cut',
    // ⌘C is unbound under windows -> it must DROP, not type its 'c': ⌘C then
    // '!' lands at the unmoved caret 0; a leaked 'c' would show.
    'wmctl settext EDIT:0 "CLEAN"',
    key('$NSID', 6, 99, 1024),                   // ⌘C — unbound under the override
    type('$NSID', '!'),
    waitText('EDIT:0', '!CLEAN'),
    'echo ==guidrop',
    'wmctl gettext EDIT:0',
    'echo ==done',
    '',
  ], { image: img, args: ['--host-platform=mac'], maxBuffer: 32 * 1024 * 1024 }).stdout;

  check('autodetect: the admin /etc/keys seed is still macos (default, not choice)',
    /scheme\tmacos/.test(section(out, 'keysfile')), JSON.stringify(section(out, 'keysfile')));
  check('override wins: user ~/.config/keys=windows -> ^A/^C are the verbs',
    section(out, 'wincopy').trim() === 'user win', JSON.stringify(section(out, 'wincopy')));
  check('override wins: ⌘C is unbound under the windows override (drops, no typed c)',
    section(out, 'guidrop').trim() === '!CLEAN', JSON.stringify(section(out, 'guidrop')));
}

sessionWindows();
sessionMac();
sessionAccel();
sessionTerm();
sessionApplet();
sessionAutodetectMac();
sessionAutodetectOverride();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nkeymap e2e: ${failures} FAILED` : '\nkeymap e2e: PASS');
process.exit(failures ? 1 : 0);
