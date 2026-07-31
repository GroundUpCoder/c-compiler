#!/usr/bin/env node
// 0048 acceptance, headless: calc (the ReactOS calculator port) usable
// in-OS through os/boot.js. Covers the 0048 veneer tail:
//   - WRES v2 template MENU: the standard dialog attaches its menu bar
//     (surface = template client + MENU_BAR_H; tree lists Edit/View/Help)
//   - owner-drawn keypad: BS_OWNERDRAW -> WM_DRAWITEM ->
//     DrawFrameControl/DrawStateW paint real button faces + labels, and
//     BM_CLICK works on them BY LABEL — numeric labels included (the
//     wmctl `click <one-arg>`-is-always-a-label rule is new in 0048)
//   - keyboard: WM_KEYDOWN -> calc's vk2ascii -> GetKeyboardState /
//     MapVirtualKeyEx / ToAsciiEx
//   - the clipboard: Copy fills the kernel slot (CF_UNICODETEXT -> UTF-8;
//     todos/0090 — read back via /bin/clip), Paste reads it (CF_TEXT),
//     WM_ENTERMENULOOP re-grays the Paste item from
//     IsClipboardFormatAvailable
//   - TrackPopupMenu: right-click -> WM_CONTEXTMENU -> a standalone
//     popup that is agent-visible ("popupmenu" in the tree) and fires
//     by label (TPM_RETURNCMD)
//   - the View switch: menu command destroys + recreates the dialog on
//     the scientific template
//
// Run: node tests/kernel/test_calc_e2e.js
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

const { dir: tmp, image } = freshImage('os-calc-');

function boot(script) {
  return driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 }).stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

/* The menu-BAR dropdowns (Edit/View) draw IN-SURFACE — they are not WM windows,
 * and their per-item enable/gray state (WM_ENTERMENULOOP) lives only in the
 * `wmctl tree` dump keyed by item id, which the 0154 label/text wait can't
 * target. So the open/ESC-close sleeps around them stay annotated timing
 * subjects (0083 rule); everything with a window/label/text/clipboard signal is
 * converted. Copy is async into the kernel clip slot — poll clip -o for it. */
const waitClip = (v) =>
  `for i in $(seq 1 120); do [ "$(clip -o 2>/dev/null)" = "${v}" ] && break; sleep 0.05; done`;

/* One boot, the whole story. Display reads address the output STATIC as
 * STATIC:0 (first STATIC in tree order on the standard template). */
