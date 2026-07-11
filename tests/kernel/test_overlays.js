#!/usr/bin/env node
// tests/kernel/test_overlays.js — optional opt-in image overlays (todos/0118).
//
// Exercises the consumer side of the frozen `overlay@1` contract at UNIT scale:
// bakeSystemImage over a tiny synthetic manifest (one trivial compile) instead
// of the full ~minute OS bake, so the whole file runs in a couple of seconds.
//
//   - a base bake with no overlay is byte-identical across runs and carries no
//     overlay dirs / files / provenance / os-release OVERLAYS line (inert)
//   - a valid overlay plants its files (verbatim bytes at the declared mode),
//     records provenance at /usr/share/overlays/<id>.json, and stamps the
//     image identity (OVERLAYS= + os-release.overlays companion)
//   - every frozen fatal rule fires: bad schema, id mismatch, missing manifest,
//     sha256/size mismatch, one-of bin|text, base-path conflict w/o override,
//     cross-overlay conflict, out-of-/usr path, requireClean on a dirty tree
//   - a dirty overlay WARNS (non-fatal) by default
//   - the sealed blob still verifies after an overlay is folded in
//
// Run: node tests/kernel/test_overlays.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovl-'));
const overlayIo = COMMON.nodeOverlayIo(fs, path, crypto);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// A tiny system section: one trivial compile keeps the bake ~1-2s.
const TINY_MANIFEST = {
  version: 7,
  system: { dirs: ['/usr/bin', '/usr/share'], files: { '/usr/bin/hi': { c: 'hi.c' } } },
};
const seedIo = {
  readAsset: () => 'int main(void){return 0;}\n',
  readBinary: () => { throw new Error('no bin in tiny manifest'); },
  buildProject: () => { throw new Error('no project in tiny manifest'); },
  log: () => {},
};

// Bake TINY_MANIFEST into a fresh MemoryByteStore, optionally with overlays.
// Returns { store, log } (log = captured [mkimage]-style lines).
async function bake(overlays, requireClean) {
  const lines = [];
  const store = new BLOCK_FS.MemoryByteStore(1 << 16);
  await COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, store, TINY_MANIFEST, Object.assign({}, seedIo, {
    log: (m) => lines.push(m),
    overlays: overlays || [],
    overlayIo,
    requireCleanOverlays: !!requireClean,
  }));
  return { store, log: lines };
}

// Read a file from a sealed blob (root = the /usr subtree, so /usr/X -> /X).
function readBlob(store, blobPath) {
  const rofs = BLOCK_FS.createV4(store, { readonly: true });
  return COMMON.readFileBytes(rofs, blobPath);
}
function readBlobText(store, blobPath) {
  const b = readBlob(store, blobPath);
  return b === null ? null : new TextDecoder('utf-8').decode(b);
}

// Write a full overlay@1 manifest + its payloads to a temp dir; return its path.
let ovlSeq = 0;
function writeOverlay(overlay, payloads) {
  const dir = path.join(tmp, 'ovl' + (ovlSeq++));
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, bytes] of Object.entries(payloads || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(bytes));
  }
  const mp = path.join(dir, 'overlay.json');
  fs.writeFileSync(mp, JSON.stringify(overlay, null, 2));
  return mp;
}

function baseProvenance(over) {
  return Object.assign({
    producer: 'clang-simplified',
    toolchain: 'cc2wasm',
    builtAtUtc: '2026-07-11T20:15:00Z',
    artifactRoot: '.',
    repo: { commit: 'a'.repeat(40), commitShort: 'a1b2c3d', dirty: false, branch: 'main' },
  }, over || {});
}

async function expectFatal(name, needle, fn) {
  try { await fn(); check(name, false, 'expected a fatal error'); }
  catch (e) {
    const msg = (e && e.message) || String(e);
    check(name, msg.indexOf(needle) >= 0, 'message was: ' + msg);
  }
}

