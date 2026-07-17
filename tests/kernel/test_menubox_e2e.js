#!/usr/bin/env node
// Spike 1 of the menu-uniform architecture (todos/0256): the kernel
// anchored-child primitive + the grab + the focus funnel, proven END TO END
// through the stock SDL3 veneer with NO user32 and NO menu code — a real
// compiled C app (tests/kernel/fixtures/menubox) driven via wmctl against a
// real booted OS. Legs (each red before the mechanism existed):
//   - SDL_CreatePopupWindow makes an anchored borderless child pinned at
//     the parent's client origin; wmctl move + a REAL title drag (sdrag)
//     carry the whole subtree, 2-level chain included (A1)
//   - minimize hides the subtree from the deterministic composite; restore
//     shows it again — child TEXT pixels (app-rendered 5x7 glyphs) are
//     readable in `wmctl shot screen` over the parent (§3.4)
//   - a popup can OVERFLOW its parent window (the fidelity upgrade)
//   - destroying a mid-tree child cascades its own subtree (the app never
//     destroys the grandchild — the kernel does)
//   - the owner focus pair (A9) at all three kernel transitions, observed
//     through SDL_EVENT_WINDOW_FOCUS_GAINED/LOST -> the bar's title
//     ("mb-bar-act"/"mb-bar-inact"): create-steal by another process
//     (winbox &), wmctl focus, and the minimize focus fall
//   - a click on a child focuses the PARENT (click-focuses-root)
//   - the grab (A2): SDL_WINDOW_POPUP_MENU holds it; an outside press on a
//     sibling window dismisses the popup chain (CLOSE_REQUESTED -> the app
//     closes it) AND is consumed whole — proven by a click counter in the
//     sibling's title that the NEXT allowed click advances to exactly 1
//   - A5: `wmctl resize` on the parent -> the app SDL_SetWindowSize()s the
//     bar to the new width -> the strip spans the resized parent
//   - closing the parent cascades bar + popups while the sibling top-level
//     survives; SDL_GetDisplayBounds reports the real screen
//
// Run: node tests/kernel/test_menubox_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function section(out, name) {
  return (String(out).split('==' + name + '\n')[1] || '').split('==cut')[0];
}
// `wmctl list` row for an exact title -> { sid, w, h, x, y, flags }
function row(listOut, title) {
  for (const line of String(listOut).split('\n')) {
    const cols = line.split('\t');
    if (cols.length >= 7 && cols[6] === title) {
      const m = cols[2].match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
      return { sid: +cols[0], w: +m[1], h: +m[2], x: +m[3], y: +m[4], flags: cols[5] };
    }
  }
  return null;
}