const out = boot([
  'calc &',
  // Boot barrier (todos/0154): the "7" keypad button resolving in the agent tree
  // means the dialog + owner-draw keypad are up and calc is pumping messages.
  'wmctl wait label 7 10000',
  'SID=$(wmctl list | grep Calculator$ | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // menu enable state BEFORE any copy: empty clipboard grays Paste at
  // WM_ENTERMENULOOP. In-surface popup, tree-only gray state -> annotated sleep.
  'wmctl click $SID 10 10',                      // Edit bar title
  'sleep 0.5',                                   // in-surface menu open (no window/label signal)
  'echo ==menotree',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',                        // ESC closes the popup
  'sleep 0.5',                                   // in-surface menu close (modal; no signal)
  // keypad by label: 7 + 3 = -> 10. Agent BM_CLICKs serialize; wait for the
  // result text to land in the display instead of guessing.
  'wmctl click 7',
  'wmctl click +',
  'wmctl click 3',
  'wmctl click =',
  'wmctl wait text STATIC:0 "10." 4000',
  'echo ==disp1',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // Copy -> the kernel clipboard slot (0090); poll it (fills asynchronously).
  'wmctl click Copy',
  waitClip('10'),
  'echo ==clip',
  'clip -o',
  'echo',
  'echo ==cut',
  // Paste enable state now that the clipboard has text (in-surface menu again).
  'wmctl click $SID 10 10',
  'sleep 0.5',                                   // in-surface menu open (no window/label signal)
  'echo ==meyestree',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'sleep 0.5',                                   // in-surface menu close (modal; no signal)
  // keyboard entry: 9 then 1 (starts a fresh operand after =)
  'wmctl key $SID 38 57',                        // '9'
  'wmctl key $SID 30 49',                        // '1'
  'wmctl wait text STATIC:0 "91." 4000',
  'echo ==disp2',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // Paste replaces the entry (CF_TEXT read of what the shell wrote)
  'printf 250 | clip',
  'wmctl click Paste',
  'wmctl wait text STATIC:0 "250." 4000',
  'echo ==disp3',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // TrackPopupMenu: right-click a keypad button -> agent-visible popup. Wait on
  // the popup's own item label appearing / going (it exists only while shown).
  // The click center is COMPUTED from the '7' button's live tree rect (+20
  // for the in-surface menu bar): dialog layout scales with the stock font
  // metrics, so a fixed coordinate is one face swap away from landing in a
  // keypad gap (the Phase D Noto swap moved the keypad 8px down).
  'R=$(wmctl tree | grep "text=.7.$" | head -1)',
  'BX=$(echo "$R" | sed "s/.*rect=\\([0-9]*\\),.*/\\1/")',
  'BY=$(echo "$R" | sed "s/.*rect=[0-9]*,\\([0-9]*\\) .*/\\1/")',
  'wmctl click $SID $((BX+24)) $((BY+22+30)) 3',
  'wmctl wait label "Quick help" 4000',
  'echo ==ctxtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click "Quick help"',
  'wmctl wait nolabel "Quick help" 4000',
  'echo ==ctxdone',
  'wmctl tree',
  'echo ==cut',
  // View -> Scientific: dialog recreated on the other template. The scientific
  // template's "Hex" radio appearing marks the recreate complete.
  'wmctl click Scientific',
  'wmctl wait label Hex 8000',
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  'echo ==scitree',
  'wmctl tree',
  'echo ==cut',
  // ---- #310: geometry must round-trip across dialog recreates. Back to
  // Standard (recreate 2), then Scientific again (recreate 3): pre-fix every
  // recreate's WM_INITDIALOG restore (GetWindowRect -> MoveWindow) shrank
  // the menued dialog by MENU_BAR_H. 'Hex' exists only on the scientific
  // template, so its absence/presence marks each recreate settled.
  'wmctl click Standard',
  'wmctl wait nolabel Hex 8000',
  'wmctl wait label 7 8000',
  'echo ==stdlist',
  'wmctl list',
  'echo ==cut',
  'echo ==stdtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Scientific',
  'wmctl wait label Hex 8000',
  'echo ==sci2list',
  'wmctl list',
  'echo ==cut',
  'echo ==sci2tree',
  'wmctl tree',
  'echo ==cut',
  // ---- #275: the Statistics box (scientific-only) — reachable in-OS, laid
  // out un-clipped, and its WS_VSCROLL LISTBOX scrolls with the MOUSE. Six
  // single-digit data points ("C" clears the entry between them so row k is
  // exactly "k" — the stat list renders without the display's trailing dot); 6 items overflow the 4 visible rows, so the bar shows.
  'wmctl click Sta',
  'wmctl wait win "Statistics box" 8000',
  'SSID=$(wmctl list | grep "Statistics box$" | sed "s/[^0-9].*//")',
  ...[1, 2, 3, 4, 5, 6].flatMap((k) => [
    `wmctl click ${k}`, 'wmctl click Dat', 'wmctl click C',
  ]),
  'wmctl wait text LISTBOX:0 "6" 6000',
  'echo ==statlist',
  'wmctl list',
  'echo ==cut',
  'echo ==stattree',
  'wmctl tree',
  'echo ==cut',
  // The listbox rect drives the click coordinates (the stat dialog has no
  // menu bar, so tree rects ARE surface coords). Down arrow at the gutter
  // foot scrolls one row; the first visible row is then item 1 ("2.") —
  // without a working bar the click would select item 0.
  'R=$(wmctl tree | grep "class=LISTBOX" | head -1)',
  'LX=$(echo "$R" | sed "s/.*rect=\\([0-9]*\\),.*/\\1/")',
  'LY=$(echo "$R" | sed "s/.*rect=[0-9]*,\\([0-9]*\\) .*/\\1/")',
  'LW=$(echo "$R" | sed "s/.*rect=[0-9]*,[0-9]* \\([0-9]*\\)x.*/\\1/")',
  'LH=$(echo "$R" | sed "s/.*rect=[0-9]*,[0-9]* [0-9]*x\\([0-9]*\\).*/\\1/")',
  'wmctl click $SSID $((LX+LW-8)) $((LY+LH-8))',
  'wmctl click $SSID $((LX+20)) $((LY+8))',
  'echo ==statsel',
  'wmctl tree',
  'echo ==cut',
  '',
].join('\n'));

/* window + template menu */
const list1 = section(out, 'list1');
const row1 = list1.split('\n').find(l => l.endsWith('\tCalculator')) || '';
check('window titled "Calculator"', row1 !== '', JSON.stringify(list1.slice(0, 300)));
/* C2 (#282): dialog DLU width scales by the stock font's tmAveCharWidth/4
 * — sans avgw 11 vs mono's 12, so the 169-DLU standard template lands at
 * 464 (169*11/4+ceil), not 507. Height keys on tmHeight, identical for
 * both 20px faces, so it did not move. */
check('standard surface is 464x478 (template client + 30px menu bar; 20px sans stock)',
  row1.includes('464x478'), row1);
