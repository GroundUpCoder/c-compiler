#!/usr/bin/env node
// 0075 acceptance + M3 of the uniform-menu architecture (menu arch §4.b):
// /bin/sameboy (SameBoy v1.0.3 core, the cycle-accurate GB/GBC sibling of
// /bin/gameboy) runs windowed in-OS — since the M3 conversion as a WIN32
// app whose menu is the SAME menucore path gpubox (M2, GPU transport) and
// notepad exercise. This file is the CPU half of the "one system, BOTH
// transports" proof:
//   - the emulator presents through GDI (SetDIBits/StretchBlt into the
//     client via GetDC/ReleaseDC), the normal win32 bitmap transport — NOT
//     CS_OWNCLIENT; the DMG path renders the exact GB_PALETTE_GREY shades
//     and animates between shots exactly as the pre-M3 SDL frontend did;
//   - the menu bar is the anchored "menubar" strip child (waitable), a bar
//     click opens a real "#32768" popup child, and the deterministic
//     headless screen composite shows COLOR_MENU pixels over the live shm
//     client (§3.4 — same probe as the gpubox test over a GPU client);
//   - menu actions really act on the emulator: Emulation>Pause freezes the
//     frame (time-separated client shots go byte-identical), a NESTED
//     submenu action (Options>Palette>DMG Green) swaps the next presented
//     frame to the exact DMG-green shades (A12 menu_locate fires items at
//     any depth with the menu closed);
//   - File>Open ROM... is the real comdlg32 GetOpenFileNameW modal driven
//     by agent (settext EDIT + click Open) into the live-reload path, and
//     File>Quit exits cleanly through WM_CLOSE -> WM_QUIT.
// The CGB leg (gitignored ROM, when present) still proves cgb_boot; the
// .gb/.gbc openwith default is asserted so it can't silently regress.
//
// Run: node tests/kernel/test_sameboy_e2e.js
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

const { dir: tmp, image } = freshImage('os-sameboy-');

// The ROMs are gitignored (optional image entries); without the GBC ROM the
// CGB leg skips and the DMG leg (built-in test ROM) still proves the core.
const HAVE_GBC = fs.existsSync(path.join(ROOT, 'vendor/gameboy/roms/SuperMarioDeluxe.gbc'));

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
 * a label click posts WM_COMMAND; the toggle lands on sameboy's next pump
 * tick, so the re-dump must wait for the state, not race it). */
const waitTree = (pattern) =>
  `for i in $(seq 1 120); do wmctl tree | grep -q "${pattern}" && break; sleep 0.05; done`;

