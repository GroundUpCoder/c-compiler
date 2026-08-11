#!/usr/bin/env node
// todos/0275 acceptance: the ksvc kernel-C text service — label text in the
// HEADLESS composite (`wmctl shot screen`), rasterized by the same
// /usr/lib/ksvc.wasm blob the browser compositor uses.
//
// The strong form is the SAME-BYTES assertion: this test renders the title
// via os/ksvc.js DIRECTLY over the same system image and bit-compares the
// composite's title strip against src-over(label, title-navy) with the
// exact kernel.js 0063 integer formula — not "some pixels changed", but
// "the composite contains exactly the bytes our rasterizer produced".
// Legs:
//   - "winbox": title text pixels exist left of the boxes + same-bytes;
//     the close-box 'x' has ink.
//   - overlong title: ellipsis truncation (measure > maxW, rendered width
//     <= maxW, no fillText squish) + same-bytes.
//   - CJK title (no font package on the fixture root): honest tofu boxes,
//     same-bytes — coverage parity with gdi32/term on the same image (the
//     real-glyph CJK title leg lives in gucos-packages/tests/test_fontpkg_e2e.js (#615), which owns
//     the install/remove story).
//   - Exposé caption: overview N=1 → the caption renders centered under
//     the cell, same-bytes over the desktop/border background.
//
// Run: node tests/kernel/test_ksvc_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const OS_KSVC = require(path.join(ROOT, 'os', 'ksvc.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const LONG = 'longtitle-abcdefghijklmn';   // 24 chars: overflows 158px maxW,
                                           // fits the 32-byte WMP record so
                                           // `wmctl wait win` matches exactly
const CJK = '日本語';                       // tofu on the package-less fixture

const { dir: tmp, image } = freshImage('os-ksvc-');

// One "titled winbox up → shot → down" episode.
function episode(title, tag) {
  const spawn = title === null ? 'winbox &' : `winbox title "${title}" &`;
  const name = title === null ? 'winbox' : title;
  return [
    spawn,
    `wmctl wait win "${name}"`,
    'sleep 1',   // genuine no-marker settle: wm.c EV_CREATED MOVE (map ack)
    `echo ==list-${tag}`,
    'wmctl list',
    `wmctl shot screen /root/${tag}.png && echo shot-${tag}-ok`,
    'pkill winbox',
    `wmctl wait nowin "${name}"`,
  ];
}

const script = [
  ...episode(null, 'base'),
  ...episode(LONG, 'long'),
  ...episode(CJK, 'cjk'),
  // Exposé caption: one window, enter overview, shot (cell = 240x160+392+288
  // on the 1024x768 headless screen — the test_overview_e2e constants).
  'winbox &',
  'wmctl wait win winbox',
  'sleep 1',   // genuine no-marker settle (as above)
  'echo ==list-ov',
  'wmctl list',
  'wmctl overview && echo overview-ok',
  'sleep 1',   // genuine no-marker settle: EV_OVERVIEW -> OVERVIEW_SET round-trip
  'wmctl shot screen /root/ov.png && echo shot-ov-ok',
  'echo ==done',
];

const a = driveBoot(script, { image, timeout: 600000 });
const aout = String(a.stdout || '');
for (const tag of ['base', 'long', 'cjk', 'ov'])
  check(`${tag} shot written`, aout.includes(`shot-${tag}-ok`));
check('overview entered', aout.includes('overview-ok'));

// ---- read the PNG shots back over the same image ----
const b = driveBoot('cat /root/base.png /root/long.png /root/cjk.png /root/ov.png\n',
  { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });

// One PNG shot out of the concatenated cat-back stream (#657);
// null on a missing/short shot, so the callers' `if (!p)` guards hold.
function parseShot(buf, off) {
  try { return parsePng(buf, off); } catch (e) { return null; }
}
const shots = {};
{
  let off = 0;
  for (const tag of ['base', 'long', 'cjk', 'ov']) {
    const p = parseShot(b.stdout, off);
    check(`${tag} PNG parses`, !!p);
    if (!p) return finish();
    shots[tag] = p;
    off = p.next;
  }
}

// wmctl list geometry (WxH+X+Y) for the window titled `name` in section `tag`
// (display truncates titles to 31 chars — match on that prefix).
function geom(tag, name) {
  const disp = name.slice(0, 31);
  for (const line of section(aout, 'list-' + tag).split('\n')) {
    const f = line.split('\t');
    if (f.length >= 7 && f[6] === disp) {
      const m = f[2].match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
      if (m) return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
    }
  }
  return null;
}

// ---- the ksvc oracle: the SAME blob over the SAME system image ----
const store = new COMMON.NodeFileStore(fs, image, false);
const sysFs = BLOCK_FS.createV4(store, { readonly: true });
// Empty root volume: /etc/fonts is absent on the OS's fresh root too, so
// face 0 + chain resolve identically (face 0 = the baked /usr face).
const memStore = new BLOCK_FS.MemoryByteStore(8 * 1024 * 1024);
const kfs = new BLOCK_FS.MountFS({ '/': BLOCK_FS.createV4(memStore), '/usr': sysFs });
const svc = OS_KSVC.load(kfs, {});

const srcover = (s, a, d) => (s * a + d * (255 - a) + 127) / 255 | 0;

