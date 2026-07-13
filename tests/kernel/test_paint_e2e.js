#!/usr/bin/env node
// 0107 acceptance, headless: the Paint accessory (os/win32/paint.c, design
// todos/WIN32.md) through os/boot.js. Covers:
//   - lifecycle: WM_CREATE < WM_PAINT/ready; window titled "untitled - Paint",
//     fixed surface = client_w x (client_h + MENU_BAR_H)
//   - the menu (agent tree): File/Edit/Image/Tools/Help with tool + width
//     items; Cut/Copy/Paste start GRAYED (0107 non-goal), Undo starts grayed
//   - drawing: select Filled Rectangle + a red swatch (palette pixel click),
//     `wmctl drag` a rect into the memory-DC canvas -> red pixels via a SHOT
//   - flood fill: select Fill + a green swatch, click the white background ->
//     the connected region floods green, the red rect stays
//   - single-level Undo: Edit->Undo reverts the fill (bg back to white)
//   - BMP round-trip via comdlg32: Save As pic.bmp, New (clear), Open pic.bmp
//     restores the art; a second Save As pic2.bmp is BYTE-IDENTICAL to pic.bmp
//
// Colors are compared swatch-to-canvas (sampling the palette swatch pixel in
// the same shot), so the assertions never assume a surface byte order.
// Layout coordinates mirror os/win32/paint.c — change together.
//
// Run: node tests/kernel/test_paint_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-paint-');

function boot(script) {          // text stdout
  const r = driveBoot(script, { image, timeout: 400000, maxBuffer: 96 * 1024 * 1024 });
  return r.stdout;
}
function bootBin(script) {       // binary stdout (Buffer)
  const r = driveBoot(script, { image, timeout: 400000, maxBuffer: 96 * 1024 * 1024, encoding: null });
  return r.stdout;
}
function section(out, name) { return (out.split('==' + name + '\n')[1] || '').split('==cut')[0]; }

/* ---- geometry (paint.c mirror) ---- */
const BAR = 20, CANVAS_X = 56, CANVAS_Y = 6, CW = 400, CH = 300;
const PAL_Y = CANVAS_Y + CH + 12;                 // 318
const CLIENT_W = Math.max(CANVAS_X + CW + 8, CANVAS_X + 8 * 16 + 8);   // 464
const CLIENT_H = Math.max(PAL_Y + 2 * 16 + 8, 4 + 4 * 22 + 8);        // 358
const SURF_W = CLIENT_W, SURF_H = CLIENT_H + BAR;                     // 464 x 378

// canvas bitmap (bx,by) -> surface pixel
const sx = (bx) => CANVAS_X + bx;
const sy = (by) => CANVAS_Y + by + BAR;
// palette swatch k=row*8+col center -> surface pixel (== the click point)
const swx = (k) => CANVAS_X + (k % 8) * 16 + 8;
const swy = (k) => PAL_Y + Math.floor(k / 8) * 16 + 8 + BAR;
const RED = 10, GREEN = 12;                        // palette indices

/* Drawing ops (tool select, palette pick, drag, fill) are FIFO in the one input
 * path + message loop, so they apply in order without pacing sleeps — the only
 * genuine sync need is letting the resulting paint PRESENT to the surface before
 * a `wmctl shot` (pixel-only, no agent/label/text signal), which stays an
 * annotated render-settle (0083 rule). comdlg32 dialogs are real modal WM
 * windows (open via `wait label`, close via `wait nowin`); saved files land
 * after the handler, so poll for them (todos/0154). */
const waitFile = (p) =>
  `for i in $(seq 1 120); do [ -s ${p} ] && break; sleep 0.05; done`;

