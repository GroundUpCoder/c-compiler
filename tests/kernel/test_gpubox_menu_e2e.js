#!/usr/bin/env node
// M2 acceptance (todos/0258, menu arch §4.a.5): a GPU app's menu is
// first-class on the SAME engine as notepad's — WITHOUT the optional Dawn
// tier. gpubox is a minimal win32 app now (RegisterClass CS_OWNCLIENT +
// CreateWindowEx + PeekMessage pump around its webgpu.h render loop), and
// this file drives its File/Options menu headless with the `webgpu`
// package force-hidden (lib/nodawn-require.js), so the whole story runs on
// stock-Node tier 0:
//   - A14 no-GPU survival: adapter acquisition fails, gpubox does NOT exit
//     — the window, menu bar, and message pump stay alive over a dead
//     (black) client. The old gpubox exit(2)'d here; `wmctl wait win`
//     timing out is exactly this test's red state.
//   - the menu bar is a real anchored "menubar" child strip (waitable),
//     width-matched to the window, composited ABOVE the black GPU client
//     in the deterministic headless shot (COLOR_MENU pixels where the
//     parent surface is zero — menu arch §3.4, readable menus over any
//     transport).
//   - a bar click opens a real "#32768" popup child; ESC closes it.
//   - `wmctl click Spin` fires WM_COMMAND(ID_SPIN) by label with the menu
//     CLOSED (A12 menu_locate) — the CheckMenuItem state flips in the
//     agent tree and gpubox prints its spin marker. Wireframe toggles the
//     same way. Quit exits through WM_CLOSE -> WM_DESTROY -> WM_QUIT.
//
// The render side of the same menu (bar over a LIVE cube, Spin actually
// freezing the rotation) is the browser leg in tests/browser/os-gpubox.mjs
// — the M2 gate is BOTH legs, this one proves the machinery without a GPU.
//
// Run: node tests/kernel/test_gpubox_menu_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const NODAWN = path.join(__dirname, 'lib/nodawn-require.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-gpubox-menu-');

function section(out, name) {
  return (String(out).split('==' + name + '\n')[1] || '').split('==cut')[0];
}

/* `wmctl list` rows: sid \t pid \t WxH+X+Y \t ... \t title */
function rowsOf(listOut, title) {
  const out = [];
  for (const line of String(listOut).split('\n')) {
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[6] === title) {
      const m = cols[2].match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
      if (m) out.push({ sid: +cols[0], w: +m[1], h: +m[2], x: +m[3], y: +m[4],
                        flags: cols[5] });
    }
  }
  return out;
}

/* Bounded condition poll on the agent tree (the winmine waitGeom pattern —
 * `wmctl click Spin` posts WM_COMMAND; the toggle lands on gpubox's next
 * pump tick, so the re-dump must wait for the state, not race it). */
const waitTree = (pattern) =>
  `for i in $(seq 1 120); do wmctl tree | grep -q "${pattern}" && break; sleep 0.05; done`;

const r = driveBoot([
  'gpubox &',
  // A14 boot barrier: the window existing at all means gpubox SURVIVED the
  // failed adapter acquisition (the pre-M2 gpubox exit(2)s and this wait
  // times out — the red state).
  'wmctl wait win gpubox 15000',
  'SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//")',
  'wmctl move $SID 100 100',                     // deterministic geometry base
  'wmctl wait win menubar 8000',                 // the anchored bar strip child
  'echo ==tree1',
  'wmctl tree',
  'echo ==cut',
  'echo ==list1',
  'wmctl list',
  'echo ==cut',
  // bar click opens File as a REAL "#32768" popup child window
  'wmctl click $SID 12 10',
  'wmctl wait win "#32768" 8000',
  'echo ==plist',
  'wmctl list',
  'echo ==cut',
  'wmctl shot screen /root/menu.ppm && echo SHOT-OK',
  'wmctl key $SID 41 27',                        // ESC closes the popup
  'wmctl wait nowin "#32768" 8000',
  // fire Spin by label with the menu CLOSED (A12); wait for the toggle to
  // land (posted WM_COMMAND -> next pump tick), then dump the state
  'wmctl click Spin',
  waitTree("text='Spin'$"),                      // line without ' checked'
  'echo ==tree2',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Wireframe',
  waitTree("text='Wireframe' checked"),
  'echo ==tree3',
  'wmctl tree',
  'echo ==cut',
  // quit through the menu: WM_COMMAND -> WM_CLOSE -> DestroyWindow ->
  // PostQuitMessage -> the pump SDL_Quit()s
  'wmctl click Quit',
  'wmctl wait nowin gpubox 8000',
  'echo QUIT-OK',
], { image, nodeArgs: ['--require', NODAWN], maxBuffer: 32 * 1024 * 1024 });
const out = String(r.stdout) + String(r.stderr);

