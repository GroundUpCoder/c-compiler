#!/usr/bin/env node
// The `netsurf-demos` package, IN THE OS — the gucman `seed` content
// resource kind's first consumer (design §7 stage 5).
//
// Two things are proved here, and nothing in this file lists a demo:
//
//   1. THE SEED LANDED.  A fresh boot of the fat image carries every file
//      the package declares, byte for byte, under
//      /root/Desktop/Presentations/samples/Web Demos/ — additively, so the
//      sample that already lived in samples/ survives — and the Desktop's
//      OWN icon set is unchanged (the seed nests, so it must not shift the
//      icon grid).  The expected set is DERIVED by drive.js's
//      pkgSeedPlants() from packages/netsurf-demos.json + os-common's own
//      tree enumeration; a hardcoded list here would be a second source of
//      truth and would drift the first time a demo is added.
//
//   2. EVERY SHIPPED DEMO ACTUALLY RUNS.  Each one is opened from its
//      SEEDED copy in a real /bin/netsurf window and its own load-check
//      pill is read off the pixels: the pill is coloured by the demo's
//      EXTERNAL stylesheet and turned from red to green by the demo's
//      EXTERNAL script, so a green pill means both subresources were
//      fetched next to the page and both took effect.  "The file is
//      present" is not the assertion; "the page works" is.
//
// Two negative controls keep leg 2 honest — a copy with its script removed
// must go RED, and a copy with its stylesheet removed must lose both
// colours.  Without them a green count could be measuring anything.
//
// The pill colours (#c00000 / #008000) are chosen disjoint from every pixel
// the sketch demo's canvas can produce, which is why counting them over the
// WHOLE content area is safe; the demo stylesheets carry the same note.
//
// Run: node tests/kernel/test_netsurf_demos_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, deskEntries, pkgSeedPlants } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const NSDEMOS = require(path.join(ROOT, 'vendor/netsurf/demos/demos.js'));

/* must match gucos/gui.c STATUS_H */
const STATUS_H = 18;
/* where the package seeds itself — the ONE spelling, read from the package */
const PKG = 'netsurf-demos';
const SEED_DEST = Object.keys(JSON.parse(fs.readFileSync(
  path.join(ROOT, 'packages', PKG + '.json'), 'utf8')).seed)[0];
const BASE = '/root/' + SEED_DEST;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- leg 0: the demo tree keeps its contract ---- */
console.log('\nleg 0 — the shipped demo tree');
{
  const problems = NSDEMOS.contractProblems();
  check('every shipped demo has its own folder, stylesheet and script',
        problems.length === 0, problems.join(' | '));
}
const DEMOS = NSDEMOS.demos();
check('the package ships at least one demo', DEMOS.length > 0);

/* ---- boot a fresh fat image ---- */
const { dir: tmp, image } = freshImage('os-nsdemos-');
const plants = pkgSeedPlants(PKG);

/* The negative controls are built IN the image from the seeded copies, so
 * they are the same bytes the product ships — a hand-written broken page
 * would prove nothing about these files. */
const BROKEN_JS = '/root/nojs';
const BROKEN_CSS = '/root/nocss';
const probe = DEMOS[0];   // any demo; the set is derived, so index 0 is fine

const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;
/* No settle poll: /bin/netsurf sets the window title from the page's own
 * <title>, which it only knows once the document is parsed and its scripts
 * have run — so the title barrier IS the "this page is up" marker, and the
 * frame behind it is already painted.  (Verified: shots taken immediately
 * after the barrier and a second later are identical.)  A page that never
 * comes up fails the wait LOUDLY instead of being napped past. */
function openShoot(demoDir, title, tag) {
  return [
    `netsurf "${demoDir}/index.html" &`,
    /* titles are quoted: "Hello JavaScript" has a space in it, and an
     * unquoted one makes wmctl wait on the empty string — which times out
     * at 0ms and, before driveBoot's loud-symptom gate, would have sailed
     * straight past an unopened window */
    `wmctl wait win "${title}" 60000`,
    sidOf('S', title),
    `wmctl shot $S /root/${tag}.ppm && echo shot-${tag}-ok`,
    `wmctl close $S && wmctl wait nowin "${title}" 8000 && echo closed-${tag}`,
  ];
}

const script = [
  /* the additively-merged neighbour, and the Desktop's own entries */
  'echo ==samples',
  `ls "${path.posix.dirname(BASE)}"`,
  'echo ==desktop',
  'ls /root/Desktop',
  'echo ==run',
  /* the negative controls, cut from the shipped copies */
  `cp -r "${BASE}/${probe.name}" ${BROKEN_JS}`,
  `rm ${BROKEN_JS}/${probe.scripts[0]}`,
  `cp -r "${BASE}/${probe.name}" ${BROKEN_CSS}`,
  `rm ${BROKEN_CSS}/${probe.styles[0]}`,
];
for (const d of DEMOS) script.push(...openShoot(`${BASE}/${d.name}`, d.title, 'd-' + d.name));
script.push(...openShoot(BROKEN_JS, probe.title, 'nojs'));
script.push(...openShoot(BROKEN_CSS, probe.title, 'nocss'));