const out = boot([
  'paint &',
  // Boot barrier: the top-level window TEXT resolving through the agent socket
  // means paint is pumping/serving (menus built before the loop). NB items of a
  // CLOSED menu ("Filled Rectangle") are deliberately not GETTEXT-resolvable
  // (0171) — AQ_CLICK still fires them, but waiting on one is a dead wait.
  'wmctl wait label "untitled - Paint" 12000',
  'SID=$(wmctl list | grep -- "- Paint$" | sed "s/[^0-9].*//")',
  'echo ==list', 'wmctl list', 'echo ==cut',
  'echo ==tree', 'wmctl tree', 'echo ==cut',
  'wmctl shot $SID /root/base.ppm',
  // filled red rectangle (FIFO-ordered, no inter-op sleeps)
  'wmctl click "Filled Rectangle"',
  `wmctl click $SID ${swx(RED)} ${swy(RED)}`,
  `wmctl drag $SID ${sx(40)} ${sy(40)} ${sx(200)} ${sy(160)}`,
  // flood fill the white background green
  'wmctl click Fill',
  `wmctl click $SID ${swx(GREEN)} ${swy(GREEN)}`,
  `wmctl click $SID ${sx(350)} ${sy(270)}`,
  'sleep 1',                                       // render-settle: fill paint presents before the SHOT (pixel-only)
  'wmctl shot $SID /root/art.ppm',
  // Save As pic.bmp (comdlg32 modal: settext the name EDIT, click Save)
  'wmctl click "Save As..."',
  'wmctl wait label Save 6000',
  'echo ==dlg', 'wmctl tree', 'echo ==cut',
  'wmctl settext EDIT:1 /root/pic.bmp',
  'wmctl click Save',
  'wmctl wait nowin "Save As" 6000',
  waitFile('/root/pic.bmp'),
  'echo ==saved', 'ls -la /root/pic.bmp', 'echo ==cut',
  // single-level Undo reverts the fill
  'wmctl click Undo',
  'sleep 1',                                       // render-settle: undo repaint presents before the SHOT (pixel-only)
  'wmctl shot $SID /root/undone.ppm',
  // New clears
  'wmctl click New',
  'sleep 1',                                       // render-settle: cleared canvas presents before the SHOT (pixel-only)
  'wmctl shot $SID /root/cleared.ppm',
  // Open pic.bmp restores the art
  'wmctl click "Open..."',
  'wmctl wait label Open 6000',
  'wmctl settext EDIT:1 /root/pic.bmp',
  'wmctl click Open',
  'wmctl wait nowin Open 6000',
  'sleep 1',                                       // render-settle: loaded art presents before the SHOT (pixel-only)
  'wmctl shot $SID /root/reopened.ppm',
  // Save As pic2.bmp for the byte-identical check
  'wmctl click "Save As..."',
  'wmctl wait label Save 6000',
  'wmctl settext EDIT:1 /root/pic2.bmp',
  'wmctl click Save',
  'wmctl wait nowin "Save As" 6000',
  waitFile('/root/pic2.bmp'),
  'echo ==both', 'ls -la /root/pic.bmp /root/pic2.bmp', 'echo ==cut',
  '',
].join('\n'));

/* ---- lifecycle + tree ---- */
check('WM_CREATE arrives', out.includes('paint: WM_CREATE'));
check('app reaches ready', out.includes('paint: ready'));
const iCreate = out.indexOf('paint: WM_CREATE'), iPaint = out.indexOf('paint: WM_PAINT');
check('lifecycle order CREATE < PAINT', iCreate >= 0 && iPaint > iCreate, `${iCreate},${iPaint}`);

const list = section(out, 'list');
const row = list.split('\n').find(l => l.endsWith('- Paint')) || '';
check('window titled "untitled - Paint"', row !== '', JSON.stringify(list.slice(0, 200)));
check(`fixed surface is ${SURF_W}x${SURF_H}`,
  row.includes(`${SURF_W}x${SURF_H}`) && !(row.split('\t')[5] || '').includes('R'), row);

const tree = section(out, 'tree');
check('tree dumps the Paint window', /class=Paint .*text='untitled - Paint'/.test(tree), tree.slice(0, 200));
for (const [label, id] of [
  ['File menu', /menu popup text='File'/], ['Tools menu', /menu popup text='Tools'/],
  ['Filled Rectangle item', /menuitem id=125 text='Filled Rectangle'/],
  ['Fill item', /menuitem id=122 text='Fill'/],
  ['Line item', /menuitem id=123 text='Line'/],
  ['Width submenu', /menu popup text='Width'/],
]) check('tree shows ' + label, id.test(tree), tree.slice(0, 900));
check('Pencil starts checked (default tool)', /menuitem id=120 text='Pencil' checked/.test(tree), tree);
check('Undo starts grayed', /menuitem id=110 text='Undo' [^\n]*gray/.test(tree), tree);
check('Cut/Copy/Paste start grayed (0107 non-goal)',
  /id=111 text='Cut' [^\n]*gray/.test(tree) && /id=112 text='Copy' [^\n]*gray/.test(tree) &&
  /id=113 text='Paste' [^\n]*gray/.test(tree), tree);

