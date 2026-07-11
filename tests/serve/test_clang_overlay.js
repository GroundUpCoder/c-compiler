// serve.js --clang overlay on-ramp (todos/0141). `--clang` folds the sibling
// clang-simplified `clang-apps` image overlay (todos/0118) into the served
// system blob WHEN the sibling artifact is available, and serves the resulting
// sidecar for the `os-system.img` fetch the browser makes. When the sibling
// build is absent it must serve the BASE image and exit 0 (a missing sibling is
// a normal, opt-in-not-satisfied state — never an error).
//
// This test is hermetic and fast: it runs serve.js against a SYNTHETIC tree
// with an os/image.json but NO tools/mkimage.js, so ensureSystemImage
// early-returns (no ~90s bake, no host.js/compiler dependency) — it exercises
// the FLAG PARSING, the availability resolution + loud logging, and the request
// swap that maps `/os/os-system.img` onto the overlay sidecar. The real
// end-to-end (a browser boot finding /usr/bin/doom-clang) is an operator-owed
// browser leg (0064), like every windowed-app acceptance.
//
// Run: node tests/serve/test_clang_overlay.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SERVE = path.join(ROOT, 'serve.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Build a throwaway served tree. `siblingPresent` controls whether the overlay
// manifest the image.json points at actually exists. No tools/mkimage.js is
// planted, so serve.js's freshness gate early-returns without baking.
function makeTree(siblingPresent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-clang-'));
  fs.mkdirSync(path.join(dir, 'os'));
  fs.writeFileSync(path.join(dir, 'os', 'os.html'), '<!doctype html>ok');
  // The sibling overlay artifact + its manifest reference.
  const sibDir = path.join(dir, 'sibling');
  fs.mkdirSync(sibDir);
  const ovManifest = path.join(sibDir, 'overlay.json');
  if (siblingPresent) {
    fs.writeFileSync(ovManifest, JSON.stringify({
      schema: 'overlay@1', id: 'clang-apps',
      provenance: { producer: 'clang-simplified', repo: { commitShort: 'deadbee', dirty: true } },
      files: {},
    }));
    // The sidecar the --clang serve is expected to publish at os-system.img.
    fs.writeFileSync(path.join(dir, 'os', 'os-system.clang-apps.img'), 'SIDECAR-OVERLAY-BYTES');
  }
  // Base image (what a plain / sibling-absent serve publishes).
  fs.writeFileSync(path.join(dir, 'os', 'os-system.img'), 'BASE-IMAGE-BYTES');
  fs.writeFileSync(path.join(dir, 'os', 'image.json'), JSON.stringify({
    version: 1,
    overlays: [{ id: 'clang-apps', manifest: 'sibling/overlay.json' }],
  }));
  return dir;
}

// Spawn serve.js on the tree; resolve once it prints its URL (or reject on
// early exit — the sibling-absent path MUST still start listening, not die).
function start(dir, extraArgs) {
  const child = cp.spawn('node', [SERVE, dir, '0', ...extraArgs],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('no URL within 5s; out: ' + out)), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/https?:\/\/\S+/);
      if (m) { clearTimeout(timer); resolve({ child, url: m[0], out: () => out }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('serve exited early (' + code + '); out: ' + out)); });
  });
}

async function main() {
  // --- 1. sibling PRESENT: overlay folded in, sidecar served for os-system.img
  {
    const dir = makeTree(true);
    const { child, url, out } = await start(dir, ['--clang']);
    try {
      check('present: logs the "folded in" line',
        /overlay clang-apps folded in \(clang-simplified@deadbee\)/.test(out()), out());
      const base = url.replace(/\/os\/os\.html$/, '');
      const r = await fetch(base + '/os/os-system.img');
      const body = await r.text();
      check('present: /os/os-system.img serves the overlay SIDECAR bytes',
        body === 'SIDECAR-OVERLAY-BYTES', JSON.stringify(body));
    } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // --- 2. sibling ABSENT: base image served, loud not-found line, exit 0
  {
    const dir = makeTree(false);
    const { child, url, out } = await start(dir, ['--clang']);
    try {
      check('absent: logs the not-found/serving-base line',
        /--clang requested but sibling\/overlay\.json not found — serving base image/.test(out()), out());
      const base = url.replace(/\/os\/os\.html$/, '');
      const r = await fetch(base + '/os/os-system.img');
      const body = await r.text();
      check('absent: /os/os-system.img serves the BASE bytes', body === 'BASE-IMAGE-BYTES', JSON.stringify(body));
    } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // --- 3. no flag: base served, no overlay logging, no sidecar swap
  {
    const dir = makeTree(true);   // sidecar exists but must NOT be served without --clang
    const { child, url, out } = await start(dir, []);
    try {
      check('plain: no overlay logging', !/folded in|serving base image/.test(out()), out());
      const base = url.replace(/\/os\/os\.html$/, '');
      const r = await fetch(base + '/os/os-system.img');
      const body = await r.text();
      check('plain: /os/os-system.img serves the BASE bytes', body === 'BASE-IMAGE-BYTES', JSON.stringify(body));
    } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
