'use strict';
// The ONE definition of "which demo pages ship, and what a demo page is".
//
// The demo set is not a list anywhere — it IS the set of directories under
// `pages/`, which is exactly the tree `packages/netsurf-demos.json` ships
// (`{"tree": "vendor/netsurf/demos/pages"}`).  Every gate reads the set from
// here, so adding a folder under pages/ enters every gate at once and cannot
// silently ship untested:
//
//   vendor/netsurf/smoke-js.mjs        the monkey gate — one leg per demo,
//                                      plus a coverage check that every
//                                      demo has a leg
//   tests/kernel/test_netsurf_demos_e2e.js   opens each seeded demo IN THE OS
//   tests/kernel/lib/drive.js          pkgSeedPaths() derives the planted
//                                      /root paths from the package + tree
//
// `checkContract()` is the drift gate proper: it re-derives the set from the
// filesystem and asserts every structural promise the demos make (own folder,
// external stylesheet, external script, listed on the landing page).  A demo
// added without a stylesheet, or added and not linked from index.html, fails
// LOUD rather than shipping half-wired.
const fs = require('fs');
const path = require('path');

const DEMOS_DIR = __dirname;                       // vendor/netsurf/demos
const PAGES_DIR = path.join(DEMOS_DIR, 'pages');   // the shipped tree
const INDEX_HTML = path.join(PAGES_DIR, 'index.html');

/* The load-check pill, as pixels.  Every demo's stylesheet paints
 * #jswatch #c00000 and its script flips it to #008000 (`#jswatch.ran`), so
 * these two predicates ARE "the stylesheet loaded" and "the script ran" for
 * any in-OS screenshot.  The bands are tight on purpose: they must not be
 * satisfiable by any pixel a demo canvas can draw — sketch's patterns
 * always carry b>=64 or g>=48, paint's scene palette and inks keep g>=48
 * where r>150 and r>=40 where g>100 (the rule is stated in paint.js), and
 * plasma clamps every palette entry away from both bands (buildPalette in
 * plasma.js).  Change these together with the CSS and those three files. */
const PILL = {
  isGreen: (r, g, b) => g > 100 && r < 40 && b < 30,
  isRed: (r, g, b) => r > 150 && g < 40 && b < 40,
};

/* ---- interaction truth ------------------------------------------------
 *
 * Each shipped demo declares how to DRIVE it and which pixels must change:
 * "the pill is green" proves the subresources loaded, and only this proves
 * the demo DOES anything.  Coordinates are PAGE pixels calibrated against
 * the 800x600 default netsurf window (deterministic engine + baked fonts,
 * so the layout is stable); the content area starts at the surface origin,
 * so page == surface-client coordinates while the page is unscrolled.
 *
 * A demo's interaction is a list of PHASES.  Each phase runs its `do` steps
 * and then gets exactly one screenshot; `expect` entries compare regions of
 * this phase's shot against earlier phases' shots by name (or state a
 * predicate about this shot alone).  Steps:
 *
 *   {click:[x,y]}  {down:[x,y]}  {move:[x,y]}  {up:[x,y]}   pointer, page px
 *   {type:"text"}                     keystrokes to the focused element
 *   {settle:ms, why:"..."}            fixed wait — ONLY for timer-driven
 *                                     content (the annotation is mandatory:
 *                                     the no-fixed-sleep rule allows a
 *                                     genuine no-marker settle only)
 *
 * Expect predicates (region = [x,y,w,h] page px):
 *
 *   {region, changedFrom:'phase'}     >= minDiff pixels differ (default 20)
 *   {region, sameAs:'phase'}          <= sameTol pixels differ (default 0)
 *   {region, ink:true}                some pixel is dark (text/ink present)
 *   {region, color:[r,g,b], tol}      some pixel within tol of color
 *   {region, allColor:[r,g,b], tol}   every pixel within tol of color
 *
 * The kernel e2e drives these as wmctl client-coordinate injections; the
 * browser rig drives them as real Chromium input.  One table, two drivers.
 */
