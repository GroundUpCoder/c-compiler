#!/usr/bin/env node
// C1 (ticket #281) acceptance: multi-face proportional CreateFont in gdi32.
// C2 (ticket #282) rides here too: the stock-font flag day (UI stocks sans,
// fixed stocks mono) and the multi-face ChooseFontW dialog (enumeration,
// sample re-render in the selected face, LOGFONT round-trip, preselect).
// Drives /bin/fontramp (os/win32/fontramp.c) through os/boot.js:
//
//   - probe legs: metric/render relationships between faces — mono stays
//     monospace and BYTE-IDENTICAL to the NULL-face default (the
//     no-flag-day half), sans/serif are proportional with distinct
//     renders, bold weighs more ink, REAL italic files are preferred
//     where baked (sans italic's advances differ from upright — a shear
//     can't do that) while mono/serif italic SYNTHESIZE (advance-
//     preserving shear), underline/strikeout draw real rules, the Win32
//     name mapper routes known faces, and /etc/fonts/NAME.ttf overrides
//     the baked file per face (which also proves the bold FILE is
//     consulted, not an embolden of the upright).
//   - synthetic-bold leg (arm 1 of the @master ruling): this test's OWN
//     blob copy is doctored host-side (bold file unlinked, re-sealed) and
//     a second boot proves the selection logic SYNTHESIZES — bold ink,
//     fingerprint distinct from both upright and the real file.
//   - windowed legs: a ramp window per face spec, `wmctl shot` each —
//     shots land as PNGs in build/test-kernel/fontramp/ (the committed
//     evidence set is copied from there), asserted inked and pairwise
//     distinct.
//
// Run: node tests/kernel/test_multiface_font_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePpm, encodePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-font-');

/* ---- probe session ------------------------------------------------- */

// One `fontramp probe` invocation per spec; blocks parsed back by label.
const PROBES = [
  ['mono', 'mono'],
  ['default', 'default'],
  ['mono-bold', 'mono bold'],
  ['mono-italic', 'mono italic'],
  ['sans', 'sans'],
  ['sans-bold', 'sans bold'],
  ['sans-italic', 'sans italic'],
  ['sans-bold-italic', 'sans bold italic'],
  ['serif', 'serif'],
  ['serif-bold', 'serif bold'],
  ['serif-italic', 'serif italic'],
  ['mono-ul', 'mono ul'],
  ['mono-so', 'mono so'],
  ['courier', '"Courier New"'],
  ['lucida', '"Lucida Console"'],
  ['shelldlg', '"MS Shell Dlg"'],
  ['times', '"Times New Roman"'],
  ['comic', '"Comic Sans MS"'],
  ['unknown', '"Zapf Chancery"'],
  // C2 (#282): the stock-font flag day — UI stocks sans, fixed stocks mono.
  ['stock-system', 'stock SYSTEM_FONT'],
  ['stock-gui', 'stock DEFAULT_GUI_FONT'],
  ['stock-ansivar', 'stock ANSI_VAR_FONT'],
  ['stock-devdef', 'stock DEVICE_DEFAULT_FONT'],
  ['stock-oemfix', 'stock OEM_FIXED_FONT'],
  ['stock-ansifix', 'stock ANSI_FIXED_FONT'],
  ['stock-sysfix', 'stock SYSTEM_FIXED_FONT'],
];

