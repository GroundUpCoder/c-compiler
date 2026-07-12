#!/usr/bin/env node
// 0048 acceptance, headless: notepad (the ReactOS port) usable in-OS
// through os/boot.js. Covers the 0048 notepad tail:
//   - the EDIT-around-a-file plumbing: EM_GETHANDLE/EM_SETHANDLE (WCHAR
//     HLOCALs), EM_REPLACESEL (+ the send_msg W->A translation),
//     EM_GETMODIFY, EM_LINEFROMCHAR/EM_LINEINDEX for the status bar
//   - comdlg32: GetSaveFileNameW/GetOpenFileNameW as REAL file-browser
//     dialogs (agent-driven: settext the name EDIT, click Save/Open),
//     FindTextW/ReplaceTextW modeless dialogs speaking the registered
//     "commdlg_FindReplace" message protocol end to end
//   - comctl32: the status bar (SB_SETPARTS/SB_SETTEXTW; parts join in
//     WM_GETTEXT), self-parking at the client bottom
//   - the clipboard: Select All + Copy -> the kernel slot (todos/0090;
//     read back via /bin/clip)
//   - MB_YESNOCANCEL: the has-been-modified prompt shows Yes/No/Cancel
//   - ShellExecuteW: File > New Window spawns a second notepad (the
//     GetModuleFileName PATH-resolve fix rides this)
//
// Run: node tests/kernel/test_notepad_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-notepad-');

function boot(script) {
  return driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 }).stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

// The comdlg32/FindReplace/prompt dialogs are all real modal WM windows, and
// EDIT/clipboard content is agent-queryable — so every sleep here converts to a
// window/label/text wait or a bounded clip poll (todos/0154). clip content is
// multi-line (CRLF), so poll for a distinctive substring landing in it.
const waitClipHas = (s) =>
  `for i in $(seq 1 120); do clip -o 2>/dev/null | grep -q "${s}" && break; sleep 0.05; done`;