const INTERACTIONS = {
  'hello-js': { phases: [
    /* No input surface at all — the interaction truth is that the script's
     * parse-time document.write PAINTED: the #out box holds real text. */
    { name: 'load', do: [], expect: [{ region: [26, 160, 748, 95], ink: true }] },
  ] },
  counter: { phases: [
    { name: 'load', do: [] },
    /* Two Add-one clicks: 0 -> 2 in the readonly value box. */
    { name: 'inc', do: [{ click: [170, 118] }, { click: [170, 118] }],
      expect: [{ region: [26, 104, 90, 30], changedFrom: 'load' }] },
    /* Reset: back to 0 — and the box renders EXACTLY as it did at load. */
    { name: 'reset', do: [{ click: [380, 118] }],
      expect: [{ region: [26, 104, 90, 30], changedFrom: 'inc' },
               { region: [26, 104, 90, 30], sameAs: 'load' }] },
  ] },
  events: { phases: [
    { name: 'load', do: [] },
    /* Click the inner box: capture+target+bubble trail lands in the order
     * readout. */
    { name: 'clicks', do: [{ click: [167, 195] }],
      expect: [{ region: [26, 267, 438, 25], changedFrom: 'load' }] },
    /* Focus the text input and type: keydown/keyup/input land in the keys
     * readout, and the typed glyphs land in the input itself. */
    { name: 'typing', do: [{ click: [92, 325] }, { type: 'hi' }],
      expect: [{ region: [26, 363, 438, 25], changedFrom: 'clicks' },
               { region: [26, 313, 133, 25], changedFrom: 'clicks' }] },
    /* Toggle the checkbox: the mark is drawn (a small glyph — lower the
     * pixel floor), change:check is recorded. */
    { name: 'check', do: [{ click: [171, 319] }],
      expect: [{ region: [161, 309, 20, 20], changedFrom: 'typing', minDiff: 6 },
               { region: [26, 363, 438, 25], changedFrom: 'typing' }] },
    /* Submit: the cancelable handler appends "submit" and preventDefault()
     * stops the navigation — a reload would have RESET both readouts to
     * their load state, so "still changed from load" is the no-reload
     * proof. */
    { name: 'submit', do: [{ click: [220, 326] }],
      expect: [{ region: [26, 363, 438, 25], changedFrom: 'check' },
               { region: [26, 267, 438, 25], changedFrom: 'load' }] },
  ] },
  paint: { phases: [
    /* The pad opens with the generated sunset scene — assert three of its
     * landmarks, so "there is a picture at load" is pixels, not prose. */
    { name: 'load', do: [],
      expect: [{ region: [332, 212, 40, 40], color: [255, 236, 176], tol: 12 },
               { region: [0, 0, 512, 8], color: [22, 26, 74], tol: 10 },
               { region: [0, 468, 40, 40], allColor: [10, 12, 26], tol: 6 }] },
    /* A click stamps a splat, and a real multi-point drag paints a
     * continuous stroke: down inside the pad, held motion, up. */
    { name: 'stroke', do: [
        { down: [120, 390] }, { move: [180, 400] }, { move: [240, 408] },
        { move: [300, 404] }, { up: [340, 398] }],
      expect: [{ region: [80, 355, 290, 70], changedFrom: 'load' },
               { region: [527, 166, 200, 20], changedFrom: 'load' }] },
    /* Switch ink to Sky and stroke across the sky: blue paint appears. */
    { name: 'sky', do: [
        { click: [604, 95] },
        { down: [60, 60] }, { move: [110, 70] }, { move: [160, 80] },
        { up: [200, 86] }],
      expect: [{ region: [40, 40, 180, 60], color: [32, 96, 200], tol: 40 }] },
    /* Clear: the pad is pure white and the readout says so. */
    { name: 'clear', do: [{ click: [733, 95] }],
      expect: [{ region: [0, 0, 512, 512], allColor: [255, 255, 255], tol: 8 },
               { region: [527, 166, 200, 20], changedFrom: 'sky' }] },
    /* Scene repaints the SAME deterministic picture (drawScene reseeds its
     * LCG), so the pad must match the load shot byte for byte. */
    { name: 'scene', do: [{ click: [560, 127] }],
      expect: [{ region: [0, 0, 512, 512], sameAs: 'load' }] },
  ] },
  plasma: { phases: [
    /* The ember palette's troughs are near-black, so "the plasma painted"
     * is a dark pixel inside the canvas. */
    { name: 'load', do: [],
      expect: [{ region: [24, 102, 322, 202], ink: true }] },
    /* Animating from setInterval alone — the settle IS the subject. */
    { name: 'tick', do: [{ settle: 600, why: 'the setInterval plasma repaint is the subject' }],
      expect: [{ region: [24, 102, 322, 202], changedFrom: 'load' },
               { region: [208, 324, 105, 22], changedFrom: 'load' }] },
    { name: 'freeze', do: [{ click: [156, 336] }] },
    /* Stopped: the canvas holds byte-identical across another interval. */
    { name: 'frozen', do: [{ settle: 600, why: 'proving the STOPPED timer paints nothing' }],
      expect: [{ region: [24, 102, 322, 202], sameAs: 'freeze' }] },
    /* Palette switch repaints once even while stopped. */
    { name: 'palette', do: [{ click: [65, 336] }],
      expect: [{ region: [24, 102, 322, 202], changedFrom: 'frozen' }] },
  ] },
  sketch: { phases: [
    { name: 'load', do: [] },
    /* The canvas animates from setInterval alone — timer-driven repaint is
     * the subject, so the settle IS the thing under test. */
    { name: 'tick', do: [{ settle: 600, why: 'the 200ms setInterval repaint is the subject' }],
      expect: [{ region: [24, 102, 258, 194], changedFrom: 'load' },
               { region: [252, 316, 86, 22], changedFrom: 'load' }] },
    { name: 'freeze', do: [{ click: [198, 328] }] },
    /* Stopped: the canvas holds byte-identical across another interval. */
    { name: 'frozen', do: [{ settle: 600, why: 'proving the STOPPED timer paints nothing' }],
      expect: [{ region: [24, 102, 258, 194], sameAs: 'freeze' }] },
    /* Next pattern repaints once even while stopped. */
    { name: 'next', do: [{ click: [87, 328] }],
      expect: [{ region: [24, 102, 258, 194], changedFrom: 'frozen' }] },
  ] },
  stopwatch: { phases: [
    { name: 'load', do: [] },
    /* Running since load: the plain-div readout advances — the Lane B
     * mutation bridge under a timer. */
    { name: 'tick', do: [{ settle: 700, why: 'the 100ms setInterval textContent rewrite is the subject' }],
      expect: [{ region: [24, 100, 140, 55], changedFrom: 'load' }] },
    { name: 'stop', do: [{ click: [62, 222] }],
      expect: [{ region: [24, 165, 120, 25], changedFrom: 'tick' }] },
    /* Lap inserts a real <li>; Reset removes it and the list renders as it
     * did before the lap. */
    { name: 'lap', do: [{ click: [136, 222] }],
      expect: [{ region: [24, 248, 400, 45], changedFrom: 'stop' }] },
    { name: 'zero', do: [{ click: [213, 222] }],
      expect: [{ region: [24, 248, 400, 45], sameAs: 'stop' }] },
  ] },
  todo: { phases: [
    { name: 'load', do: [] },
    /* Type a task and Add it: insertion + the class-flipping counter.  The
     * band covers list + counter — the counter MOVES as the list grows, so
     * precise per-element regions would chase layout; the band asserts the
     * mutation painted. */
    { name: 'add', do: [{ click: [150, 116] }, { type: 'wash' }, { click: [311, 115] }],
      expect: [{ region: [24, 140, 600, 140], changedFrom: 'load' }] },
    /* Remove the first seeded row via its own Done button. */
    { name: 'remove', do: [{ click: [303, 163] }],
      expect: [{ region: [24, 140, 600, 140], changedFrom: 'add' }] },
  ] },
};