const r = driveBoot(script, { image, timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
const out = r.stdout;
const sect = (n) => {
  const p = out.split('==' + n + '\n');
  return p.length > 1 ? p[1].split('==')[0] : '';
};

/* ---- leg 1: the seed landed, byte for byte ---- */
console.log('\nleg 1 — the seed landed on a fresh boot');
{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const store = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(store);
  const readAll = (p) => {
    const st = rfs.stat(p);
    if (st === null) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    const fd = rfs.open(p, 0, 0);
    if (fd === null) return null;
    for (;;) {
      const n = rfs.read(fd, buf.subarray(off), buf.length - off);
      if (n === null || n === 0) break;
      off += n;
      if (off >= buf.length) break;
    }
    rfs.close(fd);
    return off === buf.length ? buf : null;
  };

  let missingDirs = [], missingFiles = [], differing = [];
  for (const d of plants.dirs) {
    const st = rfs.stat(d);
    if (st === null || (st.mode & 0o170000) !== 0o040000) missingDirs.push(d);
  }
  /* every seeded file maps back to exactly one repo file — reverse the
   * derivation instead of re-listing it */
  for (const f of plants.files) {
    const rel = f.slice(BASE.length + 1);
    const src = path.join(NSDEMOS.PAGES_DIR, rel);
    const got = readAll(f);
    if (got === null) missingFiles.push(f);
    else if (!got.equals(fs.readFileSync(src))) differing.push(f);
  }
  check(`all ${plants.dirs.length} seeded directories exist`,
        missingDirs.length === 0, missingDirs.join(', '));
  check(`all ${plants.files.length} seeded files exist`,
        missingFiles.length === 0, missingFiles.join(', '));
  check('every seeded file is byte-identical to the shipped source',
        differing.length === 0, differing.join(', '));
  store.close();
}
{
  /* the merge is ADDITIVE: image.json's own sample in samples/ survives */
  const samples = sect('samples').trim().split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const leaf = path.posix.basename(BASE);
  check('the seeded folder appears in samples/', samples.includes(leaf),
        `samples/ holds: ${JSON.stringify(samples)}`);
  check('the sample that was already there survived the merge',
        samples.length > 1, `samples/ holds only: ${JSON.stringify(samples)}`);

  /* NESTED, so the Desktop icon grid must be untouched — derived from
   * image.json + wm.c's Recycle Bin, never a count */
  const got = sect('desktop').trim().split('\n').map((s) => s.trim()).filter(Boolean).sort();
  const want = deskEntries().slice().sort();
  check('the Desktop\'s own entries are unchanged by the seed',
        JSON.stringify(got) === JSON.stringify(want),
        `got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

/* ---- leg 2: every demo runs, from its seeded copy ---- */
console.log('\nleg 2 — every seeded demo runs in a real netsurf window');
const TAGS = DEMOS.map((d) => 'd-' + d.name).concat(['nojs', 'nocss']);
for (const t of TAGS) {
  check(`${t}: the window came up and was shot`, out.includes(`shot-${t}-ok`));
  check(`${t}: the window closed cleanly`, out.includes(`closed-${t}`));
}

const back = driveBoot('cat ' + TAGS.map((t) => `/root/${t}.ppm`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 256 * 1024 * 1024 });
const shots = {};
{
  let off = 0;
  for (const t of TAGS) {
    const head = back.stdout.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) throw new Error('bad ppm stream at ' + t + ': ' + JSON.stringify(head));
    const w = +m[1], h = +m[2];
    const data = off + m[0].length;
    shots[t] = { w, h, data: back.stdout.slice(data, data + w * h * 3) };
    off = data + w * h * 3;
  }
}
/* The pill's two states — the predicates live next to the CSS they read
 * (demos.js), so a colour retune cannot drift from the tests. */
const { isGreen: isPillGreen, isRed: isPillRed } = NSDEMOS.PILL;
function pill(s) {
  let green = 0, red = 0;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 3;
      const r = s.data[i], g = s.data[i + 1], b = s.data[i + 2];
      if (isPillGreen(r, g, b)) green++;
      if (isPillRed(r, g, b)) red++;
    }
  }
  return { green, red };
}
/* The controls first: they are what make the per-demo threshold mean
 * something.  Calibrate against the control rather than a magic number. */
const nojs = pill(shots.nojs);
const nocss = pill(shots.nocss);
check('CONTROL: with its script removed the pill stays RED',
      nojs.red > 300 && nojs.green === 0, `green=${nojs.green} red=${nojs.red}`);
check('CONTROL: with its stylesheet removed the pill has NO colour at all',
      nocss.red === 0 && nocss.green === 0, `green=${nocss.green} red=${nocss.red}`);

for (const d of DEMOS) {
  const p = pill(shots['d-' + d.name]);
  check(`${d.name}: its EXTERNAL stylesheet and EXTERNAL script both loaded and took effect`,
        p.green > 300 && p.red === 0,
        `green=${p.green} red=${p.red} (red control had red=${nojs.red})`);
}

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf-demos e2e checks passed');