function parseProbes(out) {
  // Split on the echoed marker each invocation prints first.
  const blocks = {};
  const parts = out.split(/^==p:/m).slice(1);
  for (const part of parts) {
    const label = part.slice(0, part.indexOf('\n'));
    const p = {};
    const tm = part.match(/^tm: h=(-?\d+) asc=(-?\d+) desc=(-?\d+) avew=(-?\d+) maxw=(-?\d+) weight=(\d+) italic=(\d) ul=(\d) so=(\d) pf=(\d+)$/m);
    if (tm) {
      p.h = +tm[1]; p.asc = +tm[2]; p.desc = +tm[3]; p.avew = +tm[4];
      p.maxw = +tm[5]; p.weight = +tm[6]; p.italic = +tm[7];
      p.ul = +tm[8]; p.so = +tm[9]; p.pf = +tm[10];
    }
    const adv = part.match(/^adv: i=(\d+) M=(\d+) x=(\d+) W=(\d+)$/m);
    if (adv) { p.ai = +adv[1]; p.aM = +adv[2]; p.ax = +adv[3]; p.aW = +adv[4]; }
    const ext = part.match(/^ext: cx=(\d+) cy=(\d+)$/m);
    if (ext) { p.cx = +ext[1]; p.cy = +ext[2]; }
    const ink = part.match(/^ink: n=(\d+) hash=([0-9a-f]{8})$/m);
    if (ink) { p.ink = +ink[1]; p.hash = ink[2]; }
    // The full metric+render fingerprint (everything but the probe: echo).
    p.all = (part.match(/^(tm|adv|ext|ink):.*$/gm) || []).join('\n');
    blocks[label.trim()] = p;
  }
  return blocks;
}

