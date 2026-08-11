#!/usr/bin/env node
// /bin/deck end to end (todos/0284): the gucOS slide presenter.
//
//   - --validate on the seeded demo deck (4 slides, 0 warnings)
//   - --shot golden pixels on the demo's diagram slide (box fills, the
//     default-stroke arrow, theme background) — the headless render surface
//   - a broken deck --validate exits nonzero with the structured parse
//     error (byte offset)
//   - the PRESENT-MODE RELOAD CONTRACT (Lane 2, design §1.2/§1.3):
//       . self-maximize at startup (spawned wmctl max on the own title)
//       . live reload over the FS_WATCH park: a tmp+RENAME-OVER save (the
//         editor atomic-save shape) re-renders the NEW deck
//       . slide preserved BY ID across a reload that reorders slides
//       . a BROKEN save keeps the LAST-GOOD deck rendered under the red
//         error banner (never blank, never lose the page), truncate-
//         rewrite shape; a subsequent good save recovers and drops it
//       . Ctrl-R manual reload
//   - openwith: the baked `deck` association opens a .deck through open(1)
//   - seeding: /usr/share/deck + the Demos menu entry
//
// Colors are asserted as the DOMINANT shot color (the mgp live-reload
// precedent) so the check is "the reloaded deck rendered", not merely
// "pixels changed".
//
// Run: node tests/kernel/test_deck_e2e.js
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir, image } = freshImage('os-deck-');

// Tiny self-contained decks for the reload legs. Slide backgrounds are
// full-slide rects so nav/reload changes flip the dominant color (the deck
// theme background is per-deck, not per-slide).
const fullRect = (id, color) =>
  `{"id":"${id}","type":"rect","x":0,"y":0,"w":640,"h":360,` +
  `"style":{"fill":"${color}","stroke":"none"}}`;
const deckJson = (slides) =>
  `{"deck":1,"size":{"w":640,"h":360},"theme":{"background":"#204080"},` +
  `"slides":[${slides}]}`;
const slide = (id, color) =>
  `{"id":"${id}","elements":[${fullRect('bg-' + id, color)}]}`;

// v1: two slides — ONE #285028, TWO #7a3030
const v1 = deckJson([slide('one', '#285028'), slide('two', '#7a3030')].join(','));
// v2 (rename-over while sitting on 'two'): 'two' moves to INDEX 2 behind
// two new slides — by-id preservation keeps showing #7a3030; an
// index-clamp would land on 'extra' (#306070) instead.
const v2 = deckJson([slide('pad', '#502850'), slide('extra', '#306070'),
                     slide('two', '#7a3030')].join(','));
// v4 (recovery after the broken save): single slide #603070
const v4 = deckJson([slide('only', '#603070')]);

