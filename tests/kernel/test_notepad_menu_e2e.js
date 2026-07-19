#!/usr/bin/env node
// 0222: notepad menu-item regression sweep — drive EVERY item of the real
// menu tree (File/Edit/Format/View/Help from vendor/notepad's rc) and assert
// each one's effect, or its LOUD refusal (the 0211 fail-loud policy):
//   File: New, New Window, Open..., Save (untitled -> Save As; named ->
//         writes), Save As..., Page Setup... / Print... (no printing
//         subsystem -> `win32: unsupported` report, no dead click), Exit
//   Edit: Undo (grayed via EM_CANUNDO once the popup opened; ^Z lands the
//         loud EM_UNDO report — todos/0135 is the real fix), Cut, Copy,
//         Paste, Delete, Find..., Find Next, Replace..., Go To... (+ the
//         out-of-range error box), Select All, Time/Date
//   Format: Word Wrap (checkmark + Go To grays + buffer survives the EDIT
//         recreate), Font... (loud cancel — todos/0223 is the real dialog)
//   View: Status Bar (hide/show, tree vis flag)
//   Help: View Help (grayed at WM_CREATE), About Notepad (ShellAbout box;
//         the win32rc \r fix keeps 'Palamarchuk' intact)
// Plus the WM_SETTEXT caret-to-START contract (real-EDIT semantics) this
// audit fixed.
//
// Menu popups are opened by a self-locating bar click (positions probed via
// open-popup gettext, 0171) so the test never encodes font-metric x offsets.
//
// Run: node tests/kernel/test_notepad_menu_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-npmenu-');

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

const waitClipHas = (s) =>
  `for i in $(seq 1 120); do clip -o 2>/dev/null | grep -q "${s}" && break; sleep 0.05; done`;
const waitEditEmpty =
  `for i in $(seq 1 80); do [ -z "$(wmctl gettext EDIT:0)" ] && break; sleep 0.05; done`;

// Open the bar popup that contains item $1 (unique open-popup label, 0171):
// walk candidate bar x positions, poll the open-menu gettext, ESC on a miss.
// Leaves the popup OPEN on success so the caller can dump/assert state.
const OPENPOPUP =
  'openpopup() { for x in 8 30 50 70 90 110 130 150 170 190 210; do ' +
  'wmctl click $SID $x 10; ' +
  'for t in 1 2 3 4 5 6; do wmctl gettext "$1" >/dev/null 2>&1 && return 0; sleep 0.05; done; ' +
  'wmctl key $SID 41 27; done; echo "POPUP-NOT-FOUND: $1"; return 1; }';