// Bit-compare a label render against a composite region whose background is
// given per-row by bg(row) -> [r,g,b]. Returns the first mismatch or null.
function compareLabel(shot, label, x0, y0, bg) {
  for (let gy = 0; gy < label.h; gy++) {
    for (let gx = 0; gx < label.w; gx++) {
      const si = (gy * label.w + gx) * 4;
      const al = label.bytes[si + 3];
      const back = bg(y0 + gy);
      const exp = [
        srcover(label.bytes[si], al, back[0]),
        srcover(label.bytes[si + 1], al, back[1]),
        srcover(label.bytes[si + 2], al, back[2]),
      ];
      const di = ((y0 + gy) * shot.w + (x0 + gx)) * 4;
      for (let c = 0; c < 3; c++) {
        if (b.stdout[di + c] !== exp[c]) {
          return { x: x0 + gx, y: y0 + gy, c,
                   got: b.stdout[di + c], want: exp[c], alpha: al };
        }
      }
    }
  }
  return null;
}

const NAVY = K.WM_COLORS.titleFocused;
const titleMaxW = (dw) => Math.max(8, dw - 3 * (K.WM_CLOSE_W + K.WM_BOX_GAP) - 16);

// One title-strip same-bytes leg. Returns the label render for extra checks.
function titleLeg(tag, name) {
  const g = geom(tag, name);
  check(`${tag}: window listed with geometry`, !!g);
  if (!g) return null;
  const label = svc.render(name, K.WM_LABEL_PX, titleMaxW(g.w), 0xFFFFFFFF, 1);
  const x0 = g.x + 6;
  const y0 = Math.round((g.y - K.WM_TITLE_H / 2) - label.h / 2);
  // label must be a copy — the next svc.render invalidates the view
  const copy = { w: label.w, h: label.h, bytes: Uint8Array.from(label.bytes) };
  const mm = compareLabel(shots[tag], copy, x0, y0, () => NAVY);
  check(`${tag}: title strip is bit-exact ksvc bytes over navy`, !mm,
    mm && JSON.stringify(mm));
  // presence: the strip really has non-navy pixels (text exists at all)
  let ink = 0;
  for (let gy = 0; gy < copy.h; gy++)
    for (let gx = 0; gx < copy.w; gx++) {
      const di = ((y0 + gy) * shots[tag].w + (x0 + gx)) * 4;
      if (b.stdout[di] !== NAVY[0] || b.stdout[di + 1] !== NAVY[1] ||
          b.stdout[di + 2] !== NAVY[2]) ink++;
    }
  check(`${tag}: title text ink present`, ink > 20, String(ink));
  return { g, label: copy };
}

// ---- base leg: "winbox" + the close-box 'x' ----
const base = titleLeg('base', 'winbox');
if (base) {
  const { g } = base;
  // close 'x': ink inside the close box (pre-0275 headless had NO x glyph)
  const bx = g.x + g.w - K.WM_CLOSE_W - K.WM_CLOSE_PAD;
  const by = g.y - K.WM_TITLE_H + K.WM_CLOSE_PAD;
  let dark = 0;
  for (let yy = by; yy < by + K.WM_CLOSE_W; yy++)
    for (let xx = bx; xx < bx + K.WM_CLOSE_W; xx++) {
      const di = (yy * shots.base.w + xx) * 4;
      if (b.stdout[di] < 96 && b.stdout[di + 1] < 96 && b.stdout[di + 2] < 96) dark++;
    }
  check('base: close box has the rasterized x (dark ink)', dark > 5, String(dark));
}

// ---- ellipsis leg ----
const long = titleLeg('long', LONG);
if (long) {
  const maxW = titleMaxW(long.g.w);
  const full = svc.measure(LONG, K.WM_LABEL_PX, 1);
  check('long: full title measures past maxW (truncation forced)',
    full > maxW, `${full} vs ${maxW}`);
  check('long: rendered width fits maxW (ellipsis, not squish)',
    long.label.w <= maxW && long.label.w > 0, String(long.label.w));
  check('long: rendered strictly narrower than the full measure',
    long.label.w < full, `${long.label.w} vs ${full}`);
}

// ---- CJK tofu leg (no font package on this image's root) ----
titleLeg('cjk', CJK);

// ---- Exposé caption leg ----
{
  const g = geom('ov', 'winbox');
  check('ov: window listed', !!g);
  if (g) {
    // N=1 grid on 1024x768: cell 240x160+392+288 (test_overview_e2e).
    const cell = { x: 392, y: 288, w: 240, h: 160 };
    // sanity: the live miniature is really there (interior orange)
    const mi = ((cell.y + 64) * shots.ov.w + (cell.x + 88)) * 4;
    check('ov: miniature interior is winbox orange',
      b.stdout[mi] === 255 && b.stdout[mi + 1] === 140 && b.stdout[mi + 2] === 0,
      [b.stdout[mi], b.stdout[mi + 1], b.stdout[mi + 2]].join(','));
    const label = svc.render('winbox', K.WM_LABEL_PX, Math.max(8, cell.w), 0xFFFFFFFF, 1);
    const copy = { w: label.w, h: label.h, bytes: Uint8Array.from(label.bytes) };
    const x0 = Math.round(cell.x + cell.w / 2 - copy.w / 2);
    const y0 = cell.y + cell.h + 2;
    // background: the cell's border frame (OVB=3) reaches row y+h+2; below
    // it the desktop. (Not hovered: no pointer was injected.)
    const OVB = 3;
    const bg = (row) => row < cell.y + cell.h + OVB ? K.WM_COLORS.border
                                                    : K.WM_COLORS.desktop;
    const mm = compareLabel(shots.ov, copy, x0, y0, bg);
    check('ov: caption is bit-exact ksvc bytes centered under the cell', !mm,
      mm && JSON.stringify(mm));
  }
}

finish();

function finish() {
  try { store.close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nksvc e2e: ${failures} FAILED` : '\nksvc e2e: PASS');
  process.exit(failures ? 1 : 0);
}