function probeSession() {
  const lines = [];
  for (const [label, spec] of PROBES) {
    lines.push(`echo ==p:${label}`, `fontramp probe ${spec}`);
  }
  // /etc override: serif.ttf planted AS sans_bold.ttf must win over the
  // baked file — proving the per-face /etc > /usr pair AND that bold is
  // the FILE, not an embolden of the upright.
  lines.push(
    'mkdir -p /etc/fonts',
    'cp /usr/share/fonts/serif.ttf /etc/fonts/sans_bold.ttf',
    'echo ==p:override', 'fontramp probe sans bold',
    'rm /etc/fonts/sans_bold.ttf',
    'echo ==p:restored', 'fontramp probe sans bold',
    '');
  const r = driveBoot(lines.join('\n'), { image, timeout: 240000 });
  const P = parseProbes(r.stdout);

  const need = PROBES.map(([l]) => l).concat(['override', 'restored']);
  const missing = need.filter(l => !P[l] || !P[l].hash);
  check('all probes produced full output', missing.length === 0,
    'missing: ' + missing.join(',') + '\n' + r.stdout.slice(-500));
  if (missing.length) return null;

  /* no-flag-day: the NULL-face default is byte-identical to mono */
  check('default (NULL face) === mono, metrics AND render',
    P.default.all === P.mono.all, P.default.all + ' vs ' + P.mono.all);
  check('mono is monospace (i=M=x=W)',
    P.mono.ai === P.mono.aM && P.mono.aM === P.mono.ax && P.mono.ax === P.mono.aW,
    JSON.stringify([P.mono.ai, P.mono.aM, P.mono.ax, P.mono.aW]));
  check('mono tmPitchAndFamily stays 0 (pre-C1 value)', P.mono.pf === 0, P.mono.pf);

  /* proportional families */
  check('sans is proportional (i < x < M)',
    P.sans.ai < P.sans.ax && P.sans.ax < P.sans.aM,
    JSON.stringify([P.sans.ai, P.sans.ax, P.sans.aM]));
  check('sans reports TMPF_FIXED_PITCH|FF_SWISS (33)', P.sans.pf === 33, P.sans.pf);
  check('serif reports TMPF_FIXED_PITCH|FF_ROMAN (17)', P.serif.pf === 17, P.serif.pf);
  check('mono/sans/serif render distinctly',
    new Set([P.mono.hash, P.sans.hash, P.serif.hash]).size === 3,
    [P.mono.hash, P.sans.hash, P.serif.hash].join(' '));

  /* bold: real files, more ink, reported weight */
  for (const fam of ['mono', 'sans', 'serif']) {
    const b = P[fam + '-bold'];
    check(`${fam} bold: weight=700, more ink, distinct render`,
      b.weight === 700 && b.ink > P[fam].ink && b.hash !== P[fam].hash,
      `w=${b.weight} ink=${b.ink} vs ${P[fam].ink}`);
  }
  check('mono bold keeps the cell pitch (monospace bold)',
    P['mono-bold'].aM === P.mono.aM && P['mono-bold'].cx === P.mono.cx,
    JSON.stringify([P['mono-bold'].aM, P.mono.aM]));

  /* italic: sans has a REAL file (advances shift — a shear cannot move
   * advances); mono/serif SYNTHESIZE (advance-preserving shear). */
  check('sans italic is the real file (advances differ from upright)',
    P['sans-italic'].italic === 1 && P['sans-italic'].cx !== P.sans.cx,
    `cx ${P['sans-italic'].cx} vs ${P.sans.cx}`);
  for (const fam of ['mono', 'serif']) {
    const it = P[fam + '-italic'];
    check(`${fam} italic synthesizes (advances preserved, render moves)`,
      it.italic === 1 && it.cx === P[fam].cx && it.aM === P[fam].aM &&
      it.hash !== P[fam].hash,
      `cx ${it.cx} vs ${P[fam].cx}, hash ${it.hash} vs ${P[fam].hash}`);
  }
  check('sans bold italic: real file, weight+slant reported',
    P['sans-bold-italic'].weight === 700 && P['sans-bold-italic'].italic === 1 &&
    P['sans-bold-italic'].hash !== P['sans-bold'].hash &&
    P['sans-bold-italic'].hash !== P['sans-italic'].hash);

  /* drawn rules */
  check('underline draws (more ink, flag reported)',
    P['mono-ul'].ul === 1 && P['mono-ul'].ink > P.mono.ink,
    `ink ${P['mono-ul'].ink} vs ${P.mono.ink}`);
  check('strikeout draws (more ink, flag reported)',
    P['mono-so'].so === 1 && P['mono-so'].ink > P.mono.ink,
    `ink ${P['mono-so'].ink} vs ${P.mono.ink}`);

  /* the Win32 name mapper */
  check('"Courier New" -> mono', P.courier.all === P.mono.all);
  check('"Lucida Console" -> mono (notepad default)', P.lucida.all === P.mono.all);
  check('"MS Shell Dlg" -> sans', P.shelldlg.all === P.sans.all);
  check('"Times New Roman" -> serif', P.times.all === P.serif.all);
  check('"Comic Sans MS" -> sans (keyword fallback)', P.comic.all === P.sans.all);
  check('unknown face + DEFAULT_PITCH -> mono (the C1 default)',
    P.unknown.all === P.mono.all);

  /* C2 (#282): the stock-font flag day. The UI stocks are the 20px SANS
   * (metric+render fingerprints identical to CreateFont "sans" at the
   * stock px), and the FIXED stocks keep 20px mono — the documented
   * Win32 mono escape hatch exists and works after the flip. */
  check('SYSTEM_FONT is the 20px sans (metrics AND render)',
    P['stock-system'].all === P.sans.all,
    P['stock-system'].all + ' vs ' + P.sans.all);
  check('DEFAULT_GUI_FONT === SYSTEM_FONT',
    P['stock-gui'].all === P['stock-system'].all);
  check('ANSI_VAR_FONT / DEVICE_DEFAULT_FONT are the sans stock',
    P['stock-ansivar'].all === P.sans.all && P['stock-devdef'].all === P.sans.all);
  check('stock sans is proportional (i < x < M)',
    P['stock-system'].ai < P['stock-system'].ax &&
    P['stock-system'].ax < P['stock-system'].aM,
    JSON.stringify([P['stock-system'].ai, P['stock-system'].ax, P['stock-system'].aM]));
  check('ANSI_FIXED_FONT is the 20px mono (metrics AND render)',
    P['stock-ansifix'].all === P.mono.all,
    P['stock-ansifix'].all + ' vs ' + P.mono.all);
  check('OEM_FIXED_FONT / SYSTEM_FIXED_FONT are the mono stock',
    P['stock-oemfix'].all === P.mono.all && P['stock-sysfix'].all === P.mono.all);

  /* /etc override + the-file-not-embolden proof */
  check('/etc/fonts/sans_bold.ttf override reaches sans bold (renders serif)',
    P.override.hash === P.serif.hash,
    `override ${P.override.hash} vs serif ${P.serif.hash}`);
  check('override removal restores the baked file',
    P.restored.hash === P['sans-bold'].hash,
    `restored ${P.restored.hash} vs baked ${P['sans-bold'].hash}`);
  return P;
}