check('window is fixed-size (no R flag)', !(row1.split('\t')[5] || '').includes('R'), row1);

const tree1 = section(out, 'tree1');
check('template MENU attached (WRES v2): Edit popup', /menu popup text='Edit'/.test(tree1), tree1.slice(0, 400));
check('View popup with Standard checked', /menuitem id=40004 text='Standard' checked/.test(tree1), tree1);
check('display STATIC starts at 0.', /class=STATIC id=1074 [^\n]*text='0\.'/.test(tree1), tree1);
check('owner-draw keypad buttons in the tree (7 present)',
  /class=BUTTON [^\n]*text='7'/.test(tree1), tree1);

/* menu enable state from the clipboard */
check('empty clipboard: Paste grayed at WM_ENTERMENULOOP',
  /menuitem id=40003 text='Paste' grayed/.test(section(out, 'menotree')), section(out, 'menotree'));
check('after Copy: Paste enabled',
  /menuitem id=40003 text='Paste'\n/.test(section(out, 'meyestree')), section(out, 'meyestree'));

/* arithmetic + clipboard */
check('7 + 3 = -> 10. (BM_CLICK by numeric label)',
  section(out, 'disp1').trim() === '10.', JSON.stringify(section(out, 'disp1')));
check('Copy filled the clipboard slot (trailing separator trimmed)',
  section(out, 'clip').trim() === '10', JSON.stringify(section(out, 'clip')));
check('keyboard 9,1 -> 91. (ToAsciiEx path)',
  section(out, 'disp2').trim() === '91.', JSON.stringify(section(out, 'disp2')));
check('Paste of 250 -> 250.',
  section(out, 'disp3').trim() === '250.', JSON.stringify(section(out, 'disp3')));

/* TrackPopupMenu */
const ctx = section(out, 'ctxtree');
check('right-click opens the context popup (agent-visible)',
  /popupmenu\n\s+menuitem id=40014 text='Quick help'/.test(ctx), ctx.slice(-300));
check('popup item fires by label and the popup closes',
  !/popupmenu/.test(section(out, 'ctxdone')), section(out, 'ctxdone').slice(-200));

/* view switch */
const list2 = section(out, 'list2');
const row2 = list2.split('\n').find(l => l.endsWith('\tCalculator')) || '';
/* 869x600 measured off this test's own live `wmctl list` (#310 re-pin —
 * the old 869x570 pin was the post-shrink surface: the pre-fix
 * WM_INITDIALOG restore lost MENU_BAR_H). 316-DLU template at sans
 * avgw 11, 570 client + 30 bar. */
check('View->Scientific recreates the dialog (869x600 surface; the 316-DLU template at sans avgw 11)',
  row2.includes('869x600'), row2);
check('scientific template has the base radios',
  /class=BUTTON [^\n]*text='Hex'/.test(section(out, 'scitree')), section(out, 'scitree').slice(0, 400));
/* #311: the template's `NOT WS_VISIBLE` controls must ARRIVE hidden — the
 * Dword/Word/Byte width radios share coordinates with the visible
 * Degrees/Radians/Gradians set and painted through them pre-fix. */
check('#311: NOT WS_VISIBLE width radios arrive hidden (Dword vis=0)',
  /class=BUTTON [^\n]*vis=0 [^\n]*text='Dword'/.test(section(out, 'scitree')),
  (section(out, 'scitree').match(/[^\n]*text='Dword'[^\n]*/) || [])[0]);
check('#311: the angle radios stay visible (Degrees vis=1)',
  /class=BUTTON [^\n]*vis=1 [^\n]*text='Degrees'/.test(section(out, 'scitree')),
  (section(out, 'scitree').match(/[^\n]*text='Degrees'[^\n]*/) || [])[0]);

/* ---- #310: no Calculator control may exceed the dialog's CLIENT (the
 * tree root's rect) — pre-fix the WM_INITDIALOG GetWindowRect->MoveWindow
 * restore shrank the surface by MENU_BAR_H per recreate and the bottom
 * keypad row clipped (Dat spanned y=490..553 in a 540 client). Checked on
 * all three recreates. */
