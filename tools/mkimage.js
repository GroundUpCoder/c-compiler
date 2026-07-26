#!/usr/bin/env node
// tools/mkimage.js — bake the read-only system image offline (todos/0040).
//
// Runs the same seed pipeline the OS boots with (os/os-common.js) against a
// fresh image file: every binary compiled by this repo's own cc, vendor
// bin.json projects built, /usr/share defaults planted, /usr/local ->
// /var/local, /usr/share/os-release carrying the manifest version — then
// the blob is SEALED (superblock content hash; tests/blockfs/fsck_v4.js
// verifies it). The output is a plain BlockFS v4 image whose root is the
// /usr subtree; embedders mount it read-only at /usr.
//
//   node tools/mkimage.js                      # -> os/os-system.img
//   node tools/mkimage.js --out=PATH [--manifest=os/image.json] [--quiet]
//
// Optional opt-in image overlays (todos/0118): fold a sibling-published,
// prebuilt `overlay@1` manifest's files into the image. OFF by default —
// a plain bake is byte-identical to today. Loud failure on any problem.
//   --overlay=<id>            enable one declared overlay (repeatable)
//   --overlays=all            enable every declared overlay
//   --require-clean-overlays  a dirty overlay provenance is fatal (else warns)
//
// Optional packages (gucman): a plain bake is the MINIMAL image — apps
// pulled out into packages/<name>.json are ABSENT (installable at runtime
// by /bin/gucman). Fixture/dev bakes fold them back in so the existing test
// estate sees the same /usr it always did; the folded set is recorded in
// os-release as PACKAGES= (os-common.bakedPackages — the identity axis
// freshness gates compare, since a fat and a minimal blob share a version).
//   --packages=all            fold every packages/<name>.json into the bake
//   --packages=a,b            fold specific packages
//
// os/boot.js bakes the same blob on demand (missing/stale image), so this
// tool is optional for the headless dev loop; it exists to prebake the blob
// the browser boot fetches (no compilation on the boot path) and to bake
// upgrade/test fixtures.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OS_DIR = path.join(ROOT, 'os');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(OS_DIR, 'os-common.js'));

let outPath = path.join(OS_DIR, 'os-system.img');
let manifestPath = path.join(OS_DIR, 'image.json');
let quiet = false;
let requireCleanOverlays = false;
let allOverlays = false;
let packagesWant = [];   // [] = minimal bake; 'all' | names = fold back in
let packagesDir = null;  // --packages-dir=DIR: read definitions from DIR
const requestedOverlays = new Set();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--out=')) outPath = path.resolve(a.slice(6));
  else if (a.startsWith('--manifest=')) manifestPath = path.resolve(a.slice(11));
  else if (a === '--quiet') quiet = true;
  else if (a === '--overlays=all') allOverlays = true;
  else if (a.startsWith('--overlay=')) requestedOverlays.add(a.slice(10));
  else if (a.startsWith('--overlays=')) a.slice(11).split(',').forEach((id) => id && requestedOverlays.add(id));
  else if (a === '--require-clean-overlays') requireCleanOverlays = true;
  else if (a === '--packages=all') packagesWant = 'all';
  else if (a.startsWith('--packages-dir=')) packagesDir = path.resolve(a.slice(15));
  else if (a.startsWith('--packages='))
    packagesWant = a.slice(11) === 'none' ? [] : a.slice(11).split(',').filter(Boolean);
  else {
    process.stderr.write(`mkimage: unknown option ${a}\n`);
    process.exit(2);
  }
}
const log = quiet ? () => {} : (m) => process.stderr.write('[mkimage] ' + m + '\n');
const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

// Fold requested packages back into the bake (gucman fixture mode). An
// unknown name is a usage error, BEFORE any bake.
let manifest, foldedPackages;
try {
  const folded = COMMON.foldPackages(fs, path, ROOT, rawManifest, packagesWant,
    { packagesDir });
  manifest = folded.manifest;
  foldedPackages = folded.names;
} catch (e) {
  process.stderr.write(`mkimage: ${e.message}\n`);
  process.exit(2);
}
if (foldedPackages.length) log('folding packages: ' + foldedPackages.join(', '));

// Resolve requested overlays against image.json `overlays[]`. An unknown id is
// a usage error (exit 2), BEFORE any bake — the whole point is an explicit,
// acknowledged opt-in (todos/0118). The manifest `manifest` field is relative
// to the repo root (absolute also allowed).
const resolvedOverlays = resolveRequestedOverlays();
function resolveRequestedOverlays() {
  const declared = manifest.overlays || [];
  const byId = new Map(declared.map((o) => [o.id, o]));
  const ids = allOverlays ? declared.map((o) => o.id) : [...requestedOverlays];
  for (const id of ids) {
    if (!byId.has(id)) {
      process.stderr.write(`mkimage: unknown overlay '${id}' (declared: ${declared.map((o) => o.id).join(', ') || 'none'})\n`);
      process.exit(2);
    }
  }
  return ids.map((id) => {
    const o = byId.get(id);
    return { id, manifestPath: path.isAbsolute(o.manifest) ? o.manifest : path.join(ROOT, o.manifest) };
  });
}

// Bake into a temp file and publish with an atomic rename: a concurrent
// reader (the 0082 fixture copy in os/boot.js, a browser fetch through
// serve.js) sees either the old blob or the new one, never a half-bake.
const tmpPath = outPath + '.tmp-' + process.pid;

async function main() {
  // The published blob's mtime is the bake START time (todos/0082): an
  // input edited during the bake may or may not be reflected, so the
  // freshness gate must read it as newer than the blob.
  const bakeStart = new Date();
  const store = new COMMON.NodeFileStore(fs, tmpPath, true /* fresh */);
  await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, manifest, {
    readAsset: (name) => fs.readFileSync(path.join(OS_DIR, name), 'utf-8'),
    readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
    buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
    log,
    overlays: resolvedOverlays,
    overlayIo: COMMON.nodeOverlayIo(fs, path, require('crypto')),
    requireCleanOverlays,
  });
  // Verify what was just written: seal intact + version and package set
  // read back.
  const sealed = await BLOCK_FS.verifySeal(store);
  const version = COMMON.bakedVersion(BLOCK_FS, store);
  const pkgs = COMMON.bakedPackages(BLOCK_FS, store);
  if (sealed !== true || version !== (manifest.version | 0) ||
      pkgs.join(',') !== foldedPackages.join(',')) {
    throw new Error(`post-bake verification failed (seal=${sealed}, version=${version}, packages=[${pkgs}])`);
  }
  store.flush();
  const size = store.size();
  store.close();
  fs.utimesSync(tmpPath, bakeStart, bakeStart);
  fs.renameSync(tmpPath, outPath);
  log(`${outPath}: v${version}, ${(size / (1 << 20)).toFixed(1)} MiB, sealed`);
}

main().catch((e) => {
  try { fs.unlinkSync(tmpPath); } catch (e2) {}
  process.stderr.write('mkimage failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