(async () => {
  const { dir, image } = freshImage('menubox-');

  // ---- build + inject the fixture (the oomdlg pattern: seed boot first,
  // then write the compiled wasm into the root volume) ----
  driveBoot('echo seeded', { image });
  const wasm = COMMON.buildProject(CompilerJS,
    'tests/kernel/fixtures/menubox/bin.json',
    (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'));
  {
    const rootImg = image.slice(0, -4) + '-root.img';   // boot.js pairing rule
    const store = new COMMON.NodeFileStore(fs, rootImg, false);
    const rfs = BLOCK_FS.createV4(store);
    const O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
    const fd = rfs.open('/root/menubox', O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    if (fd === null) throw new Error('inject open failed: ' + rfs._lastError);
    rfs.write(fd, wasm, wasm.length);
    rfs.close(fd);
    store.close();
  }

  const out = driveBoot([
    '/root/menubox &',
    'wmctl wait win menubox 15000',
    'wmctl wait win mb-bar-act 15000',      // initial FOCUS_GAINED delivered
    'PSID=$(wmctl list | grep "menubox$" | sed "s/[^0-9].*//")',
    'BSID=$(wmctl list | grep "mb-bar" | sed "s/[^0-9].*//")',
    'TSID=$(wmctl list | grep "mb-two" | sed "s/[^0-9].*//")',
    'wmctl move $PSID 300 250',
    'wmctl move $TSID 600 300',
    'echo ==l1',
    'wmctl list',
    'echo ==cut',
    'wmctl wait seq $BSID 1 8000',          // the bar has PRESENTED its glyphs
    'wmctl shot screen /root/s1.ppm && echo S1-OK',

    // tooltip chain (A1): key t opens mb-tpop + mb-tsub (no grab)
    'wmctl key $PSID 23',
    'wmctl wait win mb-tpop 8000',
    'wmctl wait win mb-tsub 8000',
    'TPSID=$(wmctl list | grep "mb-tpop$" | sed "s/[^0-9].*//")',
    'TSSID=$(wmctl list | grep "mb-tsub$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $TPSID 1 8000',
    'wmctl wait seq $TSSID 1 8000',
    'echo ==l2',
    'wmctl list',
    'echo ==cut',
    'wmctl shot screen /root/s2.ppm && echo S2-OK',

    // a REAL title drag carries the whole subtree
    'wmctl sdrag 450 240 550 340',
    'echo ==l3',
    'wmctl list',
    'echo ==cut',

    // minimize hides the subtree; restore shows it
    'wmctl min $PSID',
    'wmctl shot screen /root/s3.ppm && echo S3-OK',
    'wmctl restore $PSID',
    'wmctl shot screen /root/s4.ppm && echo S4-OK',

    // mid-tree cascade: the app destroys mb-tpop ONLY; the kernel takes tsub
    'wmctl key $PSID 6',
    'wmctl wait gone $TPSID 8000',
    'wmctl wait gone $TSSID 8000',
    'echo CHAIN-CASCADE-OK',

    // the focus funnel through owner events (bar title mirrors win's state)
    'winbox &',
    'wmctl wait win winbox 15000',
    'wmctl wait win mb-bar-inact 8000',     // create-steal -> FOCUS_LOST
    'WSID=$(wmctl list | grep "winbox$" | sed "s/[^0-9].*//")',
    'wmctl focus $PSID',
    'wmctl wait win mb-bar-act 8000',       // wmFocus -> FOCUS_GAINED
    'wmctl focus $WSID',
    'wmctl wait win mb-bar-inact 8000',
    'wmctl min $WSID',
    'wmctl wait win mb-bar-act 8000',       // focus fall -> FOCUS_GAINED
    'echo FOCUS-FUNNEL-OK',

    // the grab: bar click opens mb-menu (POPUP_MENU) and focuses the parent
    'wmctl sdown 440 360',
    'wmctl sup 440 360',
    'wmctl wait win mb-menu 8000',
    'wmctl wait flag $PSID f 8000',         // child click focused the ROOT
    'MSID=$(wmctl list | grep "mb-menu$" | sed "s/[^0-9].*//")',
    'wmctl sdown 410 380',                  // click inside mb-menu -> mb-menu2
    'wmctl sup 410 380',
    'wmctl wait win mb-menu2 8000',
    'M2SID=$(wmctl list | grep "mb-menu2$" | sed "s/[^0-9].*//")',
    'wmctl sdown 750 320',                  // OUTSIDE press on mb-two, CLEAR of the
    // dragged parent (400..700 x 350..550) — an in-window press is INSIDE the
    // grab tree by design (the app engine's own dismissal turf, design §3.5)
    'wmctl sup 750 320',
    'wmctl wait gone $M2SID 8000',          // dismissal closed the whole chain
    'wmctl wait gone $MSID 8000',
    'echo ==l4',
    'wmctl list',
    'echo ==cut',
    'wmctl sdown 750 320',                  // the next click is ALLOWED
    'wmctl sup 750 320',
    'wmctl wait win mb-two-1 8000',         // exactly ONE delivery ever
    'wmctl wait flag $TSID f 8000',         // and it focuses mb-two normally
    'echo GRAB-OK',

    // A5: resize the parent; the app owner-resizes the strip to full width.
    // Refocus menubox first so its tree raises above mb-two (which overlaps
    // the widened strip region) — the s5 probe must see the strip.
    'wmctl focus $PSID',
    'wmctl wait flag $PSID f 8000',
    'wmctl resize $PSID 400 240',
    'wmctl wait dim $PSID 400x240 8000',
    'wmctl wait dim $BSID 400x20 8000',
    'wmctl shot screen /root/s5.ppm && echo S5-OK',

    // destroy cascade: close the parent; bar + open popup die kernel-side,
    // the sibling top-level survives
    'wmctl sdown 440 360',
    'wmctl sup 440 360',
    'wmctl wait win mb-menu 8000',
    'M3SID=$(wmctl list | grep "mb-menu$" | sed "s/[^0-9].*//")',
    'wmctl close $PSID',
    'wmctl wait gone $PSID 8000',
    'wmctl wait gone $BSID 8000',
    'wmctl wait gone $M3SID 8000',
    'echo ==l5',
    'wmctl list',
    'echo ==cut',
    'echo DONE',
  ], { image, timeout: 300000 }).stdout;

  check('script ran to completion', out.includes('DONE'));
  check('SDL_GetDisplayBounds reports the real screen',
    out.includes('menubox: display 1024x768'));

  // ---- geometry: children materialized at parent + offset, following moves
  const l1 = section(out, 'l1');
  const p1 = row(l1, 'menubox'), b1 = row(l1, 'mb-bar-act');
  check('parent moved to (300,250)', p1 && p1.x === 300 && p1.y === 250, JSON.stringify(p1));
  check('bar rides the parent client origin, full width',
    b1 && b1.x === 300 && b1.y === 250 && b1.w === 300 && b1.h === 20, JSON.stringify(b1));

  const l2 = section(out, 'l2');
  const tp = row(l2, 'mb-tpop'), ts = row(l2, 'mb-tsub');
  check('popup child anchored at (4,20), overflowing the parent (300 tall)',
    tp && tp.x === 304 && tp.y === 270 && tp.w === 120 && tp.h === 300, JSON.stringify(tp));
  check('grandchild anchored to the POPUP (A1 chain)',
    ts && ts.x === 414 && ts.y === 278 && ts.w === 100 && ts.h === 80, JSON.stringify(ts));

  const l3 = section(out, 'l3');
  const p3 = row(l3, 'menubox'), b3 = row(l3, 'mb-bar-act') || row(l3, 'mb-bar-inact'),
        tp3 = row(l3, 'mb-tpop'), ts3 = row(l3, 'mb-tsub');
  check('title drag moved the parent (+100,+100)', p3 && p3.x === 400 && p3.y === 350, JSON.stringify(p3));
  check('bar followed the drag', b3 && b3.x === 400 && b3.y === 350, JSON.stringify(b3));
  check('popup followed the drag', tp3 && tp3.x === 404 && tp3.y === 370, JSON.stringify(tp3));
  check('grandchild followed the drag (recursive, A1)',
    ts3 && ts3.x === 514 && ts3.y === 378, JSON.stringify(ts3));

  check('mid-tree cascade: the kernel destroyed the grandchild', out.includes('CHAIN-CASCADE-OK'));
  check('focus funnel: all three transitions delivered', out.includes('FOCUS-FUNNEL-OK'));
  check('grab: outside click dismissed the chain and was consumed', out.includes('GRAB-OK'));

  const l4 = section(out, 'l4');
  check('consumed click left the parent focused', /\tmenubox$/m.test(l4) &&
    row(l4, 'menubox').flags.includes('f'), JSON.stringify(row(l4, 'menubox')));
  check('consumed click never reached the sibling (counter still 0)',
    row(l4, 'mb-two-0') !== null, l4);

  const l5 = section(out, 'l5');
  check('cascade close: no menubox windows remain', !l5.includes('menubox') &&
    !l5.includes('mb-bar') && !l5.includes('mb-menu'), l5);
  check('the sibling top-level SURVIVES the cascade (not a child)',
    row(l5, 'mb-two-1') !== null, l5);

  // ---- pixels: the deterministic composite (1024x768 screen shots) ----
  for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    check(`${s} shot written`, out.includes(s + '-OK'));
  }
  const bytes = fs.readFileSync(path.join(dir, 'os-root.img'));
  const store2 = new BLOCK_FS.MemoryByteStore(bytes.length);
  store2.setBytes(0, bytes);
  const ufs = BLOCK_FS.createV4(store2);
  const px = (name, x, y) => {
    const ppm = COMMON.readFileBytes(ufs, '/root/' + name);
    const head = Buffer.from(ppm.subarray(0, 20)).toString('latin1');
    const off = head.indexOf('255\n') + 4;
    return String(Array.from(
      ppm.subarray(off + (y * 1024 + x) * 3, off + (y * 1024 + x) * 3 + 3)));
  };
  const GRAY = '200,200,200', BLACK = '0,0,0', YELLOW = '230,210,40', MAGENTA = '200,40,180';
  // s1: parent at (300,250); bar glyph 'M' first ink pixel at bar-local (4,3)
  check('child TEXT pixels composite over the parent (glyph ink)',
    px('s1.ppm', 304, 253) === BLACK, px('s1.ppm', 304, 253));
  check('...on the bar strip ground', px('s1.ppm', 316, 260) === GRAY, px('s1.ppm', 316, 260));
  // s2: popup overflow — yellow BELOW the parent's bottom edge (450)
  check('popup pixels composite INSIDE the parent area', px('s2.ppm', 350, 400) === YELLOW,
    px('s2.ppm', 350, 400));
  check('popup OVERFLOWS the parent window (yellow past its bottom)',
    px('s2.ppm', 350, 500) === YELLOW, px('s2.ppm', 350, 500));
  check('grandchild pixels composite too', px('s2.ppm', 450, 300) === MAGENTA,
    px('s2.ppm', 450, 300));
  // s3/s4: minimize hides the subtree, restore shows it (parent at 400,350)
  check('minimize hides the bar strip', px('s3.ppm', 440, 360) !== GRAY, px('s3.ppm', 440, 360));
  check('minimize hides the overflowing popup', px('s3.ppm', 450, 600) !== YELLOW,
    px('s3.ppm', 450, 600));
  check('restore shows the bar again', px('s4.ppm', 440, 360) === GRAY, px('s4.ppm', 440, 360));
  check('restore shows the popup again', px('s4.ppm', 450, 600) === YELLOW, px('s4.ppm', 450, 600));
  // s5 (A5): the strip spans the resized parent's full 400px width
  check('owner-resized strip spans the new parent width',
    px('s5.ppm', 790, 360) === GRAY, px('s5.ppm', 790, 360));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nmenubox e2e: PASS' : `\nmenubox e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
