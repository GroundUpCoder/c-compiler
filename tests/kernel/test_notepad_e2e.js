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
// multi-line, so poll for a distinctive substring landing in it.
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
  // Open an EXTENSIONLESS file through the dialog (0211: the defExt
  // append used to turn "Makefile" into "Makefile.txt" -> not found)
  'printf "extensionless payload\\n" > /root/Makefile',
  'wmctl click "Open..."',
  'wmctl wait label Open 6000',
  'wmctl settext EDIT:2 Makefile',
  'wmctl click Open',
  'wmctl wait text EDIT:0 "extensionless payload" 6000',
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
  // CRLF round-trip (todos/0210): gucOS is POSIX — the EDIT strips \r at
  // every text-in path (EM_SETHANDLE is notepad's load), and a pure-LF
  // buffer makes notepad's WriteText a verbatim write (its \r\n scan never
  // fires), so save keeps LF. The buffer is modified (BEE): the save prompt
  // fires AFTER the file dialog's Open button (DoOpenFile -> DoCloseFile) —
  // No discards.
  'printf "cr one\\r\\ncr two\\r\\ncr three\\r\\n" > /root/crlf.txt',
  'wmctl click "Open..."',
  'wmctl wait label Open 6000',
  'wmctl settext EDIT:2 crlf.txt',
  'wmctl click Open',
  'wmctl wait label No 6000',                     // save-changes prompt
  'wmctl click No',
  'wmctl wait text EDIT:0 "cr three" 6000',
  'echo ==crlfload',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  // dirty the buffer, Save (no dialog: the file has a name), read the file
  'wmctl click EDIT:0',
  'wmctl key $SID 29 122',                        // z
  'wmctl wait text EDIT:0 z 4000',
  'wmctl click Save',
  'for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do grep -q z /root/crlf.txt && break; sleep 0.25; done',
  'echo ==crlfsaved',
  'cat /root/crlf.txt',
  'echo',
  'echo ==cut',
  // the WM_SETTEXT text-in path strips \r too (agent settext)
  "wmctl settext EDIT:0 \"$(printf 'st one\\r\\nst two\\rst three')\"",
  'echo ==setcr',
  'wmctl gettext EDIT:0',
  'echo ==cut',
  // ---- the built-in WS_VSCROLL scrollbar (todos/0210) ----
  // Geometry: at 400x300 the EDIT fills surface y=20 (under the menu)
  // down to the status bar's top edge; the status-bar height is
  // FONT-DERIVED (0229 — 28px for the 14px stock font), so SBY (the
  // bar's surface top == the EDIT's surface bottom) is read from the
  // live tree, never hardcoded. The vbar is the right 16px inside the
  // 2px well (surface x 382..398), arrows 16px tall at its ends; the
  // hbar strip is the bottom 16px of the EDIT interior (SBY-18..SBY-2),
  // so the down arrow spans SBY-34..SBY-18 (center SBY-26).
  // Scroll position is probed by CLICKING the top text row (surface y=40,
  // under the 30px menu bar -> EDIT row 0 -> caret = topLine) and the status bar's
  // "Line N" — scrollbar/wheel scrolling itself must NOT move the caret.
  'wmctl resize $SID 400 300',
  'wmctl wait dim $SID 400x300 4000',
  'SBH=$(wmctl tree | sed -n "s/.*class=msctls_statusbar32 .*rect=[0-9-]*,[0-9-]* [0-9]*x\\([0-9]*\\) vis.*/\\1/p" | head -1)',
  'SBY=$((300-SBH))',
  'i=1; while [ $i -le 100 ]; do echo "line $i"; i=$((i+1)); done > /root/long.txt',
  'wmctl click "Open..."',
  'wmctl wait label Open 6000',
  'wmctl settext EDIT:2 long.txt',
  'wmctl click Open',
  'wmctl wait text EDIT:0 "line 100" 6000',
  'wmctl shot $SID /root/sb.ppm && echo sb-shot-ok',
  'echo ==sbshot',
  'base64 /root/sb.ppm',
  'echo ==cut',
  // Scrollbar furniture coords (0211): the EDIT shows its WS_HSCROLL bar
  // too, so the vbar ends 16px higher — all y offsets hang off SBY (the
  // tree-derived EDIT bottom) so a status-bar height change can't shear
  // the clicks onto the wrong furniture.
  'wmctl click $SID 30 40',                       // probe: caret on top row
  'wmctl wait text msctls_statusbar32:0 "Line 1," 4000',
  'wmctl click $SID 390 $((SBY-26))',             // down arrow: +1 line
  'wmctl click $SID 390 $((SBY-26))',             // +1 more
  'wmctl click $SID 30 40',
  'wmctl wait text msctls_statusbar32:0 "Line 3," 4000',
  'wmctl click $SID 390 40',                      // up arrow: -1 line
  'wmctl click $SID 30 40',
  'wmctl wait text msctls_statusbar32:0 "Line 2," 4000',
  'wmctl click $SID 390 $((SBY-42))',             // channel below thumb: +page
  'wmctl click $SID 30 40',
  'n=0; while [ $n -lt 40 ]; do wmctl gettext msctls_statusbar32:0 | grep -q "Line 2," || break; sleep 0.1; n=$((n+1)); done',
  'echo ==pgdn',
  'wmctl gettext msctls_statusbar32:0',
  'echo ==cut',
  // Reset to the top so the thumb is at a known y (grab just below the up
  // arrow), then drag it to the channel bottom — the shorter 20px-font EDIT
  // moves the thumb, so grabbing at a fixed y only works from a fixed start.
  'wmctl wheel $SID 99',
  'wmctl click $SID 30 40',
  'wmctl wait text msctls_statusbar32:0 "Line 1," 4000',
  'PG="$(wmctl gettext msctls_statusbar32:0)"',
  'wmctl drag $SID 390 55 390 $((SBY-20))',       // thumb drag to the bottom
  'wmctl click $SID 30 40',
  'n=0; while [ $n -lt 40 ]; do [ "$(wmctl gettext msctls_statusbar32:0)" = "$PG" ] || break; sleep 0.1; n=$((n+1)); done',
  'echo ==thumbdrag',
  'wmctl gettext msctls_statusbar32:0',
  'echo ==cut',
  // ---- WM_MOUSEWHEEL scrolls the EDIT (todos/0210): 3 lines/notch ----
  // The wheel event carries the LAST tracked mouse position — hover over
  // the EDIT first so user32's pump hit-tests the wheel to it.
  'TD="$(wmctl gettext msctls_statusbar32:0)"',
  'wmctl hover $SID 200 150',
  'wmctl wheel $SID 2',                           // 2 notches up = -6 lines
  'wmctl click $SID 30 40',
  'n=0; while [ $n -lt 40 ]; do [ "$(wmctl gettext msctls_statusbar32:0)" = "$TD" ] || break; sleep 0.1; n=$((n+1)); done',
  'echo ==wheelup',
  'wmctl gettext msctls_statusbar32:0',
  'echo ==cut',
  'WU="$(wmctl gettext msctls_statusbar32:0)"',
  'wmctl wheel $SID -1',                          // 1 notch down = +3 lines
  'wmctl click $SID 30 40',
  'n=0; while [ $n -lt 40 ]; do [ "$(wmctl gettext msctls_statusbar32:0)" = "$WU" ] || break; sleep 0.1; n=$((n+1)); done',
  'echo ==wheeldn',
  'wmctl gettext msctls_statusbar32:0',
  'echo ==cut',
  'wmctl wheel $SID 99',                          // clamp at the top
  'wmctl click $SID 30 40',
  'wmctl wait text msctls_statusbar32:0 "Line 1," 4000',
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
  'wmctl wait nowin "crlf.txt - Notepad" 6000',   // No discards -> notepad exits
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
function maxInkRow(P, x0, x1, y0, y1) {          // last row with any dark px
  let m = y0 - 1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = P.data + (y * P.w + x) * 3;
    if (P.buf[i] < 100 && P.buf[i + 1] < 100 && P.buf[i + 2] < 100) { m = y; break; }
  }
  return m;
}
const sp = parsePpm(section(out, 'sbarshot'));
check('status-bar shot is a P6 frame', sp.magic === 'P6', sp.magic);
// The status-bar height is FONT-DERIVED (0229), so every pixel check anchors
// on the live rect from the tree dump (never a hardcoded 20): the bar parks
// at the client bottom == the surface bottom, so its surface top is h-H.
const sbTreeRow = tree1.split('\n').find(l => /class=msctls_statusbar32/.test(l)) || '';
const sbH = +((sbTreeRow.match(/rect=-?\d+,-?\d+ \d+x(\d+) /) || [])[1] || 0);
const bx = sp.w - 120, by = sp.h - sbH;   // pane2|pane3 border sits at width-120
/* 0229 red->green pins: the old SB_H 20 + y=3 Win95 arithmetic sat the 19px
 * stock-font cell 3px low — baseline ON the well's border row, descenders
 * clipped by ETO_CLIPPED. Font-derived height + DT_VCENTER fixes all three. */