function checkNoClip(sec, label) {
  const lines = section(out, sec).split('\n');
  const rootIdx = lines.findIndex(l => /class=#32770 [^\n]*text='Calculator'/.test(l));
  check(`${label}: Calculator dialog in the tree`, rootIdx >= 0);
  if (rootIdx < 0) return;
  const rm = lines[rootIdx].match(/rect=-?\d+,-?\d+ (\d+)x(\d+)/);
  const CW = +rm[1], CH = +rm[2];
  const indent = (lines[rootIdx].match(/^\s*/) || [''])[0].length;
  const kids = [];
  for (let i = rootIdx + 1; i < lines.length; i++) {
    const li = (lines[i].match(/^\s*/) || [''])[0].length;
    if (lines[i].trim() === '' || li <= indent) break;
    const m = lines[i].match(/class=(\S+) id=(-?\d+) [^\n]*rect=(-?\d+),(-?\d+) (\d+)x(\d+)[^\n]*vis=(\d)/);
    if (m && m[7] === '1')
      kids.push({ cls: m[1], id: m[2], x: +m[3], y: +m[4], w: +m[5], h: +m[6] });
  }
  check(`${label}: controls parsed`, kids.length > 10, String(kids.length));
  const outside = kids.filter(k => k.x < 0 || k.y < 0 || k.x + k.w > CW || k.y + k.h > CH);
  check(`${label}: no visible control clips the ${CW}x${CH} client`,
    outside.length === 0, JSON.stringify(outside));
}
checkNoClip('scitree', '#310 recreate 1 (scientific)');
checkNoClip('stdtree', '#310 recreate 2 (standard)');
checkNoClip('sci2tree', '#310 recreate 3 (scientific)');

const stdrow = section(out, 'stdlist').split('\n').find(l => l.endsWith('\tCalculator')) || '';
check('#310: standard recreate keeps the created 464x478 surface (no MENU_BAR_H shrink)',
  stdrow.includes('464x478'), stdrow);
const sci2row = section(out, 'sci2list').split('\n').find(l => l.endsWith('\tCalculator')) || '';
check('#310: scientific recreate keeps the created 869x600 surface',
  sci2row.includes('869x600'), sci2row);

/* ---- #275: the Statistics box ---- */
const statlist = section(out, 'statlist');
const statrow = statlist.split('\n').find(l => l.endsWith('\tStatistics box')) || '';
check('Sta opens the Statistics box (reachable in scientific mode)',
  statrow !== '', JSON.stringify(statlist.slice(0, 300)));

const stattree = section(out, 'stattree');
check('six data points landed in the stat LISTBOX',
  (stattree.match(/lbrow i=\d/g) || []).length === 6 &&
  /lbrow i=5 [^\n]*text='6'/.test(stattree), stattree.slice(-500));
check('n=6 tallied', /class=STATIC [^\n]*text='n=6'/.test(stattree), stattree.slice(-400));

/* Mouse scroll: the down-arrow click moved the view one row, so the click
 * on the first VISIBLE row selected item 1 — pre-#275 (no bar) the same
 * click would select item 0. */
check('stats box scrolls with the mouse (first visible row is item 1)',
  /lbrow i=1 sel/.test(section(out, 'statsel')), section(out, 'statsel').slice(-500));

/* Layout integrity at the C2-narrowed geometry (handed down with #282's
 * re-pin: nothing asserted clipping). Every stat-dialog control must sit
 * inside the dialog surface, and no two may overlap. The subtree is the
 * lines under the 'Statistics box' #32770 up to the next same-indent line. */
{
  const lines = stattree.split('\n');
  const rootIdx = lines.findIndex(l => /class=#32770 [^\n]*text='Statistics box'/.test(l));
  check('Statistics box dialog in the tree', rootIdx >= 0);
  if (rootIdx >= 0 && statrow) {
    const indent = (lines[rootIdx].match(/^\s*/) || [''])[0].length;
    const kids = [];
    for (let i = rootIdx + 1; i < lines.length; i++) {
      const li = (lines[i].match(/^\s*/) || [''])[0].length;
      if (lines[i].trim() === '' || li <= indent) break;
      const m = lines[i].match(/class=(\S+) id=(-?\d+) [^\n]*rect=(\d+),(\d+) (\d+)x(\d+)/);
      if (m) kids.push({ cls: m[1], id: m[2], x: +m[3], y: +m[4], w: +m[5], h: +m[6] });
    }
    const dims = (statrow.match(/(\d+)x(\d+)/) || []);
    const SW = +dims[1], SH = +dims[2];
    check('stat dialog has its 6 controls in the tree', kids.length === 6,
      JSON.stringify(kids));
    const outside = kids.filter(k => k.x < 0 || k.y < 0 || k.x + k.w > SW || k.y + k.h > SH);
    check(`no stat-dialog control clips the ${SW}x${SH} surface`,
      outside.length === 0, JSON.stringify(outside));
    const overlaps = [];
    for (let i = 0; i < kids.length; i++)
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i], b2 = kids[j];
        if (a.x < b2.x + b2.w && b2.x < a.x + a.w &&
            a.y < b2.y + b2.h && b2.y < a.y + a.h)
          overlaps.push([a, b2]);
      }
    check('no two stat-dialog controls overlap', overlaps.length === 0,
      JSON.stringify(overlaps));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