async function main() {
  // ---- a base bake is INERT: no overlay flag => no overlay artifacts, and the
  // image-identity file is byte-for-byte the canonical base string (the bake is
  // not otherwise byte-deterministic — inode mtimes are wall-clock — so identity
  // content, not the whole blob, is the meaningful inertness invariant). ----
  const a = await bake(null);
  check('base bake seals', (await BLOCK_FS.verifySeal(a.store)) === true);
  const baseRel = readBlobText(a.store, '/share/os-release');
  check('base os-release is exactly the canonical string',
    baseRel === 'NAME=gucOS\nPRETTY_NAME="gucOS (groundupcoder OS)"\nVERSION_ID=7\n', JSON.stringify(baseRel));
  check('base has no /usr/share/overlays dir', readBlob(a.store, '/share/overlays/x') === null);
  check('base has no os-release.overlays companion', readBlob(a.store, '/share/os-release.overlays') === null);
  // Passing an empty overlays array is the same code path as no flag at all.
  const empty = await bake([]);
  check('empty overlays array is inert too',
    readBlobText(empty.store, '/share/os-release') === baseRel &&
    readBlob(empty.store, '/share/os-release.overlays') === null);

  // ---- a valid overlay plants files + provenance + identity ----
  const doomBytes = crypto.randomBytes(4096);
  const wadBytes = crypto.randomBytes(2048);
  const mp = writeOverlay({
    schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
    dirs: ['/usr/share/menu/Games', '/usr/share/doom'],
    files: {
      '/usr/bin/doom': { bin: 'doom/doom.wasm', mode: '0755', sha256: sha256(doomBytes), size: doomBytes.length },
      '/usr/share/doom/DOOM1.WAD': { bin: 'doom/DOOM1.WAD', mode: '0644', sha256: sha256(wadBytes), size: wadBytes.length, asset: true },
      '/usr/share/menu/Games/doom.desktop': { text: '[Desktop Entry]\nName=DOOM\nExec=/usr/bin/doom\n', mode: '0644' },
    },
  }, { 'doom/doom.wasm': doomBytes, 'doom/DOOM1.WAD': wadBytes });

  const applied = await bake([{ id: 'clang-apps', manifestPath: mp }]);
  check('overlay bake seals', (await BLOCK_FS.verifySeal(applied.store)) === true);
  const planted = readBlob(applied.store, '/bin/doom');
  check('planted /usr/bin/doom bytes match',
    planted && Buffer.compare(Buffer.from(planted), doomBytes) === 0);
  const wad = readBlob(applied.store, '/share/doom/DOOM1.WAD');
  check('planted /usr/share/doom/DOOM1.WAD bytes match',
    wad && Buffer.compare(Buffer.from(wad), wadBytes) === 0);
  const desktop = readBlobText(applied.store, '/share/menu/Games/doom.desktop');
  check('planted text entry', desktop && desktop.indexOf('Name=DOOM') >= 0);
  const prov = readBlobText(applied.store, '/share/overlays/clang-apps.json');
  check('provenance recorded', prov && JSON.parse(prov).repo.commitShort === 'a1b2c3d');
  const rel = readBlobText(applied.store, '/share/os-release');
  check('os-release notes OVERLAYS', /OVERLAYS=clang-apps/.test(rel), rel);
  const comp = readBlobText(applied.store, '/share/os-release.overlays');
  check('os-release.overlays companion', comp && JSON.parse(comp)[0].id === 'clang-apps' && JSON.parse(comp)[0].dirty === false);
  check('loud one-line summary logged',
    applied.log.some((l) => /overlay clang-apps: 3 files/.test(l) && /clang-simplified@a1b2c3d \(clean\)/.test(l)),
    applied.log.join(' | '));

  // ---- mode defaults (no explicit mode) ----
  const exeBytes = crypto.randomBytes(64), datBytes = crypto.randomBytes(64);
  const mpMode = writeOverlay({
    schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
    dirs: ['/usr/share/x'],
    files: {
      '/usr/bin/exe': { bin: 'exe', sha256: sha256(exeBytes), size: exeBytes.length },
      '/usr/share/x/dat': { bin: 'dat', sha256: sha256(datBytes), size: datBytes.length },
    },
  }, { exe: exeBytes, dat: datBytes });
  const modeStore = (await bake([{ id: 'clang-apps', manifestPath: mpMode }])).store;
  const rofs = BLOCK_FS.createV4(modeStore, { readonly: true });
  check('default mode 0755 under /usr/bin', (rofs.stat('/bin/exe').mode & 0o777) === 0o755, (rofs.stat('/bin/exe').mode & 0o777).toString(8));
  check('default mode 0644 elsewhere', (rofs.stat('/share/x/dat').mode & 0o777) === 0o644, (rofs.stat('/share/x/dat').mode & 0o777).toString(8));

  // ---- fatal paths ----
  await expectFatal('unknown/missing manifest is fatal', 'not found — build it in the sibling',
    () => bake([{ id: 'clang-apps', manifestPath: path.join(tmp, 'does-not-exist.json') }]));

  await expectFatal('bad schema is fatal', 'is not "overlay@1"', () => {
    const p = writeOverlay({ schema: 'overlay@2', id: 'clang-apps', provenance: baseProvenance(), files: {} });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('id mismatch is fatal', 'overlay id mismatch', () => {
    const p = writeOverlay({ schema: 'overlay@1', id: 'other', provenance: baseProvenance(), files: {} });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('missing provenance.repo is fatal', 'provenance.repo is required', () => {
    const p = writeOverlay({ schema: 'overlay@1', id: 'clang-apps', provenance: { producer: 'x' }, files: {} });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('sha256 mismatch is fatal', 'sha256 mismatch', () => {
    const good = crypto.randomBytes(128);
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/usr/bin/x': { bin: 'x', sha256: sha256(crypto.randomBytes(8)), size: good.length } },
    }, { x: good });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('size mismatch is fatal', 'size mismatch', () => {
    const good = crypto.randomBytes(128);
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/usr/bin/x': { bin: 'x', sha256: sha256(good), size: good.length + 1 } },
    }, { x: good });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('bin+text both is fatal', 'exactly one of', () => {
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/usr/bin/x': { bin: 'x', text: 'y', sha256: sha256(Buffer.from('z')), size: 1 } },
    }, { x: Buffer.from('z') });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('out-of-/usr path is fatal', 'must be under /usr', () => {
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/etc/passwd': { text: 'x' } },
    });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('base-path conflict without override is fatal', 'already exists in the base image', () => {
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/usr/bin/hi': { text: 'clobber' } },   // /usr/bin/hi is a base file
    });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('parent-not-a-dir is fatal', 'is not a base dir', () => {
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/usr/nope/deep/x': { text: 'x' } },   // parent not base nor in dirs
    });
    return bake([{ id: 'clang-apps', manifestPath: p }]);
  });

  await expectFatal('requireClean promotes dirty to fatal', 'DIRTY tree and --require-clean-overlays', () => {
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps',
      provenance: baseProvenance({ repo: { commit: 'x', commitShort: 'xxxx', dirty: true, branch: 'main' } }),
      files: {},
    });
    return bake([{ id: 'clang-apps', manifestPath: p }], true /* requireClean */);
  });

  // ---- override: true allows replacing a base file ----
  {
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      files: { '/usr/bin/hi': { text: 'overridden', override: true } },
    });
    const st = (await bake([{ id: 'clang-apps', manifestPath: p }])).store;
    check('override replaces a base file', readBlobText(st, '/bin/hi') === 'overridden');
  }

  // ---- cross-overlay conflict on the same path is fatal ----
  await expectFatal('two overlays targeting one path is fatal', 'planted by both', () => {
    const p1 = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps', provenance: baseProvenance(),
      dirs: ['/usr/share/x'], files: { '/usr/share/x/dup': { text: 'a' } },
    });
    const p2 = writeOverlay({
      schema: 'overlay@1', id: 'more-apps', provenance: baseProvenance(),
      dirs: ['/usr/share/x'], files: { '/usr/share/x/dup': { text: 'b' } },
    });
    return bake([{ id: 'clang-apps', manifestPath: p1 }, { id: 'more-apps', manifestPath: p2 }]);
  });

  // ---- a dirty overlay WARNS but succeeds by default ----
  {
    const dirtyBytes = crypto.randomBytes(32);
    const p = writeOverlay({
      schema: 'overlay@1', id: 'clang-apps',
      provenance: baseProvenance({ repo: { commit: 'x', commitShort: 'deadbee', dirty: true, branch: 'wip' } }),
      files: { '/usr/bin/dd': { bin: 'dd', sha256: sha256(dirtyBytes), size: dirtyBytes.length } },
    }, { dd: dirtyBytes });
    const res = await bake([{ id: 'clang-apps', manifestPath: p }]);
    check('dirty overlay warns loudly', res.log.some((l) => /WARNING overlay clang-apps built from a DIRTY tree/.test(l)));
    check('dirty overlay still applies', readBlob(res.store, '/bin/dd') !== null);
    const c = JSON.parse(readBlobText(res.store, '/share/os-release.overlays'));
    check('dirty flag recorded in identity', c[0].dirty === true);
  }

  console.log(failures ? `\nFAILED (${failures})` : '\nALL PASS');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
