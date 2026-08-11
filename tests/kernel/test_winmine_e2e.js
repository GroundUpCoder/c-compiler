#!/usr/bin/env node
// 0068 acceptance, headless: winmine (the ReactOS/Wine Minesweeper port)
// playable in-OS through os/boot.js. Covers the whole user32/resource tail:
//   - the sidecar resource pack: LoadStringW titles the class/window
//     ("WineMine"), LoadBitmapW feeds the board BitBlts, LoadMenuW attaches
//     the class menu, LoadAcceleratorsW arms F2
//   - the menu bar: geometry (surface = board + MENU_BAR_H), popup opens on
//     a bar click (pixels appear), ESC closes, items are agent targets
//     (`wmctl click Advanced` — no pixels), CheckMenuItem state in the tree
//   - owner-initiated resize end to end (SDL_SetWindowSize -> kernel
//     SURFACE_RESIZE -> RESIZED -> configure): difficulty switches change
//     the surface geometry
//   - gameplay: a cell click reveals (pixel diff in the mines rect), the
//     WM_TIMER second counter runs (timer LED pixels change), F2 (the
//     accelerator) resets the board to its unrevealed pixels
//   - DialogBoxParamW from the RT_DIALOG template: the Custom Game dialog
//     is a second surface with live EDITs (agent settext) + OK applies
//     (GetDlgItemInt path) and resizes the board; Fastest Times shows the
//     LoadStringW default "Nobody"
//   - registry persistence: Exit (menu) -> WM_DESTROY SaveBoard; a second
//     boot restores the custom geometry (LoadBoard over advapi32)
//
// Geometry mirrors vendor/winmine/main.h: MINE_WIDTH/HEIGHT 16, LED_HEIGHT
// 23, BOARD_W/HMARGIN 5 — beginner 9x9 board => client 154x182, surface
// 154x212 (MENU_BAR_H 30). Change together with os/win32/user32.c.
//
// Run: node tests/kernel/test_winmine_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-winmine-');

