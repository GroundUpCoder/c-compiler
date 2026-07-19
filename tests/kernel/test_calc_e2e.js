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
  '',
].join('\n'));

/* window + template menu */
const list1 = section(out, 'list1');
const row1 = list1.split('\n').find(l => l.endsWith('\tCalculator')) || '';
check('window titled "Calculator"', row1 !== '', JSON.stringify(list1.slice(0, 300)));
check('standard surface is 507x478 (template client + 30px menu bar; 20px stock cell)',
  row1.includes('507x478'), row1);
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
check('View->Scientific recreates the dialog (948x570 surface; 20px stock cell)',
  row2.includes('948x570'), row2);
check('scientific template has the base radios',
  /class=BUTTON [^\n]*text='Hex'/.test(section(out, 'scitree')), section(out, 'scitree').slice(0, 400));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