/* ---- A14 survival ---- */
check('no-GPU path really ran (adapter unavailable on stderr)',
  out.includes('gpubox: WebGPU unavailable (no adapter)'), out.slice(0, 400));
check('gpubox survived it: window + menu + pump lived to quit (QUIT-OK)',
  out.includes('QUIT-OK'));

/* ---- the menu model in the agent tree ---- */
const tree1 = section(out, 'tree1');
check('top-level is the gpubox class window',
  /win \d+ class=gpubox .*text='gpubox'/.test(tree1), tree1.slice(0, 300));
check('File popup in the tree', /menu popup text='File'/.test(tree1), tree1);
check('Options popup in the tree', /menu popup text='Options'/.test(tree1), tree1);
check("Open Scene... present and grayed (no scene format — honest disable)",
  /menuitem id=\d+ text='Open Scene\.\.\.' grayed/.test(tree1), tree1);
check('Quit item present', /menuitem id=\d+ text='Quit'/.test(tree1), tree1);
check('Spin starts CHECKED (spinning by default)',
  /menuitem id=\d+ text='Spin' checked/.test(tree1), tree1);
check('Wireframe starts unchecked',
  /menuitem id=\d+ text='Wireframe'\n/.test(tree1 + '\n'), tree1);

/* ---- bar strip geometry: anchored at the window origin, full width ---- */
const list1 = section(out, 'list1');
const win1 = rowsOf(list1, 'gpubox')[0];
const bar1 = rowsOf(list1, 'menubar')[0];
check('gpubox window listed at 100,100', win1 && win1.x === 100 && win1.y === 100,
  JSON.stringify(win1));
check('menubar strip is an anchored child at the window origin',
  win1 && bar1 && bar1.x === win1.x && bar1.y === win1.y,
  JSON.stringify({ win1, bar1 }));
check('strip spans the window width at MENU_BAR_H',
  win1 && bar1 && bar1.w === win1.w && bar1.h === 30,
  JSON.stringify({ win1, bar1 }));

/* ---- popup child over the dead client ---- */
const plist = section(out, 'plist');
const pop = rowsOf(plist, '#32768')[0];
check('bar click opened a real "#32768" popup child', !!pop, plist);
check('popup hangs off the bar (anchored below MENU_BAR_H)',
  pop && win1 && pop.y === win1.y + 30 && pop.x >= win1.x,
  JSON.stringify({ pop, win1 }));

/* ---- deterministic headless composite: menu pixels over a black client
 * (menu arch §3.4 — the whole point of app-rendered shm menu layers) ---- */
check('screen shot written', out.includes('SHOT-OK'));
{
  const bytes = fs.readFileSync(path.join(tmp, 'os-root.img'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const store = new BLOCK_FS.MemoryByteStore(bytes.length);
  store.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store);
  const ppm = COMMON.readFileBytes(ufs, '/root/menu.ppm');
  const head = Buffer.from(ppm.subarray(0, 32)).toString('latin1');
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!m) throw new Error('bad screen ppm: ' + JSON.stringify(head));
  const W = +m[1];
  const off = m[0].length;
  const px = (x, y) => String(Array.from(
    ppm.subarray(off + (y * W + x) * 3, off + (y * W + x) * 3 + 3)));
  // bar strip: COLOR_MENU face at the right end of the strip (past titles)
  const barP = win1 && bar1 ? px(bar1.x + bar1.w - 4, bar1.y + 10) : 'no-row';
  check('bar strip composites COLOR_MENU over the GPU window', barP === '192,192,192', barP);
  // popup interior: gutter of the (non-hot) first row, COLOR_MENU too
  const popP = pop ? px(pop.x + 8, pop.y + 9) : 'no-row';
  check('popup child composites COLOR_MENU', popP === '192,192,192', popP);
  // the client plane under it all is DEAD BLACK (no GPU ever presented):
  // the readable menu above it is exactly the §3.4 claim
  const cliP = win1 ? px(win1.x + win1.w - 6, win1.y + win1.h - 6) : 'no-row';
  check('client plane is black (no-Dawn dead client)', cliP === '0,0,0', cliP);
}

/* ---- Spin / Wireframe toggles through the agent path ---- */
const tree2 = section(out, 'tree2');
check('Spin unchecked after wmctl click Spin (WM_COMMAND -> CheckMenuItem)',
  /menuitem id=\d+ text='Spin'\n/.test(tree2 + '\n') && !/text='Spin' checked/.test(tree2),
  tree2);
check('gpubox printed its spin-off marker', out.includes('gpubox: spin off'));
const tree3 = section(out, 'tree3');
check('Wireframe checked after wmctl click Wireframe',
  /menuitem id=\d+ text='Wireframe' checked/.test(tree3), tree3);
check('gpubox printed its wireframe-on marker', out.includes('gpubox: wireframe on'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\ngpubox menu e2e (no Dawn): PASS'
                           : `\ngpubox menu e2e (no Dawn): ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
