#!/usr/bin/env node
// 0090 acceptance, headless: the system clipboard — ONE kernel-held slot
// (CLIP_SET/CLIP_GET RPCs) under SDL_SetClipboardText/SDL_GetClipboardText,
// shared by /bin/clip, the win32 veneer (notepad's EDIT + menus) and term's
// Ctrl+Shift+C/V. Covers:
//   - /bin/clip: stdin -> slot, -o -> stdout; cross-process (the writer has
//     exited by the time the reader runs), overwrite, clear, empty exit 1
//   - chunking: ~170KB through the 64KB kernel page in both directions
//   - win32: notepad Select All + Copy -> slot readable by clip -o AND
//     after the notepad exits (Win95 semantics); paste into a SECOND
//     notepad process; Cut removes from the source EDIT and fills the slot
//   - shell -> GUI: `printf ... | clip` pastes into notepad
//   - term: drag-selection + Ctrl+Shift+C lands screen text in the slot;
//     Ctrl+Shift+V writes the slot to the pty (hush executes it); plain
//     Ctrl+C still delivers SIGINT (the chord needs BOTH modifiers)
//
// Run: node tests/kernel/test_clipboard_e2e.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-clip-'));
const image = path.join(tmp, 'os.img');

function boot(script, timeout) {
  const r = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: timeout || 300000,
      maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r.stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==')[0];
}

// Inject a string as SDL key events into a term window (the 0020 pattern:
// keysyms are modifier-applied chars, scancode 0 is fine).
const keys = (s) => [...s].map((ch) => 'wmctl key $TSID 0 ' + ch.charCodeAt(0)).join('\n');

/* ---- session A: /bin/clip semantics + chunking ---- */
function sessionClip() {
  const out = boot([
    'echo one-slot | clip',
    'echo ==get1',
    'clip -o',
    'echo ==cut',
    // overwrite: last write wins
    'echo second-write | clip',
    'echo ==get2',
    'clip -o',
    'echo ==cut',
    // ~170KB: multi-chunk CLIP_SET and CLIP_GET through the 64KB page
    'seq 1 30000 | clip',
    'echo ==biglines',
    'clip -o | wc -l',
    'echo ==bigtail',
    'clip -o | tail -n 1',
    'echo ==cut',
    // clear: empty stdin empties the slot; -o reports exit 1
    'printf "" | clip',
    'clip -o; echo rc=$?',
    'echo ==done',
    '',
  ].join('\n'));

  check('clip round-trips across processes', section(out, 'get1') === 'one-slot\n',
    JSON.stringify(section(out, 'get1')));
  check('second write replaces the slot', section(out, 'get2') === 'second-write\n',
    JSON.stringify(section(out, 'get2')));
  check('~170KB survives chunking (line count)',
    section(out, 'biglines').trim() === '30000', section(out, 'biglines').trim());
  check('~170KB survives chunking (last line intact)',
    section(out, 'bigtail').trim() === '30000', section(out, 'bigtail').trim());
  check('cleared slot: clip -o exits 1', out.includes('rc=1'), out.slice(-200));
}