const r = driveBoot([
  OPENPOPUP,
  'printf "alpha beta\\ngamma beta delta\\n" > /root/menu.txt',
  'notepad &',
  'wmctl wait label EDIT:0 12000',
  'SID=$(wmctl list | grep "Notepad$" | sed "s/[^0-9].*//")',
  'echo ==tree0',
  'wmctl tree',
  'echo ==cut',

  // ---- coupling #6 (A5, 0257): the persistent bar STRIP child exists and
  // width-follows a parent resize (user32 owner-resizes it on WM_SIZE; a
  // resize is not a menu-state change, so this is its own designed hook)
  'wmctl wait win menubar 8000',
  'BARSID=$(wmctl list | grep "menubar$" | sed "s/[^0-9].*//")',
  'wmctl resize $SID 720 420',
  'wmctl wait dim $SID 720x420 8000',
  'wmctl wait dim $BARSID 720x30 8000',          // the strip followed
  'echo BAR-FOLLOW-OK',

  // ---- WM_SETTEXT caret contract: caret at START after a programmatic set
  'wmctl settext EDIT:0 abc',
  'wmctl key $SID 27 120',                       // x -> lands BEFORE abc
  'wmctl wait text EDIT:0 xabc 6000',
  'echo ==caret',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',

  // ---- Edit > Time/Date ----
  'wmctl click "Time/Date"',
  'wmctl wait text EDIT:0 "20" 6000',            // the year lands
  'echo ==timedate',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',

  // ---- File > New: modified buffer -> Yes/No/Cancel prompt; No discards
  'wmctl click "New"',
  'wmctl wait label Yes 6000',
  'echo ==newprompt',
  'wmctl tree',
  'echo ==cut',
  'wmctl click No',
  waitEditEmpty,
  'echo ==afternew',
  'wmctl gettext EDIT:0',
  'echo .end',
  'echo ==cut',

  // ---- File > Save on an UNTITLED buffer opens Save As; Cancel closes ----
  'wmctl settext EDIT:0 "untitled save probe"',
  'wmctl click "Save"',
  'wmctl wait win "Save As" 6000',
  'wmctl click Cancel',
  'wmctl wait nowin "Save As" 6000',

  // ---- Edit > Select All / Cut / Paste / Copy / Delete ----
  'wmctl settext EDIT:0 "$(printf \'cut one\\ncut two\\ncut three\')"',
  'wmctl click "Select All"',
  'wmctl click "Cut"',
  waitClipHas('cut three'),
  'echo ==cutclip',
  'clip -o',
  'echo',
  'echo ==cut',
  'echo ==cutedit',
  'wmctl gettext EDIT:0',
  'echo .end',
  'echo ==cut',
  'wmctl click "Paste"',
  'wmctl wait text EDIT:0 "cut three" 6000',
  'echo ==pasted',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',
  'wmctl settext EDIT:0 "copy payload"',
  'wmctl click "Select All"',
  'wmctl click "Copy"',
  waitClipHas('copy payload'),
  'echo ==copyclip',
  'clip -o',
  'echo',
  'echo ==cut',
  'wmctl click "Select All"',
  'wmctl click "Delete"',
  waitEditEmpty,
  'echo ==deleted',
  'wmctl gettext EDIT:0',
  'echo .end',
  'echo ==cut',

  // ---- Edit > Undo: grayed once the popup computes state (EM_CANUNDO) ----
  'openpopup "Time/Date"',                       // the Edit popup
  'echo ==editmenu',
  'wmctl tree | grep "Undo"',
  'echo ==cut',
  'wmctl key $SID 41 27',                        // ESC closes the popup
  'wmctl click "Undo" 2>/dev/null && echo undo-clicked || echo undo-refused',
  // ^Z accelerator: CMD_UNDO -> EM_UNDO -> the loud 0135 report
  'wmctl key $SID 29 122 64',                    // Ctrl+Z (KMOD_LCTRL)
  'sleep 0.3',

  // ---- Edit > Find... / Find Next ----
  'wmctl settext EDIT:0 "$(printf \'alpha beta\\ngamma beta delta\')"',
  'wmctl click "Find..."',
  'wmctl wait label "Find Next" 6000',
  'wmctl settext EDIT:1 beta',
  'wmctl click "Find Next"',
  'sleep 0.3',                                   // selection lands (no observable marker until typed over)
  'wmctl click Cancel',
  'wmctl wait nolabel "Find Next" 6000',
  'wmctl key $SID 27 120',                       // x types over the found selection
  'wmctl wait text EDIT:0 "alpha x" 6000',
  'echo ==findsel',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',
  'wmctl click "Find Next"',                     // the MENU item: next match (line 2)
  'sleep 0.3',
  'wmctl key $SID 28 121',                       // y
  'wmctl wait text EDIT:0 "gamma y delta" 6000',
  'echo ==findnext',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',

  // ---- Edit > Replace... (Replace All) ----
  'wmctl settext EDIT:0 "$(printf \'aa bb\\ncc bb\')"',
  'wmctl click "Replace..."',
  'wmctl wait label "Replace All" 6000',
  'wmctl settext EDIT:1 bb',
  'wmctl settext EDIT:2 ZZ',
  'wmctl click "Replace All"',
  'wmctl wait text EDIT:0 "cc ZZ" 6000',
  'echo ==replaced',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',
  'wmctl click Cancel',
  'wmctl wait nolabel "Replace All" 6000',

  // ---- Edit > Go To... ----
  'wmctl settext EDIT:0 "$(printf \'one\\ntwo\\nthree\')"',
  'wmctl click "Go To..."',
  'wmctl wait win "Goto line" 6000',
  'echo ==gototree',
  'wmctl tree',
  'echo ==cut',
  'wmctl settext EDIT:1 3',
  'wmctl click OK',
  'wmctl wait nowin "Goto line" 6000',
  'wmctl key $SID 29 122',                       // z at the moved caret
  'wmctl wait text EDIT:0 zthree 6000',
  'echo ==gotoedit',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',
  // out-of-range -> error box; dialog survives it
  'wmctl click "Go To..."',
  'wmctl wait win "Goto line" 6000',
  'wmctl settext EDIT:1 99',
  'wmctl click OK',
  'wmctl wait label "The specified line number is out of range." 6000',
  'wmctl click OK',
  'wmctl click Cancel',
  'wmctl wait nowin "Goto line" 6000',

  // ---- Format > Word Wrap: check + Go To grays + buffer survives ----
  'wmctl click "Word Wrap"',
  'openpopup "Word Wrap"',                       // the Format popup (fires WM_INITMENUPOPUP)
  'echo ==wrapon',
  'wmctl tree | grep "Word Wrap"',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'openpopup "Time/Date"',                       // Edit popup: Go To state
  'echo ==gotostate',
  'wmctl tree | grep "Go To"',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'wmctl click "Go To..." 2>/dev/null && echo goto-clicked-wrapped || echo goto-refused-wrapped',
  'echo ==wraptext',
  'wmctl gettext EDIT:0',
  'echo',
  'echo ==cut',
  'wmctl click "Word Wrap"',                     // toggle back off
  'openpopup "Word Wrap"',
  'echo ==wrapoff',
  'wmctl tree | grep "Word Wrap"',
  'echo ==cut',
  'wmctl key $SID 41 27',

  // ---- View > Status Bar: hide, then show ----
  'wmctl click "Status Bar"',
  'for i in $(seq 1 40); do wmctl tree | grep msctls | grep -q "vis=0" && break; sleep 0.05; done',
  'echo ==sbaroff',
  'wmctl tree | grep msctls',
  'echo ==cut',
  'wmctl click "Status Bar"',
  'for i in $(seq 1 40); do wmctl tree | grep msctls | grep -q "vis=1" && break; sleep 0.05; done',
  'echo ==sbaron',
  'wmctl tree | grep msctls',
  'echo ==cut',

  // ---- Format > Font..., File > Page Setup... / Print...: LOUD cancels ----
  'wmctl click "Font..."',
  'wmctl click "Page Setup..."',
  'wmctl click "Print..."',
  'sleep 0.5',                                   // reports flush to the tty (no window/marker to wait on)
  'echo ==afterloud',
  'wmctl list',
  'echo ==cut',

  // ---- Help > View Help (grayed) / About Notepad ----
  'wmctl click "View Help" 2>/dev/null && echo viewhelp-clicked || echo viewhelp-refused',
  'wmctl click "About Notepad"',
  'wmctl wait win "About Notepad" 6000',
  'echo ==about',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'wmctl wait nowin "About Notepad" 6000',

  // ---- File > Open... then Save (named) then Save As... ----
  'wmctl click "New"',                           // drop the goto scratch
  'wmctl wait label Yes 6000',
  'wmctl click No',
  waitEditEmpty,
  'wmctl click "Open..."',
  'wmctl wait win "Open" 6000',
  'wmctl settext EDIT:2 /root/menu.txt',
  'wmctl click Open',
  'wmctl wait text EDIT:0 "gamma beta delta" 6000',
  'echo ==opened',
  'wmctl list',
  'echo ==cut',
  'wmctl key $SID 20 113',                       // q -> modifies the named file
  'wmctl wait text EDIT:0 q 6000',
  'wmctl click "Save"',
  'for i in $(seq 1 40); do grep -q q /root/menu.txt && break; sleep 0.25; done',
  'echo ==saved',
  'cat /root/menu.txt',
  'echo ==cut',
  'wmctl click "Save As..."',
  'wmctl wait win "Save As" 6000',
  'wmctl settext EDIT:2 saveas.txt',
  'wmctl click Save',
  'wmctl wait nowin "Save As" 6000',
  'echo ==saveas',
  'cat /root/saveas.txt',
  'echo ==cut',

  // ---- File > New Window (second notepad; distinct title now) ----
  'wmctl click "New Window"',
  'wmctl wait win "Untitled - Notepad" 10000',
  'echo ==twowin',
  'wmctl list',
  'echo ==cut',
  'NSID=$(wmctl list | grep "Untitled - Notepad$" | sed "s/[^0-9].*//" | head -1)',
  'wmctl close $NSID',
  'wmctl wait nowin "Untitled - Notepad" 8000',

  // ---- File > Exit (buffer just saved -> clean close) ----
  'wmctl click "Exit"',
  'wmctl wait nowin "saveas.txt - Notepad" 8000',
  'echo ==final',
  'wmctl list',
  'echo ==cut',
  '',
], { image, maxBuffer: 64 * 1024 * 1024 });

