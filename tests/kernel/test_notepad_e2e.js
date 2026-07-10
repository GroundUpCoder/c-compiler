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

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-notepad-'));
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
  'printf "alpha beta\\ngamma beta delta\\n" > /root/readme.txt',
  'notepad &',
  'sleep 6',
  'SID=$(wmctl list | grep "Notepad$" | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // type into the EDIT, then Save As through the real file dialog
  'wmctl settext EDIT:0 "hello from notepad"',
  'wmctl click "Save As..."',
  'sleep 2',
  'echo ==dlgtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl settext EDIT:2 note.txt',
  'wmctl click Save',
  'sleep 2',
  'echo ==saved',
  'cat /root/note.txt',
  'echo',
  'echo ==cut',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  // Open readme.txt through the open dialog
  'wmctl click "Open..."',
  'sleep 2',
  'wmctl settext EDIT:2 readme.txt',
  'wmctl click Open',
  'sleep 2',
  'echo ==content1',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  'echo ==bar1',
  'wmctl gettext msctls_statusbar32:0',
  'echo ==cut',
  // Replace All: beta -> BEE (the whole FINDREPLACE protocol)
  'wmctl click "Replace..."',
  'sleep 2',
  'wmctl settext EDIT:1 beta',
  'wmctl settext EDIT:2 BEE',
  'wmctl click "Replace All"',
  'sleep 1',
  'echo ==content2',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  'wmctl click Cancel',
  'sleep 1',
  // Select All + Copy -> the kernel clipboard slot (0090)
  'wmctl click "Select All"',
  'wmctl click Copy',
  'sleep 1',
  'echo ==clip',
  'clip -o',
  'echo',
  'echo ==cut',
  // New Window (ShellExecuteW spawns GetModuleFileName's answer)
  'wmctl click "New Window"',
  'sleep 5',
  'echo ==list3',
  'wmctl list',
  'echo ==cut',
  'NSID=$(wmctl list | grep "Untitled - Notepad$" | sed "s/[^0-9].*//" | head -1)',
  'wmctl close $NSID',
  'sleep 1',
  // modify the original, close: the Yes/No/Cancel prompt
  'wmctl key $SID 4 97',
  'sleep 0.5',
  'wmctl close $SID',
  'sleep 1',
  'echo ==prompt',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  'sleep 1.5',
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

/* Save As through the file dialog */
const dlg = section(out, 'dlgtree');
check('Save As opens the comdlg32 file dialog (listbox of /root)',
  /class=WCFileDlg [^\n]*text='Save As'/.test(dlg) && /readme\.txt/.test(dlg), dlg.slice(-500));
check('owner is disabled while the dialog is up (modal)',
  /class=EDIT id=0 [^\n]*en=0/.test(dlg), dlg);
check('Save wrote the file', section(out, 'saved').trim() === 'hello from notepad',
  JSON.stringify(section(out, 'saved')));
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