let bootErr = '';                                // stderr of the LAST boot()
function boot(script) {
  const r = driveBoot(script, { image, maxBuffer: 64 * 1024 * 1024 });
  bootErr = String(r.stderr || '');
  return r.stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

/* Shots are written in-OS under /root; a follow-up boot session cats the
 * concatenation to stdout (the test_gdi32_e2e pattern) and we split the
 * PNG stream back into images here (parsePng walks it by `next`). */
const SHOTS = ['bar', 'base', 'popup', 'closed', 'fresh', 'revealed', 'ticking', 'reset'];
const shots = {};

function extractShots() {
  const r = driveBoot('cat ' + SHOTS.map(n => '/root/' + n + '.png').join(' ') + '\n',
    { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  const buf = r.stdout;
  let off = 0;
  for (const name of SHOTS) {
    let p;
    try { p = parsePng(buf, off); }
    catch (e) { throw new Error('bad png stream at ' + name + ': ' + e.message); }
    shots[name] = { w: p.w, h: p.h, data: p.rgba };
    off = p.next;
  }
}

function crop(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r++)
    img.data.copy(out, r * w * 4, ((y + r) * img.w + x) * 4, ((y + r) * img.w + x + w) * 4);
  return out;
}

function readShot(name) { return shots[name.replace('.png', '')]; }

/* Geometry (main.h mirror). Client coords + the 20px menu bar on top. */
const BAR = 30;
const BEG_W = 9 * 16 + 10, BEG_H = 9 * 16 + 23 + 15;        /* 154 x 182 */
const ADV_W = 16 * 16 + 10, ADV_H = 16 * 16 + 23 + 15;      /* 266 x 294 */
const CUS_W = 11 * 16 + 10, CUS_H = 12 * 16 + 23 + 15;      /* 186 x 215 */
/* mines rect: left 5, top 33 (2*5 + 23); cell (1,1) center in surface coords */
const CELL_X = 5 + 8, CELL_Y = 33 + 8 + BAR;
/* timer LEDs: right-aligned counter is mines-left; TIMER is bottom-left..
 * DrawBoard: counter at left? -- main.c: counter_rect is RIGHT (width -
 * margin - 3 LEDs), timer_rect is LEFT (x=5). Timer region below. */
const TIMER = { x: 5, y: 5 + BAR, w: 36, h: 23 };

/* Difficulty/Custom changes are owner-initiated SURFACE_RESIZEs — the new board
 * geometry shows in `wmctl list`, so poll for it (todos/0154 — a bounded
 * condition poll, not a fixed sync sleep). Menu open/close is waitable since
 * 0257 (the popup is a real "#32768" child window); only the gameplay shots
 * (revealed cells, the WM_TIMER LED) remain pixel-only annotated settles. */
const waitGeom = (d) =>
  `for i in $(seq 1 120); do wmctl list | grep -q "${d}" && break; sleep 0.05; done`;

/* ---- session A: the whole interactive story in one boot ---- */
const out = boot([
  'winmine &',
  // Boot barrier: the top-level window's TEXT resolving through the agent
  // socket means winmine is pumping/serving (LoadMenuW ran before the loop) —
  // so the window is listed too. NB items of a CLOSED menu ("Advanced") are
  // deliberately not GETTEXT-resolvable (0171) — waiting on one is a dead wait.
  'wmctl wait label WineMine 10000',
  'SID=$(wmctl list | grep "WineMine$" | sed "s/[^0-9].*//")',
  // 0280: the menu bar lives on its own strip child surface ("menubar");
  // shot it for the "last title fits" pixel probe below.
  'MSID=$(wmctl list | grep "menubar$" | sed "s/[^0-9].*//")',
  'wmctl shot $MSID /root/bar.png',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  // menu popup (0257): a bar click opens a REAL anchored child window
  // ("#32768" in wmctl list — a waitable marker; the old in-surface popup
  // needed blind pixel settles). The parent's own buffer must NOT change:
  // the popup never overwrites client pixels anymore (couplings #1/#4).
  'wmctl shot $SID /root/base.png',
  'wmctl click $SID 10 10',
  'wmctl wait win "#32768" 8000',                // popup child window is up
  'wmctl shot $SID /root/popup.png',             // parent buffer: untouched
  'wmctl key $SID 41 27',                        // ESC closes the popup
  'wmctl wait nowin "#32768" 8000',              // and its window is gone
  'wmctl shot $SID /root/closed.png',
  // difficulty via the agent path (menu items by label, no pixels)
  'wmctl click Advanced',
  waitGeom(`${ADV_W}x${ADV_H + BAR}`),           // board resized (SURFACE_RESIZE)
  'echo ==list2',
  'wmctl list',
  'echo ==cut',
  'wmctl click Beginner',
  waitGeom(`${BEG_W}x${BEG_H + BAR}`),           // resized back
  'echo ==list3',
  'wmctl list',
  'echo ==cut',
  // 0145 gap #13: SND_RESOURCE is silent success BY DESIGN (assets not
  // vendored, 0068) but must REPORT once — enable Options>Sound so the
  // first reveal below fires PlaySound(SND_RESOURCE); assert on stderr.
  'wmctl click Sound',
  // gameplay: reveal a cell, timer runs, F2 resets. All pixel-diff shots with
  // no non-pixel observable, so the render/timer settles stay annotated.
  'wmctl shot $SID /root/fresh.png',
  `wmctl click $SID ${CELL_X} ${CELL_Y}`,
  'sleep 1',                                     // cell reveal paint (pixel-only)
  'wmctl shot $SID /root/revealed.png',
  'sleep 2',                                     // >= 1 full WM_TIMER tick (genuine timing subject)
  'wmctl shot $SID /root/ticking.png',
  'wmctl key $SID 59 1073741883',                // F2 = New (accelerator)
  'sleep 1',                                     // board reset paint (pixel-only)
  'wmctl shot $SID /root/reset.png',
  // Fastest Times dialog: template + LoadStringW default names
  'wmctl click "Fastest Times..."',
  'wmctl wait win "Fastest Times" 6000',
  'echo ==timestree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click OK',
  'wmctl wait nowin "Fastest Times" 6000',
  // Custom Game dialog: settext the EDITs, OK applies + resizes
  'wmctl click "Custom..."',
  'wmctl wait win "Custom Game" 6000',
  'echo ==customtree',
  'wmctl tree',
  'echo ==cut',
  'echo ==customlist',
  'wmctl list',
  'echo ==cut',
  'wmctl settext EDIT:0 12',                     // rows
  'wmctl settext EDIT:1 11',                     // cols
  'wmctl settext EDIT:2 20',                     // mines
  'wmctl click OK',
  waitGeom(`${CUS_W}x${CUS_H + BAR}`),           // OK applied + resized the board
  'echo ==list4',
  'wmctl list',
  'echo ==cut',
  // Exit via the menu; SaveBoard -> the registry hive (written on WM_DESTROY,
  // so the window being gone means the hive is on disk).
  'wmctl click Exit',
  'wmctl wait nowin WineMine 6000',
  'echo ==list5',
  'wmctl list',
  'echo ==cut',
  'echo ==reg',
  'cat /root/.win32reg',
  'echo ==cut',
  '',
].join('\n'));
const mainErr = bootErr;                         // before out2 overwrites it

/* window + tree */
const list1 = section(out, 'list1');
const row1 = list1.split('\n').find(l => l.endsWith('\tWineMine')) || '';
check('window titled "WineMine" (LoadStringW)', row1 !== '', JSON.stringify(list1.slice(0, 300)));
check(`beginner surface is ${BEG_W}x${BEG_H + BAR} (board + menu bar)`,
  row1.includes(`${BEG_W}x${BEG_H + BAR}`), row1);
check('window is fixed-size (no R flag)', !(row1.split('\t')[5] || '').includes('R'), row1);

const tree1 = section(out, 'tree1');
check('tree dumps the WineMine class window', /class=WineMine .*text='WineMine'/.test(tree1), tree1.slice(0, 300));
check('tree lists the Options popup', /menu popup text='Options'/.test(tree1), tree1);
check('tree lists the Info popup', /menu popup text='Info'/.test(tree1), tree1);
check('menu item New (accel tab cut)', /menuitem id=1001 text='New'/.test(tree1), tree1);
check('Beginner starts checked (CheckMenuItem)', /menuitem id=1005 text='Beginner' checked/.test(tree1), tree1);
check('Mark Question starts checked', /menuitem id=1009 text='Mark Question' checked/.test(tree1), tree1);
check('Exit item present (label cut at tab)', /menuitem id=1002 text='Exit'/.test(tree1), tree1);

/* popup isolation (0257): the popup lives on its own anchored child window
 * (the `wait win "#32768"` markers in the script are the open/close proof);
 * the parent's client pixels must be BYTE-IDENTICAL across open and close —
 * menu pixels never touch the app's surface anymore. */
extractShots();

/* 0280: the last bar title ("Info") must render COMPLETE inside the window.
 * At the 20px font the classic 16px/item bar padding needed ~164px — wider
 * than beginner's 154 — and "Info" clipped mid-glyph at the right edge (the
 * label-click path can't see that). The bar now tightens its padding when
 * the titles wouldn't fit. Probe the strip surface: text ink (near-black,
 * AA-safe threshold) must reach past mid-bar (so the probe can't pass on an
 * empty bar) yet leave the rightmost columns clean; the bottom BTNSHADOW
 * edge row is excluded. */
{
  const bar = readShot('bar.png');
  check(`menubar strip spans the beginner window (${BEG_W}px)`, bar.w === BEG_W, bar.w);
  let rightmost = -1;
  for (let y = 0; y < bar.h - 1; y++)
    for (let x = rightmost + 1; x < bar.w; x++) {
      const o = (y * bar.w + x) * 4;
      if (bar.data[o] < 0x60 && bar.data[o + 1] < 0x60 && bar.data[o + 2] < 0x60)
        if (x > rightmost) rightmost = x;
    }
  check('bar titles render (text ink past mid-bar)', rightmost > bar.w / 2, rightmost);
  check(`"Info" not clipped (rightmost ink column ${rightmost} clears the edge)`,
    rightmost >= 0 && rightmost < bar.w - 2, `rightmost=${rightmost} w=${bar.w}`);
}

{
  const base = readShot('base.png'), popup = readShot('popup.png'), closed = readShot('closed.png');
  // popup area: below the bar at the Options title; 60x60 probe
  const a = crop(base, 4, BAR + 2, 60, 60), b = crop(popup, 4, BAR + 2, 60, 60), c = crop(closed, 4, BAR + 2, 60, 60);
  check('open popup never touches the parent buffer (pixels identical)', a.equals(b));
  check('ESC: parent buffer still identical', a.equals(c));
}

/* difficulty switching = owner-initiated resize end to end */
const list2 = section(out, 'list2');
check(`Advanced resizes the surface to ${ADV_W}x${ADV_H + BAR} (SURFACE_RESIZE)`,
  list2.split('\n').some(l => l.endsWith('\tWineMine') && l.includes(`${ADV_W}x${ADV_H + BAR}`)), list2);
const list3 = section(out, 'list3');
check('Beginner resizes back',
  list3.split('\n').some(l => l.endsWith('\tWineMine') && l.includes(`${BEG_W}x${BEG_H + BAR}`)), list3);

/* gameplay pixels */
{
  const fresh = readShot('fresh.png'), revealed = readShot('revealed.png');
  const ticking = readShot('ticking.png'), reset = readShot('reset.png');
  const cellRect = [CELL_X - 8, CELL_Y - 8, 16, 16];
  const f = crop(fresh, ...cellRect), r = crop(revealed, ...cellRect), z = crop(reset, ...cellRect);
  check('cell click reveals (mines-rect pixels change)', !f.equals(r));
  check('F2 accelerator resets the board (cell pixels restore)', f.equals(z));
  const t1 = crop(revealed, TIMER.x, TIMER.y, TIMER.w, TIMER.h);
  const t2 = crop(ticking, TIMER.x, TIMER.y, TIMER.w, TIMER.h);
  check('WM_TIMER runs the second counter (timer LEDs change)', !t1.equals(t2));
}

/* 0145 gap #13: the sound-on reveal above hit the SND_RESOURCE path —
 * silent success stands (0068 decision), but it must report ONCE */
check('SND_RESOURCE silent success reports once (gap #13 honesty)',
  /win32: unsupported PlaySound SND_RESOURCE/.test(mainErr),
  mainErr.slice(-300));

/* Fastest Times dialog */
const timestree = section(out, 'timestree');
check('Times dialog is a #32770 window titled "Fastest Times"',
  /class=#32770 .*text='Fastest Times'/.test(timestree), timestree.slice(0, 400));
check('LoadStringW default name "Nobody" shows',
  (timestree.match(/text='Nobody'/g) || []).length === 3, timestree);
check('times default 999 (SetDlgItemInt)', /text='999'/.test(timestree), timestree);

/* Custom Game dialog */
const customtree = section(out, 'customtree');
check('Custom dialog with three EDITs', /class=#32770 .*text='Custom Game'/.test(customtree) &&
  (customtree.match(/class=EDIT/g) || []).length === 3, customtree.slice(0, 500));
check('EDITs preloaded from the board (9 rows)', /class=EDIT [^\n]*text='9'/.test(customtree), customtree);
const customlist = section(out, 'customlist');
check('dialog is a second kernel surface',
  customlist.split('\n').filter(l => /\t(WineMine|Custom Game)$/.test(l)).length === 2, customlist);
check('modal disables the owner', /class=WineMine [^\n]*en=0/.test(customtree), customtree.slice(0, 300));

const list4 = section(out, 'list4');
check(`Custom 11x12 applies (GetDlgItemInt) — surface ${CUS_W}x${CUS_H + BAR}`,
  list4.split('\n').some(l => l.endsWith('\tWineMine') && l.includes(`${CUS_W}x${CUS_H + BAR}`)), list4);

/* exit + registry */
const list5 = section(out, 'list5');
check('Exit closes the app (window gone)', !list5.includes('WineMine'), list5);
const reg = section(out, 'reg');
check('SaveBoard wrote the registry hive', /WinMine/.test(reg) && /Height/.test(reg), reg.slice(0, 300));
check('custom geometry persisted (Height=12, Width=11, Mines=20)',
  /Height\|4\|0c000000/.test(reg) && /Width\|4\|0b000000/.test(reg) &&
  /Mines\|4\|14000000/.test(reg), reg);   /* hive: REG_DWORD as LE hex */

/* ---- session B: LoadBoard restores the custom board across boots ---- */
const out2 = boot([
  'winmine &',
  'wmctl wait label WineMine 10000',              // serving (title text resolves; closed-menu "Exit" wouldn't — 0171)
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Exit',
  'wmctl wait nowin WineMine 6000',
  '',
].join('\n'));

const blist = section(out2, 'list1');
check('second boot restores the custom geometry (registry LoadBoard)',
  blist.split('\n').some(l => l.endsWith('\tWineMine') && l.includes(`${CUS_W}x${CUS_H + BAR}`)), blist);
const btree = section(out2, 'tree1');
check('Custom is now the checked difficulty', /menuitem id=1008 text='Custom...' checked/.test(btree), btree);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nwinmine e2e: ${failures} FAILED` : '\nwinmine e2e: PASS');
process.exit(failures ? 1 : 0);
