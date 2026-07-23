// Deterministic system-image bake (todos/0249): two bakes of an identical
// tree MUST produce byte-identical blobs, or the deploy's content-hashed
// image name (os-system.<sha>.img, immutable cache headers) churns on every
// rebuild and a no-change redeploy re-downloads the whole ~19.5 MB image.
//
// The wall-clock leak was BlockFS._now() stamping every inode a/m/c/btime
// with Date.now() during the bake; bakeSystemImage now injects a fixed
// manifest-version-derived clock (createV4 opts.clock). This test drives the
// REAL tools/mkimage.js twice — same tiny manifest covering every timestamped
// bake path (mkdir, inline content, a cc-compiled binary, a symlink) — and
// asserts the outputs hash identically. mkimage's own post-bake check (seal
// intact + version reads back) gates each run's exit code; the test re-checks
// both on the output independently for loudness. A full-manifest 2x-bake was
// verified byte-identical when this landed; the tiny manifest keeps the suite
// fast while exercising the same clock plumbing.
//
// Run: node tests/serve/test_image_determinism.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'img-determinism-'));
const MANIFEST = path.join(TMP, 'manifest.json');
// Tiny but representative: every seed-entry kind that stamps inode times.
// hello.c is a repo asset (os/hello.c — mkimage's readAsset root), so the
// bake runs the real cc driver end to end.
fs.writeFileSync(MANIFEST, JSON.stringify({
  version: 424242,
  system: {
    dirs: ['/usr/bin', '/usr/share'],
    files: {
      '/usr/bin/hello': { c: 'hello.c' },
      '/usr/share/note': { content: 'determinism probe\n' },
      '/usr/bin/hi': { link: '/usr/bin/hello' },
    },
  },
}, null, 2));

function bake(out) {
  const r = cp.spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkimage.js'), `--manifest=${MANIFEST}`, `--out=${out}`, '--quiet'],
    { cwd: ROOT, encoding: 'utf-8' });
  return r;
}
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function main() {
  const outA = path.join(TMP, 'a.img');
  const outB = path.join(TMP, 'b.img');
  const ra = bake(outA);
  check('first bake exits 0 (post-bake seal+version check passed)', ra.status === 0, ra.stderr);
  const rb = bake(outB);
  check('second bake exits 0', rb.status === 0, rb.stderr);
  if (failures) { finish(); return; }

  const ha = sha256(outA), hb = sha256(outB);
  check('two bakes of an identical tree are byte-identical', ha === hb, ha + ' vs ' + hb);

  // Independent re-check of what mkimage verified internally: the blob is
  // sealed and reads back the manifest version.
  const store = new COMMON.NodeFileStore(fs, outA, false);
  check('output seal verifies', (await BLOCK_FS.verifySeal(store)) === true);
  check('bakedVersion reads back the manifest version',
    COMMON.bakedVersion(BLOCK_FS, store) === 424242,
    String(COMMON.bakedVersion(BLOCK_FS, store)));
  store.close();
  finish();
}

function finish() {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); failures++; finish(); });