/* Evaluate one expect entry against this phase's shot (and the earlier
 * shots it names).  A shot is { w, h, rgb } — packed RGB over the SURFACE
 * (page pixel (x,y) at rgb[(y*w+x)*3]).  Returns null on pass, else a
 * human-readable failure string.  Pure, so both drivers and any unit test
 * share the one implementation. */
function evalExpect(e, shot, shotsByPhase) {
  const [rx, ry, rw, rh] = e.region;
  const px = (s, x, y) => [(s.rgb[(y * s.w + x) * 3]), (s.rgb[(y * s.w + x) * 3 + 1]), (s.rgb[(y * s.w + x) * 3 + 2])];
  const clampW = Math.min(rx + rw, shot.w), clampH = Math.min(ry + rh, shot.h);
  if (e.changedFrom !== undefined || e.sameAs !== undefined) {
    const other = shotsByPhase[e.changedFrom !== undefined ? e.changedFrom : e.sameAs];
    if (!other) return `no shot for phase "${e.changedFrom || e.sameAs}"`;
    let diff = 0;
    for (let y = ry; y < clampH; y++)
      for (let x = rx; x < clampW; x++) {
        const a = px(shot, x, y), b = px(other, x, y);
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) diff++;
      }
    if (e.changedFrom !== undefined) {
      const min = e.minDiff !== undefined ? e.minDiff : 20;
      return diff >= min ? null :
        `region ${JSON.stringify(e.region)} changed only ${diff} px vs "${e.changedFrom}" (need >= ${min})`;
    }
    const tol = e.sameTol !== undefined ? e.sameTol : 0;
    return diff <= tol ? null :
      `region ${JSON.stringify(e.region)} differs by ${diff} px from "${e.sameAs}" (allowed ${tol})`;
  }
  if (e.ink) {
    for (let y = ry; y < clampH; y++)
      for (let x = rx; x < clampW; x++) {
        const [r, g, b] = px(shot, x, y);
        if (r < 100 && g < 100 && b < 100) return null;
      }
    return `region ${JSON.stringify(e.region)} has no ink (no dark pixel)`;
  }
  if (e.color) {
    const tol = e.tol !== undefined ? e.tol : 12;
    for (let y = ry; y < clampH; y++)
      for (let x = rx; x < clampW; x++) {
        const p = px(shot, x, y);
        if (p.every((v, i) => Math.abs(v - e.color[i]) <= tol)) return null;
      }
    return `region ${JSON.stringify(e.region)} has no pixel near ${JSON.stringify(e.color)}`;
  }
  if (e.allColor) {
    const tol = e.tol !== undefined ? e.tol : 8;
    for (let y = ry; y < clampH; y++)
      for (let x = rx; x < clampW; x++) {
        const p = px(shot, x, y);
        if (!p.every((v, i) => Math.abs(v - e.allColor[i]) <= tol))
          return `region ${JSON.stringify(e.region)} pixel (${x},${y}) is ${JSON.stringify(p)}, want ~${JSON.stringify(e.allColor)}`;
      }
    return null;
  }
  return 'expect entry with no predicate: ' + JSON.stringify(e);
}