const script = [
  'echo ==validate',
  'deck --validate /usr/share/deck/gucos.deck',
  'echo ==',
  'deck --shot /root/arch.png --slide arch /usr/share/deck/gucos.deck && echo shot-ok',
  'echo '.concat("'", '{"deck":1, broken', "'", ' > /root/bad.deck'),
  'deck --validate /root/bad.deck; echo bad-rc=$?',
  'echo ==seed',
  'ls /usr/share/deck',
  'cat /usr/share/menu/Demos/deck',
  'echo ==',

  /* ---- present mode: the reload contract ---- */
  `echo '${v1}' > /root/live.deck`,
  'deck /root/live.deck &',
  'wmctl wait win "deck: live.deck"',
  // self-maximize: 1024x768 headless screen - 36 taskbar - 28 title = 704
  'wmctl wait dim $(wmctl list | grep "deck: live" | sed "s/[^0-9].*//") 1024x704 && echo max-ok',
  'sleep 3',                     // first maximized render settle (freetype; no marker)
  'SID=$(wmctl list | grep "deck: live" | sed "s/[^0-9].*//")',
  'wmctl shot $SID /root/p1.png && echo p1-ok',
  'wmctl key $SID 0 1073741903', // Right arrow (SDLK_RIGHT) -> slide "two"
  'sleep 2',                     // nav re-render settle (no marker)
  'wmctl shot $SID /root/p2.png && echo p2-ok',
  // Leg: tmp + RENAME-OVER (editor atomic save) reload, slide preserved BY
  // ID — "two" moved from index 1 to index 2, the view must follow the id.
  `echo '${v2}' > /root/live.tmp`,
  'mv /root/live.tmp /root/live.deck && echo mv-ok',
  'sleep 3',                     // watch wake -> reload -> re-render (no marker)
  'wmctl shot $SID /root/p3.png && echo p3-ok',
  // Leg: BROKEN truncate-rewrite save — last-good holds + red banner.
  'echo '.concat("'", '{"deck":1, broken', "'", ' > /root/live.deck'),
  'sleep 3',                     // watch wake -> failed reload -> banner (no marker)
  'wmctl shot $SID /root/p4.png && echo p4-ok',
  // Leg: good save recovers (banner drops with the fresh deck).
  `echo '${v4}' > /root/live.deck`,
  'sleep 3',                     // watch wake -> reload -> re-render (no marker)
  'wmctl shot $SID /root/p5.png && echo p5-ok',
  // Leg: Ctrl-R manual reload (keysym r + KMOD_LCTRL) — a 3rd "reloaded"
  // stderr line with no file change.
  'wmctl key $SID 0 114 64',
  'sleep 2',                     // reload + re-render settle (no marker)
  'wmctl key $SID 0 113',        // q
  'wmctl wait nowin "deck: live.deck"',
  'echo present-done',

  /* ---- openwith: .deck opens through open(1) ---- */
  `echo '${v4}' > /root/via-open.deck`,
  'open /root/via-open.deck &',      // open(1) waits on its child
  'wmctl wait win "deck: via-open.deck"',
  'OSID=$(wmctl list | grep "via-open" | sed "s/[^0-9].*//")',
  'wmctl key $OSID 0 113',
  'wmctl wait nowin "deck: via-open.deck"',
  'echo open-done',
  'echo ALLDONE',
];

const a = driveBoot(script, { image, timeout: 420000 });
// deck's diagnostics (reload reports, validate errors) are stderr lines;
// a piped boot keeps fd 2 out of the tty stream, so assert on both.
const out = (a.stdout || '') + '\n' + (a.stderr || '');

check('validate: seeded demo deck OK',
  section(out, 'validate').includes('deck: OK: 4 slides, 0 warnings'),
  JSON.stringify(section(out, 'validate')));
check('--shot wrote the arch slide', out.includes('shot-ok'));
check('broken deck --validate exits 1', out.includes('bad-rc=1'));
check('broken deck error carries the parse byte offset',
  /ERROR: .*at byte \d+/.test(out));
const seed = section(out, 'seed');
check('seeded /usr/share/deck holds deck + image',
  seed.includes('gucos.deck') && seed.includes('deck-title.png'), seed);
check('Demos menu entry launches the seeded deck',
  seed.includes('deck /usr/share/deck/gucos.deck'));

check('self-maximized to the work area', out.includes('max-ok'));
for (const m of ['p1-ok', 'p2-ok', 'mv-ok', 'p3-ok', 'p4-ok', 'p5-ok'])
  check('marker ' + m, out.includes(m));
check('reload reported twice + Ctrl-R = 3 "deck: reloaded" lines',
  (out.match(/deck: reloaded \/root\/live\.deck/g) || []).length === 3,
  (out.match(/deck: reloaded \/root\/live\.deck/g) || []).length);
check('broken save reported + last-good hold announced',
  out.includes('deck: holding last-good deck'));
check('present session completed', out.includes('present-done'));
check('openwith .deck association opened deck', out.includes('open-done'));
check('session A completed', out.includes('ALLDONE'));

/* ---- session B: read the shots + the --shot PNG back ---- */
const b = driveBoot(
  'cat /root/p1.png /root/p2.png /root/p3.png /root/p4.png /root/p5.png\n' +
  'base64 /root/arch.png\n',
  { image, timeout: 120000, maxBuffer: 64 * 1024 * 1024, encoding: null });
const buf = b.stdout;

function parseShot(buffer) {
  // concatenated PNG shots (#657); stop at the first non-PNG byte, which is
  // the normal trailing tty noise after the last cat-back.
  const shots = [];
  let off = 0;
  while (off < buffer.length) {
    let p;
    try { p = parsePng(buffer, off); } catch (e) { break; }
    shots.push(p);
    off = p.next;
  }
  return { shots: shots, tail: off };
}
const { shots, tail } = parseShot(buf);
check('read 5 PNGs back', shots.length === 5, 'got ' + shots.length);