/* ---- synthetic-bold session (arm 1 of the @master ruling) -----------
 * The inverse of the /etc-override leg: prove gdi32's SELECTION LOGIC
 * takes the SYNTHESIZE branch when the bold file is absent. "Every baked
 * family carries a real bold" is a property of the FIXTURE, not the
 * system — so invert the fixture. /usr is EROFS in-OS by design, so the
 * inversion happens at the layer that owns the blob: this test's own
 * per-image copy of the sealed system image is doctored HOST-side
 * (unlink the bold file, re-seal — runtime mounts don't verify the seal,
 * but the register must stay honest offline), then a second boot probes.
 * Baselines come from boot 1 of the SAME image, so every comparison is
 * within-fixture. */
async function synthBoldSession() {
  const { image: img2 } = freshImage('os-font-synb-');
  const r1 = driveBoot([
    'echo ==p:upright', 'fontramp probe sans',
    'echo ==p:realbold', 'fontramp probe sans bold', ''],
    { image: img2, timeout: 240000 });
  const P1 = parseProbes(r1.stdout);
  if (!P1.upright || !P1.realbold || !P1.upright.hash) {
    check('synth-bold baselines probed', false, r1.stdout.slice(-400));
    return;
  }

  const HOST = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os/os-common.js'));
  const BLOCK_FS = HOST.BLOCK_FS;
  const store = new COMMON.NodeFileStore(fs, img2, false);
  const vol = BLOCK_FS.createV4(store, { noDevNodes: true });
  const un = vol.unlink('/share/fonts/sans_bold.ttf');   // blob paths are /usr-stripped
  check('doctor: bold file unlinked from the blob copy', un === 0, 'unlink=' + un);
  await BLOCK_FS.sealVolume(store);
  const sealOk = await BLOCK_FS.verifySeal(store);
  store.flush();
  check('doctor: blob re-sealed intact', sealOk === true, String(sealOk));

  const r2 = driveBoot([
    'test -e /usr/share/fonts/sans_bold.ttf || echo BOLD-FILE-ABSENT',
    'echo ==p:synbold', 'fontramp probe sans bold', ''],
    { image: img2, timeout: 240000 });
  check('inverted fixture took (bold file absent in-OS)',
    r2.stdout.includes('BOLD-FILE-ABSENT'), r2.stdout.slice(-300));
  const P2 = parseProbes(r2.stdout);
  if (!P2.synbold || !P2.synbold.hash) {
    check('synth-bold probe produced output', false, r2.stdout.slice(-400));
    return;
  }
  /* The ruling's wording: with the bold file unavailable, a sans-bold
   * probe still renders BOLD (more ink than upright) AND its fingerprint
   * differs from the real-file baseline — the branch that ran was
   * synthesize, not fail and not silently-return-upright. */
  check('synth bold reports weight 700', P2.synbold.weight === 700,
    P2.synbold.weight);
  check('synth bold renders BOLD (more ink than upright)',
    P2.synbold.ink > P1.upright.ink,
    `ink ${P2.synbold.ink} vs upright ${P1.upright.ink}`);
  check('synth bold is not silently-upright (render differs)',
    P2.synbold.hash !== P1.upright.hash, P2.synbold.hash);
  check('synth bold is not the real file (fingerprint differs from baked bold)',
    P2.synbold.hash !== P1.realbold.hash, P2.synbold.hash);
  /* Embolden preserves the upright file's metrics (it IS the upright
   * outline, thickened) — the real bold file's metrics need not match. */
  check('synth bold keeps the upright face metrics (asc/desc/maxw)',
    P2.synbold.asc === P1.upright.asc && P2.synbold.desc === P1.upright.desc &&
    P2.synbold.maxw === P1.upright.maxw,
    JSON.stringify([P2.synbold.asc, P2.synbold.desc, P2.synbold.maxw]));
}