/* The shipped demo folders, sorted — the single source of truth. */
function demoNames() {
  return fs.readdirSync(PAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/* One demo: where its files are, and the subresources its page pulls in. */
function demo(name) {
  const dir = path.join(PAGES_DIR, name);
  const html = path.join(dir, 'index.html');
  const src = fs.existsSync(html) ? fs.readFileSync(html, 'utf8') : '';
  const attr = (re) => [...src.matchAll(re)].map((m) => m[1]);
  return {
    name,
    dir,
    html,
    rel: name + '/index.html',                       // relative to pages/
    title: (src.match(/<title>([^<]*)<\/title>/) || [, ''])[1],
    styles: attr(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g),
    scripts: attr(/<script[^>]+src="([^"]+)"/g),
  };
}
function demos() { return demoNames().map(demo); }

/* Every file one demo folder is made of, as {rel, abs}, sorted — for tests
 * that plant a demo into an image themselves rather than opening the seeded
 * copy.  A demo is a FOLDER now, so planting just its .html would silently
 * strip the stylesheet and the script. */
function demoFiles(name) {
  const dir = path.join(PAGES_DIR, name);
  return fs.readdirSync(dir).sort()
    .filter((n) => n.charAt(0) !== '.')
    .map((n) => ({ rel: n, abs: path.join(dir, n) }));
}

/* The links the landing page offers, in document order. */
function indexLinks() {
  const src = fs.readFileSync(INDEX_HTML, 'utf8');
  return [...src.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
}

/* The drift gate.  Returns a list of problems; empty = the tree keeps every
 * promise the demos are shipped on.  Callers assert it is empty. */
function contractProblems() {
  const problems = [];
  const names = demoNames();
  if (names.length === 0) problems.push('pages/ holds no demo folders at all');

  for (const d of demos()) {
    if (!fs.existsSync(d.html)) {
      problems.push(`${d.name}/: no index.html`);
      continue;
    }
    if (d.styles.length === 0) {
      problems.push(`${d.name}/index.html: no <link rel="stylesheet"> — every demo must load an EXTERNAL stylesheet`);
    }
    if (d.scripts.length === 0) {
      problems.push(`${d.name}/index.html: no <script src=> — every demo must load an EXTERNAL script`);
    }
    /* Self-contained folder: a demo must not reach outside its own dir, so
     * a copy of the folder alone still works. */
    for (const r of d.styles.concat(d.scripts)) {
      if (r.startsWith('/') || r.startsWith('..') || /^[a-z]+:/i.test(r)) {
        problems.push(`${d.name}/index.html: subresource "${r}" is not folder-local`);
      } else if (!fs.existsSync(path.join(d.dir, r))) {
        problems.push(`${d.name}/index.html: subresource "${r}" does not exist`);
      }
    }
    /* The load-check pill is the demos' own self-report (see README): both
     * halves must be present or the page cannot say whether its
     * subresources arrived. */
    const src = fs.readFileSync(d.html, 'utf8');
    if (!src.includes('id="nocss"') || !src.includes('id="jswatch"')) {
      problems.push(`${d.name}/index.html: missing the id="nocss"/id="jswatch" load-check pill`);
    }
  }

  /* Interaction truth is part of the contract: a demo shipped without a
   * declared interaction would regress the suite back to "the pill is
   * green" — exactly the gap the netsurf-bughunt lane closed. */
  for (const n of names) {
    const ia = INTERACTIONS[n];
    if (!ia || !Array.isArray(ia.phases) || ia.phases.length === 0) {
      problems.push(`${n}/: no INTERACTIONS entry — every demo must declare how it is driven and what pixels change`);
    } else if (!ia.phases.some((p) => (p.expect || []).length > 0)) {
      problems.push(`${n}/: INTERACTIONS has no expect at all — it asserts nothing`);
    }
  }
  for (const n of Object.keys(INTERACTIONS)) {
    if (!names.includes(n)) problems.push(`INTERACTIONS names "${n}", which is not a shipped demo`);
  }

  /* The landing page is a hand-written list; hold it to the derived set. */
  const linked = indexLinks().filter((h) => h.endsWith('/index.html')).sort();
  const want = names.map((n) => n + '/index.html');
  if (JSON.stringify(linked) !== JSON.stringify(want)) {
    problems.push('pages/index.html links ' + JSON.stringify(linked) +
      ' but the shipped demo set is ' + JSON.stringify(want));
  }
  return problems;
}

/* Throwing wrapper for the gates. */
function checkContract() {
  const problems = contractProblems();
  if (problems.length) {
    throw new Error('the netsurf demo tree broke its contract:\n  - ' +
      problems.join('\n  - '));
  }
  return demoNames();
}

module.exports = { DEMOS_DIR, PAGES_DIR, INDEX_HTML, PILL,
                   INTERACTIONS, evalExpect,
                   demoNames, demo, demos, demoFiles, indexLinks,
                   contractProblems, checkContract };
