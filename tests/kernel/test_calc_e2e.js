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
//   - the clipboard: Copy writes $HOME/.clipboard (CF_UNICODETEXT ->
//     UTF-8 file), Paste reads it (CF_TEXT), WM_ENTERMENULOOP re-grays
//     the Paste item from IsClipboardFormatAvailable
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

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-calc-'));
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

/* One boot, the whole story. Display reads address the output STATIC as
 * STATIC:0 (first STATIC in tree order on the standard template). */
const out = boot([
  'calc &',
  'sleep 5',
  'SID=$(wmctl list | grep Calculator$ | sed "s/[^0-9].*//")',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // menu enable state BEFORE any copy: empty clipboard grays Paste at
  // WM_ENTERMENULOOP (the popup must actually open)
  'wmctl click $SID 10 10',                      // Edit bar title
  'sleep 0.5',
  'echo ==menotree',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',                        // ESC closes the popup
  'sleep 0.5',
  // keypad by label: 7 + 3 = -> 10.
  'wmctl click 7',
  'wmctl click +',
  'wmctl click 3',
  'wmctl click =',
  'sleep 0.5',
  'echo ==disp1',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // Copy -> the clipboard file
  'wmctl click Copy',
  'sleep 0.5',
  'echo ==clip',
  'cat /root/.clipboard',
  'echo',
  'echo ==cut',
  // Paste enable state now that the clipboard has text
  'wmctl click $SID 10 10',
  'sleep 0.5',
  'echo ==meyestree',
  'wmctl tree',
  'echo ==cut',
  'wmctl key $SID 41 27',
  'sleep 0.5',
  // keyboard entry: 9 then 1 (starts a fresh operand after =)
  'wmctl key $SID 38 57',                        // '9'
  'wmctl key $SID 30 49',                        // '1'
  'sleep 0.5',
  'echo ==disp2',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // Paste replaces the entry (CF_TEXT read of what Copy wrote elsewhere)
  'printf 250 > /root/.clipboard',
  'wmctl click Paste',
  'sleep 0.5',
  'echo ==disp3',
  'wmctl gettext STATIC:0',
  'echo ==cut',
  // TrackPopupMenu: right-click a keypad button -> agent-visible popup
  'wmctl click $SID 100 130 3',
  'sleep 0.5',
  'echo ==ctxtree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click "Quick help"',
  'sleep 0.5',
  'echo ==ctxdone',
  'wmctl tree',
  'echo ==cut',
  // View -> Scientific: dialog recreated on the other template
  'wmctl click Scientific',
  'sleep 4',
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
check('standard surface is 338x324 (template client 338x304 + menu bar)',
  row1.includes('338x324'), row1);
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
check('Copy wrote the clipboard file (trailing separator trimmed)',
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
check('View->Scientific recreates the dialog (632x387 surface)',
  row2.includes('632x387'), row2);
check('scientific template has the base radios',
  /class=BUTTON [^\n]*text='Hex'/.test(section(out, 'scitree')), section(out, 'scitree').slice(0, 400));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `FAILURES: ${failures}` : 'ALL OK');
process.exit(failures ? 1 : 0);