/* ---- session B: win32 (notepad) cross-process copy/cut/paste ---- */
function sessionWin32() {
  const out = boot([
    'notepad &',
    'sleep 4',
    'wmctl settext EDIT:0 "COPY ME ACROSS"',
    'wmctl click "Select All"',
    'wmctl click Copy',
    'sleep 1',
    'echo ==clip1',
    'clip -o',
    'echo ==cut',
    'wmctl click Exit',
    'sleep 2',
    'echo ==list1',
    'wmctl list',
    'echo ==cut',
    // Win95 semantics: the slot outlives the copying process
    'echo ==clip2',
    'clip -o',
    'echo ==cut',
    // a SECOND notepad pastes it
    'notepad &',
    'sleep 4',
    'wmctl click Paste',
    'sleep 1',
    'echo ==pasted',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // Cut: removes from the source EDIT, fills the slot
    'wmctl settext EDIT:0 "CUT SOURCE"',
    'wmctl click "Select All"',
    'wmctl click Cut',
    'sleep 1',
    'echo ==aftercut',
    'wmctl gettext EDIT:0',
    'echo ==clip3',
    'clip -o',
    'echo ==cut',
    // shell -> GUI: clip feeds WM_PASTE
    'printf "from-the-shell" | clip',
    'wmctl click Paste',
    'sleep 1',
    'echo ==shellpaste',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    'wmctl click Exit',
    'sleep 1',
    'echo ==done',
    '',
  ].join('\n'));

  check('notepad Select All + Copy fills the kernel slot',
    section(out, 'clip1') === 'COPY ME ACROSS', JSON.stringify(section(out, 'clip1')));
  check('first notepad exited', !section(out, 'list1').includes('Notepad'),
    section(out, 'list1'));
  check('slot survives the copying process exiting',
    section(out, 'clip2') === 'COPY ME ACROSS', JSON.stringify(section(out, 'clip2')));
  check('second notepad pastes the slot',
    section(out, 'pasted').trim() === 'COPY ME ACROSS', JSON.stringify(section(out, 'pasted')));
  check('Cut empties the source EDIT', section(out, 'aftercut').trim() === '',
    JSON.stringify(section(out, 'aftercut')));
  check('Cut filled the slot', section(out, 'clip3') === 'CUT SOURCE',
    JSON.stringify(section(out, 'clip3')));
  check('shell clip pastes into the EDIT (paste replaced the selection)',
    section(out, 'shellpaste').trim() === 'from-the-shell',
    JSON.stringify(section(out, 'shellpaste')));
}

/* ---- session C: term selection copy, paste, SIGINT regression ---- */
function sessionTerm() {
  const out = boot([
    'term &',
    'sleep 5',
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    keys('echo TERMCOPY-MARKER\r'),
    'sleep 2',
    // whole-screen drag-selection (640x432 = 80x24 at the 8x18 cell), then
    // Ctrl+Shift+C: keysym 67 ('C'), mod 65 = LSHIFT|LCTRL
    'wmctl drag $TSID 4 4 636 428',
    'sleep 1',
    'wmctl key $TSID 0 67 65',
    'sleep 1',
    'echo ==copied',
    'clip -o | grep -c TERMCOPY-MARKER',
    'echo ==cut',
    // paste: the slot goes to the pty; \n arrives as CR so hush executes
    'printf "echo pasted-over-the-pty > /tmp/pasted\\n" | clip',
    'wmctl key $TSID 0 86 65',
    'sleep 2',
    'echo ==pasted',
    'cat /tmp/pasted',
    'echo ==cut',
    // plain Ctrl+C (mod 64, no shift) must still be SIGINT, not copy
    keys('sleep 100\r'),
    'sleep 1.5',
    'wmctl key $TSID 0 99 64',
    'sleep 1.5',
    keys('echo INTR-OK > /tmp/intr\r'),
    'sleep 2',
    'echo ==intr',
    'cat /tmp/intr',
    'echo ==done',
    '',
  ].join('\n'), 420000);

  check('term drag-selection + Ctrl+Shift+C copied the screen text (echo + output)',
    section(out, 'copied').trim() === '2', JSON.stringify(section(out, 'copied')));
  check('Ctrl+Shift+V pasted the slot into the pty (hush executed it)',
    section(out, 'pasted').trim() === 'pasted-over-the-pty',
    JSON.stringify(section(out, 'pasted')));
  check('plain Ctrl+C still interrupts (chord needs both modifiers)',
    section(out, 'intr').trim() === 'INTR-OK', JSON.stringify(section(out, 'intr')));
}

sessionClip();
sessionWin32();
sessionTerm();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nclipboard e2e: ${failures} FAILED` : '\nclipboard e2e: PASS');
process.exit(failures ? 1 : 0);