check('status-bar height derives from the stock font cell (0229)',
  sbH >= 23, 'H=' + sbH + ' row=' + JSON.stringify(sbTreeRow.slice(0, 120)));
check('no text ink on the well bottom border row (part 1)',
  darkCount(sp, 2, 110, by + sbH - 2, by + sbH - 1) === 0,
  'ink=' + darkCount(sp, 2, 110, by + sbH - 2, by + sbH - 1));
const eolnMax = maxInkRow(sp, sp.w - 238, sp.w - 125, by + 1, by + sbH - 1);
const utf8Max = maxInkRow(sp, sp.w - 118, sp.w - 80, by + 1, by + sbH - 1);
check('descenders survive: EOLN "(" reaches >=3 rows below the UTF-8 caps',
  eolnMax - utf8Max >= 3, 'eoln=' + eolnMax + ' utf8=' + utf8Max);
const bleed = darkCount(sp, bx - 1, bx + 6, by + 2, by + sbH - 2);   // 6px past the border
const utf8 = darkCount(sp, bx + 6, bx + 40, by + 2, by + sbH - 2);   // the "UTF-8" glyphs
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
// gucOS is POSIX (todos/0210): the EDIT strips the \r notepad's loader
// re-adds (ReplaceNewLines normalizes to CRLF before EM_SETHANDLE), so the
// buffer — and everything downstream of WM_GETTEXT — is pure LF.
check('Open loaded readme.txt into the EDIT (LF, \\r stripped)',
  section(out, 'content1').trim() === 'alpha beta\ngamma beta delta',
  JSON.stringify(section(out, 'content1')));