/* ---- windowed session (the fontramp evidence shots) ---------------- */

const SHOTS = [
  ['mono', 'mono'],
  ['mono-bold', 'mono bold'],
  ['mono-italic', 'mono italic'],
  ['sans', 'sans'],
  ['sans-bold', 'sans bold'],
  ['sans-italic', 'sans italic'],
  ['sans-bold-italic', 'sans bold italic'],
  ['serif', 'serif'],
  ['serif-bold', 'serif bold'],
  ['serif-italic', 'serif italic'],
];

function windowSession() {
  const lines = [];
  for (let i = 0; i < SHOTS.length; i++) {
    const [, spec] = SHOTS[i];
    const title = 'Font Ramp - ' + spec.replace(/ /g, ' ');
    lines.push(
      `fontramp ${spec} &`,
      `wmctl wait win "${title}" 15000`,
      `SID=$(wmctl list | grep "${title}$" | sed "s/[^0-9].*//")`,
      'wmctl wait seq $SID 1 8000',
      `wmctl shot $SID /root/ramp${i}.ppm && echo shot${i}-ok`,
      'wmctl close $SID',
      `wmctl wait nowin "${title}" 8000`);
  }
  lines.push('');
  const r = driveBoot(lines.join('\n'), { image, timeout: 420000 });
  for (let i = 0; i < SHOTS.length; i++)
    check(`shot ${SHOTS[i][0]} written`, r.stdout.includes(`shot${i}-ok`),
      i === 0 ? r.stdout.slice(-800) : undefined);
}

/* ---- ChooseFontW session (C2, #282) --------------------------------
 * The dialog enumerates gdi32's family table (never a parallel list), a
 * face-row click re-renders the SAMPLE (the cf_preview defect arm: the
 * sample must show what OK will return, not a hardcoded mono), and the
 * selection round-trips into the caller's LOGFONT. Preselect leg: a
 * CF_INITTOLOGFONTSTRUCT face selects its own row, so an immediate OK
 * returns it unchanged. */
function chooseSession() {
  const lines = [
    'fontramp choose &',
    'wmctl wait win Font 15000',
    'FSID=$(wmctl list | grep "Font$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $FSID 1 8000',
    'echo ==cftree',
    'wmctl tree',
    'echo ==cut',
    'wmctl shot $FSID /root/cf-mono.ppm && echo cfshot0-ok',
    'wmctl click sans',                    // face LISTBOX row (AQM, 0370)
    'wmctl tree > /dev/null',              // paint barrier for the re-font
    'wmctl shot $FSID /root/cf-sans.ppm && echo cfshot1-ok',
    'wmctl click OK',
    'wmctl wait nowin Font 8000',
    'wait',                                // reap: the choose line prints
    'fontramp choose serif &',             // preselect leg
    'wmctl wait win Font 15000',
    'wmctl click OK',
    'wmctl wait nowin Font 8000',
    'wait',
    ''];
  const r = driveBoot(lines.join('\n'), { image, timeout: 240000 });
  const tree = (r.stdout.split('==cftree')[1] || '').split('==cut')[0];
  check('face LISTBOX enumerates the family table (mono/sans/serif rows)',
    /\bmono\b/.test(tree) && /\bsans\b/.test(tree) && /\bserif\b/.test(tree),
    tree.slice(0, 500));
  check('sample shots written', r.stdout.includes('cfshot0-ok') &&
    r.stdout.includes('cfshot1-ok'), r.stdout.slice(-600));
  check('sans selection round-trips into the caller LOGFONT',
    r.stdout.includes('choose: ok=1 face=sans h=-20 pt=150'),
    r.stdout.match(/^choose:.*$/m));
  check('CF_INITTOLOGFONTSTRUCT preselects the incoming face (serif)',
    r.stdout.includes('choose: ok=1 face=serif h=-20 pt=150'),
    (r.stdout.match(/^choose:.*$/mg) || []).join(' | '));
}