const out = boot([
  'printf "alpha beta\\ngamma beta delta\\n" > /root/readme.txt',
  'notepad &',
  // Boot barrier: EDIT:0 resolving in the agent tree means notepad's window,
  // control and agent server are all up (the window is also listed by then).
  'wmctl wait label EDIT:0 12000',
  'SID=$(wmctl list | grep "Notepad$" | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // Status-bar part clipping (regression): shot the untitled window while
  // the EOLN pane still reads the wide "Windows (CR + LF)" — at the default
  // 400px width that text overflows its 120px cell and MUST clip at the
  // border, not bleed into the "UTF-8" pane (comctl32 ExtTextOut ETO_CLIPPED).
  'wmctl shot $SID /root/sbar.ppm && echo sbar-shot-ok',
  'echo ==sbarshot',
  'base64 /root/sbar.ppm',
  'echo ==cut',
  // type into the EDIT, then Save As through the real file dialog
  'wmctl settext EDIT:0 "hello from notepad"',
  // 0104: FIRST drive Save As fully by KEYBOARD (Untitled => the name box
  // seeds empty) — the name EDIT holds focus on open, type a filename over
  // the kernel key path, Enter presses the default Save button (no click).
  'wmctl click "Save As..."',
  'wmctl wait label Save 6000',                  // the Save As dialog is up
  'wmctl key 0 22 107',                          // k
  'wmctl key 0 5 98',                            // b
  'wmctl key 0 7 100',                           // d
  'wmctl key 0 55 46',                           // .
  'wmctl key 0 23 116',                          // t
  'wmctl key 0 24 120',                          // x
  'wmctl key 0 34 116',                          // t
  'wmctl wait text EDIT:2 "kbd.txt" 4000',       // the typed name landed in the box
  'wmctl key 0 40 13',                           // Enter -> default Save
  'wmctl wait nowin "Save As" 6000',             // dialog closed (file written)
  'echo ==savedkbd',
  'cat /root/kbd.txt',
  'echo',
  'echo ==cut',
  // then the mouse/agent path (settext + click), the 0058 leg
  'wmctl click "Save As..."',
  'wmctl wait label Save 6000',
  'echo ==dlgtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl settext EDIT:2 note.txt',
  'wmctl click Save',
  'wmctl wait nowin "Save As" 6000',
  'echo ==saved',
  'cat /root/note.txt',
  'echo',
  'echo ==cut',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  // Open readme.txt through the open dialog
  'wmctl click "Open..."',
  'wmctl wait label Open 6000',                  // the Open dialog is up
  'wmctl settext EDIT:2 readme.txt',
  'wmctl click Open',
  'wmctl wait text EDIT:0 "gamma beta delta" 6000',   // file loaded into the EDIT
  'echo ==content1',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  'echo ==bar1',
  'wmctl gettext msctls_statusbar32:0',
  'echo ==cut',
  // Replace All: beta -> BEE (the whole FINDREPLACE protocol)
  'wmctl click "Replace..."',
  'wmctl wait label "Replace All" 6000',         // the Replace dialog is up
  'wmctl settext EDIT:1 beta',
  'wmctl settext EDIT:2 BEE',
  'wmctl click "Replace All"',
  'wmctl wait text EDIT:0 "gamma BEE delta" 6000',
  'echo ==content2',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  'wmctl click Cancel',
  'wmctl wait nolabel "Replace All" 6000',        // Replace dialog gone
  // Select All + Copy -> the kernel clipboard slot (0090)
  'wmctl click "Select All"',
  'wmctl click Copy',
  waitClipHas('gamma BEE delta'),
  'echo ==clip',
  'clip -o',
  'echo',
  'echo ==cut',
  // New Window (ShellExecuteW spawns GetModuleFileName's answer)
  'wmctl click "New Window"',
  'wmctl wait win "Untitled - Notepad" 8000',     // second notepad up
  'echo ==list3',
  'wmctl list',
  'echo ==cut',
  'NSID=$(wmctl list | grep "Untitled - Notepad$" | sed "s/[^0-9].*//" | head -1)',
  'wmctl close $NSID',
  'wmctl wait nowin "Untitled - Notepad" 6000',
  // modify the original, then close: the Yes/No/Cancel prompt. The 'a' keystroke
  // and the close are both FIFO in the input path, so the dirty flag is set
  // before WM_CLOSE — no settle sleep needed.
  'wmctl key $SID 4 97',
  'wmctl close $SID',
  'wmctl wait label Yes 6000',                    // the MB_YESNOCANCEL prompt is up
  'echo ==prompt',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'wmctl wait nowin "readme.txt - Notepad" 6000', // No discards -> notepad exits
  'echo ==list4',
  'wmctl list',
  'echo ==cut',
  '',
].join('\n'));

/* window + furniture */
const list1 = section(out, 'list1');
const row1 = list1.split('\n').find(l => l.endsWith('\tUntitled - Notepad')) || '';
check('window titled "Untitled - Notepad"', row1 !== '', JSON.stringify(list1.slice(0, 300)));
check('window is resizable (R flag)', (row1.split('\t')[5] || '').includes('R'), row1);

const tree1 = section(out, 'tree1');
check('menu bar attached (File popup from the res pack)',
  /menu popup text='File'/.test(tree1), tree1.slice(0, 200));