const near = (v, t) => Math.abs(v - t) <= 12;
function fraction(shot, [r, g, b]) {
  let n = 0;
  const total = shot.w * shot.h;
  for (let y = 0; y < shot.h; y++)
    for (let x = 0; x < shot.w; x++) {
      const i = (y * shot.w + x) * 4;
      if (near(shot.rgba[i], r) && near(shot.rgba[i + 1], g) && near(shot.rgba[i + 2], b)) n++;
    }
  return n / total;
}

const ONE = [0x28, 0x50, 0x28], TWO = [0x7a, 0x30, 0x30];
const EXTRA = [0x30, 0x60, 0x70], FIXED = [0x60, 0x30, 0x70];
const BANNER = [178, 24, 32];
if (shots.length === 5) {
  const [p1, p2, p3, p4, p5] = shots;
  check('p1: slide "one" dominant', fraction(p1, ONE) > 0.6,
    fraction(p1, ONE).toFixed(3));
  check('p2: Right arrow navigated to "two"', fraction(p2, TWO) > 0.6,
    fraction(p2, TWO).toFixed(3));
  check('p3: rename-over reload preserved slide BY ID (not index)',
    fraction(p3, TWO) > 0.6 && fraction(p3, EXTRA) < 0.05,
    `two=${fraction(p3, TWO).toFixed(3)} extra=${fraction(p3, EXTRA).toFixed(3)}`);
  check('p4: broken save HELD the last-good slide', fraction(p4, TWO) > 0.5,
    fraction(p4, TWO).toFixed(3));
  check('p4: red error banner rendered', fraction(p4, BANNER) > 0.02,
    fraction(p4, BANNER).toFixed(3));
  check('p5: good save recovered', fraction(p5, FIXED) > 0.6,
    fraction(p5, FIXED).toFixed(3));
  check('p5: banner dropped', fraction(p5, BANNER) < 0.005,
    fraction(p5, BANNER).toFixed(3));
}

/* ---- the --shot golden: decode the PNG and probe the arch diagram ---- */
function decodePng(bytes) {
  let o = 8;
  let w = 0, h = 0;
  const idat = [];
  while (o < bytes.length) {
    const len = bytes.readUInt32BE(o);
    const type = bytes.slice(o + 4, o + 8).toString('latin1');
    const data = bytes.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6)
        throw new Error('decodePng: expected 8-bit RGBA');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(w * h * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= 4 ? px[row + x - 4] : 0;
      const up = y > 0 ? px[row - stride + x] : 0;
      const ul = y > 0 && x >= 4 ? px[row - stride + x - 4] : 0;
      let out;
      switch (f) {
        case 0: out = v; break;
        case 1: out = v + left; break;
        case 2: out = v + up; break;
        case 3: out = v + ((left + up) >> 1); break;
        case 4: out = v + paeth(left, up, ul); break;
        default: throw new Error('decodePng: bad filter ' + f);
      }
      px[row + x] = out & 0xff;
    }
  }
  return { w, h, px };
}
const b64 = buf.slice(tail).toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
let png = null;
try { png = decodePng(Buffer.from(b64, 'base64')); } catch (e) { png = { err: e.message }; }
check('arch.png decodes at the deck logical size',
  png && png.w === 1280 && png.h === 720, png && (png.err || png.w + 'x' + png.h));
if (png && png.px) {
  const at = (x, y) => [png.px[(y * png.w + x) * 4], png.px[(y * png.w + x) * 4 + 1],
                        png.px[(y * png.w + x) * 4 + 2]];
  const close = (p, t) => near(p[0], t[0]) && near(p[1], t[1]) && near(p[2], t[2]);
  check('golden: theme background', close(at(60, 360), [0x10, 0x14, 0x18]),
    at(60, 360));
  check('golden: box-page fill', close(at(110, 190), [0x1d, 0x27, 0x33]),
    at(110, 190));                       // inside the box, above its label
  check('golden: process box fill', close(at(1000, 105), [0x16, 0x21, 0x1a]),
    at(1000, 105));
  check('golden: default-stroke arrow core', close(at(400, 225), [0xe8, 0xe8, 0xe8]),
    at(400, 225));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\ndeck e2e: PASS' : `\ndeck e2e: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