/* ---- session A: launch, menu model, shots, menu actions, Open ROM ---- */
function sessionApps() {
  const script = [
    'sameboy &',
    'wmctl wait win SameBoy',                       // window spawn (0155)
    // M3 red state: the pre-conversion (plain-SDL) sameboy has no menu bar
    // child — this wait timing out IS the red run.
    'wmctl wait win menubar 8000',
    'SID=$(wmctl list | grep "SameBoy$" | sed "s/[^0-9].*//")',
    'wmctl move $SID 100 100',                      // deterministic geometry base
    'echo ==tree1',
    'wmctl tree',
    'echo ==cut',
    'echo ==list1',
    'wmctl list',
    'echo ==cut',
    // No in-OS marker exists for "dmg_boot handed off to the checkerboard"
    // (ROM-side progress is invisible to the frontend), so this is a genuine
    // no-marker settle spread as a SHOT SERIES: the checker scans for the
    // first checkerboard frame instead of betting one fixed sleep against
    // CPU contention (the flake-gate lesson — a lone sleep-3 shot caught
    // dmg_boot's 2-shade logo under load ×10).
    'for i in 1 2 3 4 5 6 7 8; do wmctl shot $SID /root/sb$i.png; sleep 1.5; done',
    'echo shots-ok',
    // bar click opens File as a REAL "#32768" popup child over the LIVE client
    'wmctl click $SID 12 10',
    'wmctl wait win "#32768" 8000',
    'echo ==plist',
    'wmctl list',
    'echo ==cut',
    'wmctl shot screen /root/menu.png && echo shot-menu-ok',
    'wmctl key $SID 41 27',                        // ESC closes the popup
    'wmctl wait nowin "#32768" 8000',
    // Emulation>Pause via the agent path (label click, menu closed — A12):
    // the frame loop freezes, so time-separated client shots go identical.
    'wmctl click Pause',
    waitTree("text='Pause' checked"),
    'wmctl shot $SID /root/p1.png && echo shot-p1-ok',
    'sleep 2',                                     // timing subject: WOULD animate here if Pause did not really freeze the loop
    'wmctl shot $SID /root/p2.png && echo shot-p2-ok',
    'wmctl click Pause',
    waitTree("text='Pause'$"),
    // nested submenu action (Options>Palette>DMG Green) over the live emulator
    'wmctl click "DMG Green"',
    waitTree("text='DMG Green' checked"),
    // Same series shape: presents are per-GB-frame, so under load the first
    // shot could still be a pre-swap grey frame — the checker accepts the
    // first fully-DMG-green one (render-settle, pixel-only).
    'for i in 1 2 3; do wmctl shot $SID /root/pal$i.png; sleep 1; done',
    'echo shot-pal-ok',
    // File>Open ROM... -> the real comdlg32 modal -> the live-reload path.
    // Any >=0x150-byte file is a loadable (if nonsensical) cart image.
    'head -c 65536 /bin/sameboy > /root/junk.gb',
    'echo ==openrom',
    'wmctl click "Open ROM..."',
    'wmctl wait label "Open ROM" 8000',
    'wmctl settext EDIT:1 /root/junk.gb',
    'wmctl click Open',
    'wmctl wait nowin "Open ROM" 8000',
    // quit through the menu: WM_COMMAND -> WM_CLOSE -> WM_QUIT -> exit; a
    // clean disappearance proves the reloaded core is still pumping.
    'wmctl click Quit',
    'wmctl wait nowin SameBoy 8000',
    'echo QUIT-OK',
  ].concat(HAVE_GBC ? [
    'sameboy /root/roms/SuperMarioDeluxe.gbc &',
    'wmctl wait win SameBoy',                       // window spawn (0155)
    'sleep 20',                                    // timing subject: cgb_boot animation + game intro frames render
    'CSID=$(wmctl list | grep "SameBoy$" | sed "s/[^0-9].*//")',
    'wmctl shot $CSID /root/sbc.png && echo shot-cgb-ok',
  ] : []).concat([
    'grep "^gb" /etc/openwith /usr/share/openwith 2>/dev/null || echo ==assoc',
    'cat /usr/share/openwith',
    '',
  ]).join('\n');

  const a = driveBoot(script, { image, maxBuffer: 32 * 1024 * 1024 });
  const out = a.stdout;
  const list1 = section(out, 'list1');
  const row = list1.split('\n').find(l => l.endsWith('\tSameBoy')) || '';

  check('sameboy boots the built-in test ROM on DMG-B',
    out.includes('Using built-in test ROM') && out.includes('SameBoy core, model DMG-B'),
    JSON.stringify(out.slice(0, 120)));
  check('sameboy opens a window titled "SameBoy"', row !== '', JSON.stringify(list1));
  check('sameboy window is 480x462 (160x144 tripled + the menu bar strip)',
    row.includes('480x462'), row);
  check('DMG shot series written', out.includes('shots-ok'));

  /* ---- the menu model in the agent tree (same engine as gpubox/notepad) ---- */
  const tree1 = section(out, 'tree1');
  check('File popup in the tree', /menu popup text='File'/.test(tree1), tree1.slice(0, 400));
  check('Open ROM... present and ENABLED (real comdlg32 behind it)',
    /menuitem id=\d+ text='Open ROM\.\.\.'\n/.test(tree1 + '\n'), tree1);
  check('Quit item present', /menuitem id=\d+ text='Quit'/.test(tree1), tree1);
  check('Emulation popup in the tree', /menu popup text='Emulation'/.test(tree1), tree1);
  check('Pause starts unchecked', /menuitem id=\d+ text='Pause'\n/.test(tree1 + '\n'), tree1);
  check('Auto Model starts CHECKED (header-derived model)',
    /menuitem id=\d+ text='Auto Model' checked/.test(tree1), tree1);
  check('Palette is a NESTED submenu popup under Options',
    /menu popup text='Options'[\s\S]*menu popup text='Palette'/.test(tree1), tree1);
  check('Greyscale starts CHECKED (the SameBoy default palette)',
    /menuitem id=\d+ text='Greyscale' checked/.test(tree1), tree1);

  /* ---- bar strip geometry: anchored at the window origin, full width ---- */
  const win1 = rowsOf(list1, 'SameBoy')[0];
  const bar1 = rowsOf(list1, 'menubar')[0];
  check('SameBoy window listed at 100,100', win1 && win1.x === 100 && win1.y === 100,
    JSON.stringify(win1));
  check('menubar strip is an anchored child at the window origin',
    win1 && bar1 && bar1.x === win1.x && bar1.y === win1.y,
    JSON.stringify({ win1, bar1 }));
  check('strip spans the window width at MENU_BAR_H',
    win1 && bar1 && bar1.w === win1.w && bar1.h === 30,
    JSON.stringify({ win1, bar1 }));

  /* ---- popup child over the live client ---- */
  const plist = section(out, 'plist');
  const pop = rowsOf(plist, '#32768')[0];
  check('bar click opened a real "#32768" popup child', !!pop, plist);
  check('popup hangs off the bar (anchored below MENU_BAR_H)',
    pop && win1 && pop.y === win1.y + 30 && pop.x >= win1.x,
    JSON.stringify({ pop, win1 }));
  check('menu screen shot written', out.includes('shot-menu-ok'));

  /* ---- pause + palette shots landed ---- */
  check('both pause shots written', out.includes('shot-p1-ok') && out.includes('shot-p2-ok'));
  check('palette shot written', out.includes('shot-pal-ok'));

  /* ---- Open ROM through the real dialog, then a clean menu Quit ---- */
  const afterOpen = out.split('==openrom')[1] || '';
  check('Open ROM... loaded the picked file through the live-reload path',
    afterOpen.includes('Loaded ROM: 65536 bytes'), afterOpen.slice(0, 300));
  check('sameboy survived the reload and quit cleanly through the menu',
    out.includes('QUIT-OK'));

  if (HAVE_GBC) {
    check('GBC ROM run selects CGB-E from the header flag',
      out.includes('SameBoy core, model CGB-E'), JSON.stringify(out.slice(0, 300)));
    check('CGB shot written', out.includes('shot-cgb-ok'));
  } else {
    console.log('  skip CGB leg (vendor/gameboy/roms/SuperMarioDeluxe.gbc absent)');
  }
  check('the .gb/.gbc association points at /bin/sameboy (0072 default = SameBoy)',
    /gb\t\/bin\/sameboy/.test(out) && /gbc\t\/bin\/sameboy/.test(out) &&
    !/gbc?\t\/bin\/gameboy/.test(out), out.split('\n').slice(-8).join('|'));

  return { win1, pop };
}