/* markers */
check('Filled Rectangle selected (tool=5)', out.includes('paint: tool=5'));
check('Fill selected (tool=2)', out.includes('paint: tool=2'));
check('red FG set from the palette', /paint: fg=[0-9A-F]{6}/.test(out));
check('stroke committed', out.includes('paint: stroke'));
check('undo fired', out.includes('paint: undo'));
check('Save As wrote pic.bmp', /pic\.bmp/.test(section(out, 'saved')) &&
  !/No such/.test(section(out, 'saved')), section(out, 'saved'));

/* dialog addressing */
const dlg = section(out, 'dlg');
check('Save As opens the comdlg32 file dialog', /class=WCFileDlg[^\n]*text='Save As'/.test(dlg), dlg.slice(0, 300));

/* ---- shots ---- */
const SHOTS = ['base', 'art', 'undone', 'cleared', 'reopened'];
const shots = {};
{
  const buf = bootBin('cat ' + SHOTS.map(n => '/root/' + n + '.ppm').join(' ') + '\n');
  let off = 0;
  for (const name of SHOTS) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) { check('shot stream parses (' + name + ')', false, JSON.stringify(head)); break; }
    const w = +m[1], h = +m[2], data = off + m[0].length;
    shots[name] = { w, h, data: buf.slice(data, data + w * h * 3) };
    off = data + w * h * 3;
  }
}
function px(img, x, y) {
  if (!img || x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
  const o = (y * img.w + x) * 3;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}
const eq = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const isWhite = (p) => eq(p, [255, 255, 255]);

check('shots decoded', SHOTS.every(n => shots[n] && shots[n].w === SURF_W), Object.keys(shots).join(','));

/* the swatch pixels sampled from the base shot are the ground-truth colors */
const red = px(shots.base, swx(RED), swy(RED));
const green = px(shots.base, swx(GREEN), swy(GREEN));
check('base canvas is white', isWhite(px(shots.base, sx(120), sy(100))) &&
  isWhite(px(shots.base, sx(10), sy(10))), JSON.stringify(px(shots.base, sx(120), sy(100))));
check('red/green swatches distinct and non-white', red && green && !isWhite(red) && !isWhite(green) && !eq(red, green),
  JSON.stringify([red, green]));

/* art: rect center == red swatch; background flooded == green swatch */
check('filled rectangle drew the FG (red) into the canvas',
  eq(px(shots.art, sx(120), sy(100)), red), JSON.stringify([px(shots.art, sx(120), sy(100)), red]));
check('flood fill turned the background green',
  eq(px(shots.art, sx(10), sy(10)), green), JSON.stringify([px(shots.art, sx(10), sy(10)), green]));
check('the rectangle survived the flood fill',
  eq(px(shots.art, sx(120), sy(100)), red));

/* undo: fill reverted (bg white again), rect kept */
check('Undo reverted the flood fill (background white again)',
  isWhite(px(shots.undone, sx(10), sy(10))), JSON.stringify(px(shots.undone, sx(10), sy(10))));
check('Undo kept the rectangle', eq(px(shots.undone, sx(120), sy(100)), red));

/* New cleared the canvas */
check('New cleared the canvas to white', isWhite(px(shots.cleared, sx(120), sy(100))),
  JSON.stringify(px(shots.cleared, sx(120), sy(100))));

/* reopened == the saved art (visual round-trip) */
check('Open restored the rectangle (red)', eq(px(shots.reopened, sx(120), sy(100)), red),
  JSON.stringify([px(shots.reopened, sx(120), sy(100)), red]));
check('Open restored the flooded background (green)', eq(px(shots.reopened, sx(10), sy(10)), green),
  JSON.stringify([px(shots.reopened, sx(10), sy(10)), green]));

/* ---- BMP round-trip is byte-identical + a valid 24-bit BMP ---- */
{
  const a = bootBin('cat /root/pic.bmp\n');
  const b = bootBin('cat /root/pic2.bmp\n');
  check('pic.bmp is a 24-bit BMP header', a.length >= 54 && a[0] === 0x42 && a[1] === 0x4D &&
    a.readUInt16LE(28) === 24 && a.readInt32LE(18) === CW && a.readInt32LE(22) === CH,
    `len=${a.length} bpp=${a.length >= 54 ? a.readUInt16LE(28) : '?'}`);
  check('Save->Open->Save is byte-identical', a.length === b.length && a.equals(b),
    `${a.length} vs ${b.length}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\npaint e2e: ${failures} FAILED` : '\npaint e2e: PASS');
process.exit(failures ? 1 : 0);