check('EDIT control present with focus', /class=EDIT [^\n]*focus/.test(tree1), tree1);
check('status bar parked at the client bottom with parts',
  /class=msctls_statusbar32 [^\n]*text='Line 1, column 1 \| /.test(tree1), tree1);
check('Find grayed while the document is empty',
  /menuitem id=288 text='Find\.\.\.' grayed/.test(tree1), tree1);

/* status-bar part clipping (regression): the wide "Windows (CR + LF)" pane
 * must clip at its cell border, not overflow into the fixed "UTF-8" pane.
 * Pre-fix this band held the bled "LF)" glyphs (~14 dark px); clipped it's 0. */
function parsePpm(b64) {
  const buf = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
  let p = 0;
  const tok = () => { while ([32, 10, 9, 13].includes(buf[p])) p++;
                      let s = p; while (![32, 10, 9, 13].includes(buf[p])) p++;
                      return buf.slice(s, p).toString(); };
  const magic = tok(); const w = +tok(), h = +tok(); tok(); p++;
  return { buf, w, h, data: p, magic };
}
function darkCount(P, x0, x1, y0, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = P.data + (y * P.w + x) * 3;
    if (P.buf[i] < 100 && P.buf[i + 1] < 100 && P.buf[i + 2] < 100) n++;
  }
  return n;
}
const sp = parsePpm(section(out, 'sbarshot'));
check('status-bar shot is a P6 frame', sp.magic === 'P6', sp.magic);
// notepad's pane 3 ("UTF-8") is a fixed 120px cell, so the pane2|pane3 border
// sits at width-120; the status bar is the surface's bottom 20px.
const bx = sp.w - 120, by = sp.h - 20;
const bleed = darkCount(sp, bx - 1, bx + 6, by + 2, by + 18);   // 6px past the border
const utf8 = darkCount(sp, bx + 6, bx + 40, by + 2, by + 18);   // the "UTF-8" glyphs
check('status-bar middle pane clips at its cell (no bleed into UTF-8 pane)',
  bleed <= 2, 'bleed=' + bleed);
check('status-bar UTF-8 pane still renders its own text', utf8 >= 10, 'utf8ink=' + utf8);

/* Save As through the file dialog */
const dlg = section(out, 'dlgtree');
check('Save As opens the comdlg32 file dialog (listbox of /root)',
  /class=WCFileDlg [^\n]*text='Save As'/.test(dlg) && /readme\.txt/.test(dlg), dlg.slice(-500));
check('owner is disabled while the dialog is up (modal)',
  /class=EDIT id=0 [^\n]*en=0/.test(dlg), dlg);
check('Save wrote the file', section(out, 'saved').trim() === 'hello from notepad',
  JSON.stringify(section(out, 'saved')));
check('Save As is fully keyboard-driven (type name + Enter default) (0104)',
  section(out, 'savedkbd').trim() === 'hello from notepad',
  JSON.stringify(section(out, 'savedkbd')));
check('title tracks the saved name',
  (section(out, 'list2').match(/note\.txt - Notepad/) || []).length === 1,
  section(out, 'list2'));

/* Open + status bar */
// notepad NORMALIZES to CRLF internally (the Windows EDIT contract)
check('Open loaded readme.txt into the EDIT (CRLF-normalized)',
  section(out, 'content1').trim() === 'alpha beta\r\ngamma beta delta',
  JSON.stringify(section(out, 'content1')));
check('status bar shows the detected EOLN (Unix LF)',
  /Unix \(LF\)/.test(section(out, 'bar1')), section(out, 'bar1'));

/* Replace All */
check('Replace All rewrote both matches (FINDREPLACE protocol)',
  section(out, 'content2').trim() === 'alpha BEE\r\ngamma BEE delta',
  JSON.stringify(section(out, 'content2')));

/* clipboard */
check('Select All + Copy filled the clipboard slot',
  section(out, 'clip').trim() === 'alpha BEE\r\ngamma BEE delta',
  JSON.stringify(section(out, 'clip')));

/* New Window */
check('New Window spawned a second notepad (ShellExecuteW)',
  (section(out, 'list3').match(/Notepad/g) || []).length >= 2, section(out, 'list3'));

/* the modified prompt */
const prompt = section(out, 'prompt');
check('close on a modified doc asks Yes/No/Cancel (MB_YESNOCANCEL)',
  /has been modified/.test(prompt) && /text='Yes'/.test(prompt) &&
  /text='No'/.test(prompt) && /text='Cancel'/.test(prompt), prompt.slice(-400));
check('No discards: notepad exits, no ghost windows',
  !/Notepad/.test(section(out, 'list4')), section(out, 'list4'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