/* ---- session B: pixel-level proof from the PNG shots ---- */
function sessionFrames(geom) {
  const files = ['/root/sb1.png', '/root/sb2.png', '/root/sb3.png', '/root/sb4.png',
                 '/root/sb5.png', '/root/sb6.png', '/root/sb7.png', '/root/sb8.png',
                 '/root/p1.png', '/root/p2.png',
                 '/root/pal1.png', '/root/pal2.png', '/root/pal3.png', '/root/menu.png']
    .concat(HAVE_GBC ? ['/root/sbc.png'] : []);
  const b = driveBoot('cat ' + files.join(' ') + '\n',
    { image, timeout: 120000, maxBuffer: 64 * 1024 * 1024, encoding: null });

  // One PNG shot out of the concatenated cat-back stream (#657);
  // null on a missing/short shot, so the callers' `if (!p)` guards hold.
  function parseShot(buf, off) {
    try { return parsePng(buf, off); } catch (e) { return null; }
  }
  /* Sample the CLIENT area only (y >= y0): the window shot is the parent
   * surface, whose top MENU_BAR_H rows are the never-painted strip under
   * the anchored bar child (zeros), not emulator pixels. */
  function colorSet(shot, y0) {
    const colors = new Set();
    for (let y = y0; y < shot.h; y += 3) {
      for (let x = 0; x < shot.w; x += 3) {
        const i = (y * shot.w + x) * 4;
        colors.add((shot.rgba[i] << 16) | (shot.rgba[i + 1] << 8) | shot.rgba[i + 2]);
      }
    }
    return colors;
  }

  // Parse the 8-shot series; the checker owns the settle (session A took
  // shots 1.5s apart with no content marker available).
  const series = [];
  let cursor = 0;
  for (let i = 0; i < 8; i++) {
    const p = parseShot(b.stdout, cursor);
    if (!p) break;
    series.push(p);
    cursor = p.next;
  }
  check('all 8 DMG series shots parse as PNG at full window size 480x462',
    series.length === 8 && series.every(p => p.w === 480 && p.h === 462),
    series.length + ' parsed');
  if (!series.length) return;

  // The frontend leaves SameBoy's default GB_PALETTE_GREY in place, so a
  // DMG client frame may contain ONLY the four grey shades — exact values,
  // not a histogram guess. The checkerboard uses at least 3 of them; scan
  // for the first frame past dmg_boot's logo.
  const GREYS = new Set([0x000000, 0x555555, 0xAAAAAA, 0xFFFFFF]);
  const sets = series.map(p => colorSet(p, 30));
  const k = sets.findIndex(s => s.size >= 3 && [...s].every(c => GREYS.has(c)));
  check('a series frame reaches the checkerboard (>=3 exact GB_PALETTE_GREY shades)',
    k >= 0, sets.map(s => s.size).join(','));
  if (k >= 0) {
    check('every frame from there on contains ONLY grey-palette shades (real LCD render)',
      sets.slice(k).every(s => [...s].every(c => GREYS.has(c))),
      sets.slice(k).map(s => [...s].map(c => c.toString(16)).join('/')).join(' | '));
    let animated = false;
    for (let j = k; j + 1 < series.length && !animated; j++) {
      let diff = 0;
      const a1 = series[j], a2 = series[j + 1];
      for (let i = 0; i < a1.rgba.length; i++) {
        if (a1.rgba[i] !== a2.rgba[i]) diff++;
      }
      if (diff > 1000) animated = true;
    }
    check('the test ROM animates (adjacent series shots differ — SCX scroll)',
      animated);
  }

  /* ---- Pause really froze the frame loop: byte-identical shots 2s apart ---- */
  const q1 = parseShot(b.stdout, cursor);
  const q2 = q1 ? parseShot(b.stdout, q1.next) : null;
  check('pause shots parse at 480x462',
    q1 && q2 && q1.w === 480 && q1.h === 462 && q2.w === 480 && q2.h === 462);
  if (q1 && q2) {
    let pdiff = 0;
    for (let i = 0; i < q1.rgba.length; i++) {
      if (q1.rgba[i] !== q2.rgba[i]) pdiff++;
    }
    check('Emulation>Pause froze the client (shots 2s apart byte-identical)',
      pdiff === 0, pdiff + ' bytes differ');
    cursor = q2.next;
  }

  /* ---- the nested-submenu palette action landed on the next frames ----
   * A shot is an atomic seq-gated present (whole frame, one palette), but
   * under load the first post-click shot can still be a pre-swap grey
   * frame — accept the first fully-DMG-green one in the 3-shot series. */
  const pals = [];
  for (let i = 0; i < 3; i++) {
    const p = parseShot(b.stdout, cursor);
    if (!p) break;
    pals.push(p);
    cursor = p.next;
  }
  check('all 3 palette shots parse at 480x462',
    pals.length === 3 && pals.every(p => p.w === 480 && p.h === 462),
    pals.length + ' parsed');
  {
    // GB_PALETTE_DMG, exactly as display.c defines it (5 entries incl. the
    // LCD-off shade) — the swizzle chain (rgb_encode -> DIB -> SetDIBits ->
    // StretchBlt -> shot) must round-trip these bytes exactly.
    const DMGPAL = new Set([0x081810, 0x396139, 0x84A563, 0xC6DE8C, 0xD2E6A6]);
    const psets = pals.map(p => colorSet(p, 30));
    check('a palette shot is fully DMG Green (>=3 exact GB_PALETTE_DMG shades, no others)',
      psets.some(s => s.size >= 3 && [...s].every(c => DMGPAL.has(c))),
      psets.map(s => [...s].map(c => c.toString(16)).join('/')).join(' | '));
  }

  /* ---- deterministic headless composite: COLOR_MENU over the live shm
   * client — the same §3.4 probe the gpubox test runs over a GPU client ---- */
  const ms = parseShot(b.stdout, cursor);
  check('menu screen shot parses', !!ms, ms && `${ms.w}x${ms.h}`);
  if (ms && geom && geom.win1) {
    const px = (x, y) => String(Array.from(
      ms.px(x, y).slice(0, 3)));
    // bar strip: COLOR_MENU face at the right end of the strip (past titles)
    const barP = px(geom.win1.x + geom.win1.w - 4, geom.win1.y + 10);
    check('bar strip composites COLOR_MENU over the emulator window',
      barP === '192,192,192', barP);
    // popup interior: gutter of the (non-hot) first row, COLOR_MENU too
    const popP = geom.pop ? px(geom.pop.x + 8, geom.pop.y + 9) : 'no-row';
    check('popup child composites COLOR_MENU over the live client',
      popP === '192,192,192', popP);
    cursor = ms.next;
  } else if (ms) {
    cursor = ms.next;
  }

  if (HAVE_GBC) {
    const p3 = parseShot(b.stdout, cursor);
    check('CGB shot parses at 480x462', p3 !== null && p3.w === 480 && p3.h === 462);
    if (p3) {
      const GREYS2 = new Set([0x000000, 0x555555, 0xAAAAAA, 0xFFFFFF]);
      const c3 = colorSet(p3, 30);
      const nonGrey = [...c3].filter(c => !GREYS2.has(c));
      check('CGB frame is colorful (>=6 distinct colors — real cgb_boot handoff)',
        c3.size >= 6, c3.size + ' colors');
      check('CGB frame has non-grey colors (CGB palettes live, not DMG compat greys)',
        nonGrey.length >= 3, nonGrey.slice(0, 5).map(c => c.toString(16)).join(','));
    }
  }
}

const geom = sessionApps();
sessionFrames(geom);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nsameboy e2e: ${failures} FAILED` : '\nsameboy e2e: PASS');
process.exit(failures ? 1 : 0);