const out = r.stdout;
const all = out + '\n' + String(r.stderr || '');

/* ---- the full menu inventory (regression: items can't silently vanish) */
const tree0 = section(out, 'tree0');
for (const p of ['File', 'Edit', 'Format', 'View', 'Help'])
  check(`menu popup ${p}`, new RegExp(`menu popup text='${p}'`).test(tree0), tree0.slice(0, 300));
for (const it of ['New', 'New Window', 'Open...', 'Save', 'Save As...',
                  'Page Setup...', 'Print...', 'Exit', 'Undo', 'Cut', 'Copy',
                  'Paste', 'Delete', 'Find...', 'Find Next', 'Replace...',
                  'Go To...', 'Select All', 'Time/Date', 'Word Wrap',
                  'Font...', 'Status Bar', 'View Help', 'About Notepad'])
  check(`menu item ${it}`,
    new RegExp(`menuitem id=\\d+ text='${it.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(tree0), it);
check('View Help grayed at startup (no HTML Help)',
  /text='View Help' grayed/.test(tree0), tree0);

/* ---- coupling #6 (A5, 0257): the bar strip child width-followed the resize
 * (the script's `wmctl wait dim $BARSID 720x30` is the real gate — a timeout
 * there fails the boot loud; this check pins the marker reached) */
check('bar strip child width-follows the parent resize (A5)',
  out.includes('BAR-FOLLOW-OK'), out.slice(-500));

/* ---- WM_SETTEXT caret contract */
check('WM_SETTEXT puts the caret at the START (typed x prepends)',
  section(out, 'caret').trim() === 'xabc', JSON.stringify(section(out, 'caret')));

/* ---- Time/Date */
check('Time/Date inserts a timestamp (GetTime/DateFormatW)',
  /20\d\d/.test(section(out, 'timedate')), JSON.stringify(section(out, 'timedate')));

/* ---- New */
check('New on a modified buffer prompts Yes/No/Cancel',
  /has been modified/.test(section(out, 'newprompt')) &&
  /text='Yes'/.test(section(out, 'newprompt')), section(out, 'newprompt').slice(-300));
check('New + No empties the buffer', section(out, 'afternew').trim() === '.end',
  JSON.stringify(section(out, 'afternew')));

/* ---- Cut / Paste / Copy / Delete / Select All */
check('Select All + Cut fills the clipboard',
  section(out, 'cutclip').trim() === 'cut one\ncut two\ncut three',
  JSON.stringify(section(out, 'cutclip')));
check('Cut empties the buffer', section(out, 'cutedit').trim() === '.end',
  JSON.stringify(section(out, 'cutedit')));
check('Paste restores the cut text',
  section(out, 'pasted').trim() === 'cut one\ncut two\ncut three',
  JSON.stringify(section(out, 'pasted')));
check('Select All + Copy fills the clipboard',
  section(out, 'copyclip').trim() === 'copy payload',
  JSON.stringify(section(out, 'copyclip')));
check('Select All + Delete empties the buffer',
  section(out, 'deleted').trim() === '.end', JSON.stringify(section(out, 'deleted')));

/* ---- Undo (todos/0135: no undo buffer — grayed + loud, never a dead click) */
check('Undo grayed once the Edit popup computes state (EM_CANUNDO)',
  /text='Undo' grayed/.test(section(out, 'editmenu')), section(out, 'editmenu'));
check('agent click on grayed Undo is refused', /undo-refused/.test(out), out.slice(-400));
check('^Z lands the loud EM_UNDO report (0211 fail-loud)',
  /win32: unsupported EDIT EM_UNDO/.test(all), 'no EM_UNDO report in output');

/* ---- Find / Find Next */
check('Find Next (dialog) selects the first match (typed x replaces it)',
  section(out, 'findsel').trim() === 'alpha x\ngamma beta delta',
  JSON.stringify(section(out, 'findsel')));
check('Find Next (menu) continues to the line-2 match',
  section(out, 'findnext').trim() === 'alpha x\ngamma y delta',
  JSON.stringify(section(out, 'findnext')));

/* ---- Replace All */
check('Replace All rewrites both matches',
  section(out, 'replaced').trim() === 'aa ZZ\ncc ZZ',
  JSON.stringify(section(out, 'replaced')));

/* ---- Go To */
check('Go To dialog is a #32770 with the line-number EDIT',
  /class=#32770 [^\n]*text='Goto line'/.test(section(out, 'gototree')),
  section(out, 'gototree').slice(-300));
check('Go To 3 moves the caret to line 3 (typed z lands there)',
  section(out, 'gotoedit').trim() === 'one\ntwo\nzthree',
  JSON.stringify(section(out, 'gotoedit')));

/* ---- Word Wrap */
check('Word Wrap checks its menu item', /text='Word Wrap' checked/.test(section(out, 'wrapon')),
  section(out, 'wrapon'));
check('Word Wrap grays Go To', /text='Go To\.\.\.' grayed/.test(section(out, 'gotostate')),
  section(out, 'gotostate'));
check('agent click on grayed Go To refused while wrapped',
  /goto-refused-wrapped/.test(out), out.slice(-400));
check('buffer survives the wrap EDIT re-create',
  section(out, 'wraptext').trim() === 'one\ntwo\nzthree',
  JSON.stringify(section(out, 'wraptext')));
check('Word Wrap unchecks on the second toggle',
  /text='Word Wrap'(?! checked)/.test(section(out, 'wrapoff')) &&
  !/checked/.test(section(out, 'wrapoff')), section(out, 'wrapoff'));

/* ---- Status Bar */
check('Status Bar toggle hides the bar (vis=0)', /vis=0/.test(section(out, 'sbaroff')),
  section(out, 'sbaroff'));
check('Status Bar toggle shows it again (vis=1)', /vis=1/.test(section(out, 'sbaron')),
  section(out, 'sbaron'));

/* ---- the loud cancels: Font / Page Setup / Print */
check('Font... reports loudly (ChooseFontW, todos/0223)',
  /win32: unsupported ChooseFontW/.test(all), 'no ChooseFontW report');
check('Page Setup... reports loudly (PageSetupDlgW)',
  /win32: unsupported PageSetupDlgW/.test(all), 'no PageSetupDlgW report');
check('Print... reports loudly (PrintDlgW)',
  /win32: unsupported PrintDlgW/.test(all), 'no PrintDlgW report');
const loudList = section(out, 'afterloud');
check('loud cancels open no stray windows',
  (loudList.match(/Notepad/g) || []).length === 1 && !/Font|Print|Page/.test(loudList),
  loudList);

/* ---- Help */
check('View Help (grayed) click refused', /viewhelp-refused/.test(out), out.slice(-400));
const about = section(out, 'about');
check('About Notepad opens the ShellAbout box',
  /text='About Notepad'/.test(about) && /Copyright 1997,98 Marcel Baur/.test(about),
  about.slice(-400));
check("win32rc \\r fix: authors end 'Palamarchuk', no leaked 'r'",
  /Palamarchuk\\n/.test(about) && !/Palamarchukr/.test(about), about.slice(-300));

/* ---- Open / Save / Save As */
check('Open... loads the file and titles the window',
  /menu\.txt - Notepad/.test(section(out, 'opened')), section(out, 'opened'));
check('Save writes the named file', /q/.test(section(out, 'saved')),
  JSON.stringify(section(out, 'saved')));
check('Save As... writes the new name',
  /gamma beta delta/.test(section(out, 'saveas')), JSON.stringify(section(out, 'saveas')));

/* ---- New Window / Exit */
check('New Window spawns a second notepad',
  (section(out, 'twowin').match(/Notepad/g) || []).length >= 2, section(out, 'twowin'));
check('Exit closes notepad (no ghost windows)',
  !/Notepad/.test(section(out, 'final')), section(out, 'final'));
check('no popup-locator failures', !/POPUP-NOT-FOUND/.test(out), out.slice(-500));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
