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
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--out=')) outPath = path.resolve(a.slice(6));
  else if (a.startsWith('--manifest=')) manifestPath = path.resolve(a.slice(11));
  else if (a === '--quiet') quiet = true;
  else {
    process.stderr.write(`mkimage: unknown option ${a}\n`);
    process.exit(2);
  }
}
const log = quiet ? () => {} : (m) => process.stderr.write('[mkimage] ' + m + '\n');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

async function main() {
  const store = new COMMON.NodeFileStore(fs, outPath, true /* fresh */);
  await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, manifest, {
    readAsset: (name) => fs.readFileSync(path.join(OS_DIR, name), 'utf-8'),
    readBinary: (p) => fs.readFileSync(path.join(ROOT, p)),
    buildProject: (proj) => COMMON.buildProject(CompilerJS, proj,
      (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')),
    log,
  });
  // Verify what was just written: seal intact + the version reads back.
  const sealed = await BLOCK_FS.verifySeal(store);
  const version = COMMON.bakedVersion(BLOCK_FS, store);
  if (sealed !== true || version !== (manifest.version | 0)) {
    throw new Error(`post-bake verification failed (seal=${sealed}, version=${version})`);
  }
  store.flush();
  const size = store.size();
  store.close();
  log(`${outPath}: v${version}, ${(size / (1 << 20)).toFixed(1)} MiB, sealed`);
}

main().catch((e) => {
  process.stderr.write('mkimage failed: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
