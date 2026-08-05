'use strict';
// #419: the declarative default-package set — declaration, validation, bake.
//
// The set is declared ONCE: `defaultPackages` in os/image.json. Two host
// obligations guard it (red-then-green, the #97/#434 standard):
//
//   - VALIDATION (foldPackages, so every Node bake path — mkimage, boot.js,
//     image-fixture, serve.js — refuses before a ~minute-long bake): every
//     name must be a known, ungated packages/<name>.json definition; no
//     duplicates; the key must be an array of valid names. A typo here would
//     otherwise ship an image whose every fresh boot fails its sync loudly.
//   - DERIVATION (bakeSystemImage, the ONE choke point both hosts share):
//     a non-empty set bakes /usr/share/gucman/defaults (one name per line,
//     manifest order, # header); an empty/absent set bakes NO file — which
//     is what gates the sync spawn off entirely on today's estate.
//
//   node tests/host/test_default_packages.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

// A throwaway packages dir (the foldPackages packagesDir seam) with one
// valid ungated def and one gated def.
const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'defaults-pkgs-'));
fs.writeFileSync(path.join(pkgDir, 'realpkg.json'), JSON.stringify({
  name: 'realpkg', version: '1.0', summary: 'fixture',
  files: { 'hello.txt': { content: 'hi\n' } },
}) + '\n');
fs.writeFileSync(path.join(pkgDir, 'gatedpkg.json'), JSON.stringify({
  name: 'gatedpkg', version: '1.0', summary: 'gated fixture',
  requires: 'native-sibling:clang',
  files: { 'hello.txt': { content: 'hi\n' } },
}) + '\n');
process.on('exit', () => { try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch (e) {} });

const manifest = (defaults) => {
  const m = {
    version: 1,
    system: { dirs: ['/usr/share', '/usr/share/gucman'], files: {} },
    user: { dirs: [], files: {} },
  };
  if (defaults !== undefined) m.defaultPackages = defaults;
  return m;
};
const fold = (m) => COMMON.foldPackages(fs, path, ROOT, m, [], { packagesDir: pkgDir });

/* ---- validation (every Node bake path, via foldPackages) ---- */

check('RED: an unknown default package name fails the fold, named', () => {
  let threw = null;
  try { fold(manifest(['ghost-419'])); } catch (e) { threw = e; }
  assert.ok(threw, 'foldPackages accepted an unknown defaultPackages name');
  assert.ok(/ghost-419/.test(threw.message), threw.message);
});

check('positive control: a known ungated default passes the fold', () => {
  const r = fold(manifest(['realpkg']));
  assert.ok(r && r.manifest, 'foldPackages returned nothing');
});

check('the EXPLICIT opt-out strips the set instead of validating (#420)', () => {
  // mkimage/boot.js --no-default-packages: a throwaway bake against a
  // substitute defs dir declares that the shipped set is out of scope — the
  // fold succeeds even with a name this pkgDir cannot satisfy, and the
  // folded manifest carries NO set (so bakeSystemImage bakes no defaults
  // file and the throwaway image's boots never attempt an install).
  const r = COMMON.foldPackages(fs, path, ROOT, manifest(['ghost-419']), [],
    { packagesDir: pkgDir, noDefaultPackages: true });
  assert.ok(r && r.manifest, 'foldPackages returned nothing');
  assert.strictEqual(r.manifest.defaultPackages, undefined,
    'opt-out left defaultPackages on the folded manifest');
});

check('RED: a duplicate default name fails the fold, named', () => {
  let threw = null;
  try { fold(manifest(['realpkg', 'realpkg'])); } catch (e) { threw = e; }
  assert.ok(threw, 'foldPackages accepted a duplicate defaultPackages name');
  assert.ok(/realpkg/.test(threw.message), threw.message);
});

check('RED: a gated (native-sibling) default fails the fold, named', () => {
  let threw = null;
  try { fold(manifest(['gatedpkg'])); } catch (e) { threw = e; }
  assert.ok(threw, 'foldPackages accepted a gated defaultPackages name');
  assert.ok(/gatedpkg/.test(threw.message), threw.message);
});

check('RED: a non-array defaultPackages fails the fold', () => {
  let threw = null;
  try { fold(manifest('realpkg')); } catch (e) { threw = e; }
  assert.ok(threw, 'foldPackages accepted a string defaultPackages');
});

/* ---- derivation (bakeSystemImage — the choke point both hosts share) ---- */

// Blob-root read (the bakedVersion '/share/os-release' convention: the blob's
// root is the /usr subtree).
function readBlobFile(store, p) {
  const bfs = BLOCK_FS.createV4(store, { readonly: true });
  const fd = bfs.open(p, 0, 0);
  if (fd === null) return null;
  const st = bfs.fstat(fd);
  const buf = new Uint8Array(st.size);
  let off = 0;
  while (off < buf.length) {
    const n = bfs.read(fd, buf.subarray(off), buf.length - off);
    if (n === null || n === 0) break;
    off += n;
  }
  bfs.close(fd);
  return Buffer.from(buf.subarray(0, off)).toString('utf-8');
}

const bakeIo = {
  readAsset: () => { throw new Error('unexpected asset read'); },
  readBinary: () => { throw new Error('unexpected binary read'); },
  buildProject: () => { throw new Error('unexpected project build'); },
  log: () => {},
};

(async () => {
  try {
    const name = 'RED: a non-empty default set bakes /usr/share/gucman/defaults';
    try {
      const store = new BLOCK_FS.MemoryByteStore(1 << 22);
      // Names here need no defs: validation is the Node callers' fold-time
      // job; the bake just materializes the declared list (the browser
      // in-worker bake has no packages/ to validate against).
      await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store,
        manifest(['alpha', 'beta']), bakeIo);
      const text = readBlobFile(store, '/share/gucman/defaults');
      assert.ok(text !== null, 'blob has no /share/gucman/defaults');
      const names = text.split('\n')
        .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
      assert.deepStrictEqual(names, ['alpha', 'beta'], text);
      console.log('  ok   ' + name);
    } catch (e) {
      console.log('  FAIL ' + name + '\n         ' + (e.message || e));
      failures++;
    }

    const name2 = 'an empty/absent default set bakes NO defaults file';
    try {
      for (const m of [manifest([]), manifest(undefined)]) {
        const store = new BLOCK_FS.MemoryByteStore(1 << 22);
        await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, m, bakeIo);
        assert.strictEqual(readBlobFile(store, '/share/gucman/defaults'), null,
          'a defaults file was baked from an empty set');
      }
      console.log('  ok   ' + name2);
    } catch (e) {
      console.log('  FAIL ' + name2 + '\n         ' + (e.message || e));
      failures++;
    }

    const name3 = 'the SHIPPED manifest folds clean with its declared default set';
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
      assert.ok(Array.isArray(raw.defaultPackages),
        'os/image.json declares no defaultPackages key');
      COMMON.foldPackages(fs, path, ROOT, raw, []);
      console.log('  ok   ' + name3);
    } catch (e) {
      console.log('  FAIL ' + name3 + '\n         ' + (e.message || e));
      failures++;
    }
  } finally {
    console.log(failures ? failures + ' check(s) FAILED' : 'default-packages checks OK');
    process.exit(failures ? 1 : 0);
  }
})();
