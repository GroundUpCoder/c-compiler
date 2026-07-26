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
 * satisfiable by any pixel the sketch demo's canvas can draw (its patterns
 * always carry b>=64 or g>=48).  Change these together with the CSS. */
const PILL = {
  isGreen: (r, g, b) => g > 100 && r < 40 && b < 30,
  isRed: (r, g, b) => r > 150 && g < 40 && b < 40,
};

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
                   demoNames, demo, demos, demoFiles, indexLinks,
                   contractProblems, checkContract };
