#!/usr/bin/env node
// serve-with-clang.js — the clang-MANDATORY dev server (CLANG-CPP-EPIC Part II
// §6). A hard-fail WRAPPER around serve.js, NOT a fork of it: it performs the
// sibling preflight + the `mkpkg --clang` package prebake, then DELEGATES the
// entire serve to the unmodified serve.js (spawned with stdio inherited). All
// of serve.js's machinery — overlay resolution, the three-axis image-freshness
// gate, mkimage delegation, COOP/COEP + /packages routing — stays in ONE place;
// this file owns only what differs: the failure policy.
//
// The contract that separates this from `serve.js --clang`:
//   serve.js --clang        : the clang image overlay is OPT-IN. A missing
//                             sibling is NORMAL — it silently serves the base
//                             image (serve.js:49). Base gucOS, unaffected.
//   serve-with-clang.js     : the clang toolchain is REQUIRED. A missing or
//                             unbuilt sibling, or a missing overlay artifact, is
//                             a LOUD hard failure (exit 1 + the fix command).
//                             It NEVER falls back to the base image.
//
//   node serve-with-clang.js [dir='build'] [port=8080] [--clang-root=PATH]
//                            [--build-overlay]
//
// --clang-root=PATH  the clang-simplified sibling (default ../clang-simplified,
//                    the same relative convention as os/image.json's overlay
//                    manifest). Drives the preflight and the package prebake.
// --build-overlay    opt-in: run the sibling's overlay producer foreground when
//                    the artifact is absent, instead of failing. Absence is
//                    never SILENTLY healed — you ask for the build explicitly.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = __dirname;
const SERVE = path.join(REPO_ROOT, 'serve.js');
const MKPKG = path.join(REPO_ROOT, 'tools', 'mkpkg.js');

// --- args: consume the wrapper-only flags, forward the rest to serve.js ---
let clangRoot = path.resolve(REPO_ROOT, '..', 'clang-simplified');
let buildOverlay = false;
const forward = [];       // positionals (dir, port) forwarded verbatim to serve.js
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--clang-root=')) clangRoot = path.resolve(a.slice(13));
  else if (a === '--build-overlay') buildOverlay = true;
  else if (a.startsWith('-')) { console.error(`serve-with-clang: unknown option ${a}`); process.exit(2); }
  else forward.push(a);
}

function die(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

// --- preflight (all failures: name the path + the exact fix, then exit 1) ---

// 1. Sibling repo present.
if (!fs.existsSync(clangRoot)) {
  die([
    `serve-with-clang: clang-simplified sibling not found at ${clangRoot}`,
    '  this server REQUIRES the clang toolchain repo (serve.js serves the base image without it)',
    '  fix: clone it next to this repo, or pass --clang-root=PATH',
  ]);
}

// 2. Toolchain built (the native stage0 ELF the sibling's producer needs).
const clangBin = path.join(clangRoot, 'simple1', 'out', 'clang');
if (!fs.existsSync(clangBin)) {
  die([
    `serve-with-clang: clang toolchain not built (${clangBin} missing)`,
    `  fix: cd ${clangRoot} && ./build.sh`,
  ]);
}

// 3. Overlay artifact present + parseable (the published overlay@1 manifest —
//    the single source of every nativeApp payload). --build-overlay may produce
//    it foreground; otherwise absence is fatal (the producer owns its build).
const overlayPath = path.join(clangRoot, 'out-image', 'overlay.json');
const overlayProducer = path.join(clangRoot, 'wasm', 'tools', 'mk-overlay.mjs');
if (!fs.existsSync(overlayPath)) {
  if (buildOverlay) {
    console.log(`[serve-with-clang] overlay artifact absent — building: node ${overlayProducer}`);
    const b = cp.spawnSync(process.execPath, [overlayProducer], { cwd: clangRoot, stdio: 'inherit' });
    if (b.status !== 0) die(['serve-with-clang: overlay producer failed — not serving']);
  } else {
    die([
      `serve-with-clang: sibling overlay artifact not found at ${overlayPath}`,
      `  fix: node ${overlayProducer}   (or pass --build-overlay to run it now)`,
    ]);
  }
}
try {
  JSON.parse(fs.readFileSync(overlayPath, 'utf-8'));
} catch (e) {
  die([
    `serve-with-clang: ${overlayPath} is not valid JSON: ${e.message}`,
    `  fix: re-run node ${overlayProducer}`,
  ]);
}

// 4. Prebake the *-clang packages (foreground; non-zero exit is fatal — the
//    mirror of serve.js's mkimage-failure exit). Output lands in the served
//    tree's dist/packages so serve.js's /packages route finds the superset.
const servedDir = path.resolve(forward[0] || 'build');
const pkgOut = path.join(servedDir, 'dist', 'packages');
console.log('[serve-with-clang] prebaking *-clang packages (mkpkg --clang)…');
const mk = cp.spawnSync(process.execPath,
  [MKPKG, '--no-baseline', `--clang-root=${clangRoot}`, '--clang', `--out=${pkgOut}`],
  { cwd: REPO_ROOT, stdio: 'inherit' });
if (mk.status !== 0) {
  die(['serve-with-clang: mkpkg --clang failed — not serving a clang origin without its packages']);
}

// --- delegate the whole serve to the unmodified serve.js ---
const serveArgs = [SERVE, ...forward, '--clang', '--packages-index=clang'];
console.log(`[serve-with-clang] delegating: serve.js ${forward.join(' ')} --clang --packages-index=clang`);
const child = cp.spawn(process.execPath, serveArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