check('status bar shows the detected EOLN (Unix LF)',
  /Unix \(LF\)/.test(section(out, 'bar1')), section(out, 'bar1'));

/* Replace All */
check('Replace All rewrote both matches (FINDREPLACE protocol)',
  section(out, 'content2').trim() === 'alpha BEE\ngamma BEE delta',
  JSON.stringify(section(out, 'content2')));

/* clipboard */
check('Select All + Copy filled the clipboard slot',
  section(out, 'clip').trim() === 'alpha BEE\ngamma BEE delta',
  JSON.stringify(section(out, 'clip')));

/* CRLF round-trip (todos/0210) */
const crlfLoad = section(out, 'crlfload');
check('CRLF file loads with every \\r stripped (EM_SETHANDLE path)',
  !crlfLoad.includes('\r') && crlfLoad.trim() === 'cr one\ncr two\ncr three',
  JSON.stringify(crlfLoad));
const crlfSaved = section(out, 'crlfsaved');
check('save keeps LF: no \\r written back to the filesystem',
  !crlfSaved.includes('\r') && crlfSaved.replace('z', '').trim() === 'cr one\ncr two\ncr three',
  JSON.stringify(crlfSaved));
check('WM_SETTEXT strips \\r\\n and lone \\r (agent settext path)',
  section(out, 'setcr').trim() === 'st one\nst two\nst three',
  JSON.stringify(section(out, 'setcr')));

/* the built-in WS_VSCROLL scrollbar (todos/0210) */
const sbp = parsePpm(section(out, 'sbshot'));
check('EDIT scrollbar shot is a P6 frame', sbp.magic === 'P6', sbp.magic);
// The channel paints COLOR_SCROLLBAR gray (192,192,192) where an unscrolled
// pre-0210 EDIT was white text area: sample the bar column below the thumb.
// All rows hang off the tree-derived EDIT bottom (EB = surface bottom minus
// the font-derived status bar, 0229) — never a hardcoded 20px bar.
const EB = sbp.h - sbH;                       // EDIT surface bottom
let sbGray = 0;
for (let y = 120; y < EB - 44; y++) {         // channel, above the down arrow
  for (let x = 386; x < 396; x++) {
    const i = sbp.data + (y * sbp.w + x) * 3;
    if (Math.abs(sbp.buf[i] - 192) < 12 && Math.abs(sbp.buf[i + 1] - 192) < 12 &&
        Math.abs(sbp.buf[i + 2] - 192) < 12) sbGray++;
  }
}
check('WS_VSCROLL draws the right-edge scrollbar channel', sbGray > 400,
  'gray=' + sbGray + ' of ' + (EB - 44 - 120) * 10);
// The WS_HSCROLL bar (0211): a gray strip along the EDIT's bottom edge
// (the interior's bottom 16px, EB-18..EB-2) where pre-0211 was white text.
let hbGray = 0;
for (let y = EB - 16; y < EB - 4; y++) {
  for (let x = 60; x < 320; x++) {
    const i = sbp.data + (y * sbp.w + x) * 3;
    if (Math.abs(sbp.buf[i] - 192) < 12 && Math.abs(sbp.buf[i + 1] - 192) < 12 &&
        Math.abs(sbp.buf[i + 2] - 192) < 12) hbGray++;
  }
}
check('WS_HSCROLL draws the bottom-edge scrollbar', hbGray > 1500,
  'gray=' + hbGray + ' of 3120');
const pgdnLine = +((section(out, 'pgdn').match(/Line (\d+),/) || [])[1] || 0);
check('channel click below the thumb pages down (caret probe on the top row)',
  pgdnLine >= 8 && pgdnLine <= 30, 'line=' + pgdnLine);
const dragLine = +((section(out, 'thumbdrag').match(/Line (\d+),/) || [])[1] || 0);
check('thumb drag scrolls to the bottom of the document',
  dragLine >= 60, 'line=' + dragLine + ' pgdn=' + pgdnLine);

/* WM_MOUSEWHEEL scrolls the EDIT (todos/0210) */
const wheelUp = +((section(out, 'wheelup').match(/Line (\d+),/) || [])[1] || 0);
check('wheel scrolls 3 lines per notch (2 notches up = -6 lines)',
  wheelUp === dragLine - 6, 'wheelup=' + wheelUp + ' drag=' + dragLine);
const wheelDn = +((section(out, 'wheeldn').match(/Line (\d+),/) || [])[1] || 0);
check('wheel down scrolls back (+3 lines)',
  wheelDn === wheelUp + 3, 'wheeldn=' + wheelDn + ' wheelup=' + wheelUp);

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