function extractSession() {
  const names = SHOTS.map((_, i) => `/root/ramp${i}.ppm`)
    .concat(['/root/cf-mono.ppm', '/root/cf-sans.ppm']);
  const r = driveBoot('cat ' + names.join(' ') + '\n',
    { image, encoding: null, timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  const outDir = path.join(ROOT, 'build/test-kernel/fontramp');
  fs.mkdirSync(outDir, { recursive: true });
  let off = 0;
  const bufs = [];
  for (let i = 0; i < SHOTS.length; i++) {
    let p = null;
    try { p = parsePpm(r.stdout, off); } catch (e) { /* short output */ }
    check(`shot ${SHOTS[i][0]} parses at 640x420`,
      p !== null && p.w === 640 && p.h === 420, p && `${p.w}x${p.h}`);
    if (!p) return;
    const rgb = p.rgb;
    bufs.push(rgb);
    let ink = 0;
    for (let j = 0; j < rgb.length; j += 3) if (rgb[j] !== 255) ink++;
    check(`shot ${SHOTS[i][0]} is inked (glyphs rendered)`, ink > 3000, 'ink=' + ink);
    fs.writeFileSync(path.join(outDir, `fontramp-${SHOTS[i][0]}.png`),
      encodePng(p.w, p.h, rgb));
    off = p.next;
  }
  /* The ChooseFontW sample crops (C2, #282): same dialog, same size,
   * mono-selected vs sans-selected — the SAMPLE box region must differ
   * (the arm cf_accept alone cannot prove: the returned LOGFONT can be
   * right while the sample the user stared at stayed mono). Crop to the
   * sample STATIC (x 8..372, y 272..336 of the 380x380 dialog) so the
   * face-list highlight, which also moved, cannot be what differs. */
  const cfBufs = [];
  for (const label of ['cf-mono', 'cf-sans']) {
    let p = null;
    try { p = parsePpm(r.stdout, off); } catch (e) { /* short output */ }
    check(`shot ${label} parses at 380x380`,
      p !== null && p.w === 380 && p.h === 380, p && `${p.w}x${p.h}`);
    if (!p) return;
    fs.writeFileSync(path.join(outDir, `${label}.png`),
      encodePng(p.w, p.h, p.rgb));
    const crop = Buffer.alloc((372 - 8) * (336 - 272) * 3);
    let ci = 0;
    for (let y = 272; y < 336; y++)
      for (let x = 8; x < 372; x++) {
        const s = (y * p.w + x) * 3;
        crop[ci++] = p.rgb[s];
        crop[ci++] = p.rgb[s + 1];
        crop[ci++] = p.rgb[s + 2];
      }
    let ink = 0;
    for (let j = 0; j < crop.length; j += 3)
      if (crop[j] < 128) ink++;                    /* dark = glyph pixels */
    check(`${label} sample box is inked`, ink > 50, 'ink=' + ink);
    cfBufs.push(crop);
    off = p.next;
  }
  if (cfBufs.length === 2)
    check('ChooseFontW sample re-renders in the selected face (crops differ)',
      !cfBufs[0].equals(cfBufs[1]));

  let allDistinct = true;
  for (let a = 0; a < bufs.length && allDistinct; a++)
    for (let b = a + 1; b < bufs.length; b++)
      if (bufs[a].equals(bufs[b])) {
        allDistinct = false;
        check('shots pairwise distinct', false, `${SHOTS[a][0]} === ${SHOTS[b][0]}`);
        break;
      }
  if (allDistinct) check('shots pairwise distinct (10 faces, 10 renders)', true);
  console.log('  (evidence PNGs in build/test-kernel/fontramp/)');
}

(async () => {
  console.log('C1 multi-face CreateFont e2e (#281)');
  console.log('-- probe session --');
  probeSession();
  console.log('-- synthetic-bold session (inverted fixture) --');
  await synthBoldSession();
  console.log('-- windowed session --');
  windowSession();
  console.log('-- ChooseFontW session (C2 #282) --');
  chooseSession();
  console.log('-- extract session --');
  extractSession();

  console.log(failures ? `FAILED (${failures})` : 'PASS');
  process.exit(failures ? 1 : 0);
})();
