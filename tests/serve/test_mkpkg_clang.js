// Guardrail (c) — mkpkg --clang sha256 ROUND-TRIP (CLANG-CPP-EPIC Part II §7).
// A `clangApp` package entry copies its payload out of the sibling's published
// overlay artifact, byte-verified through os-common's loadOverlays (the SAME
// sha256/size enforcement the bake overlay uses — one verifier, no drift). This
// proves: (1) a fresh fake sibling → the payload lands in the pool tarball and
// the index gains the -clang name; (2) a TAMPERED payload (sha256 mismatch) is
// a loud exit(1), never a silently-copied wrong binary.
//
// Uses the REAL packages/doom-clang.json definition against a synthetic sibling
// overlay, so it exercises the shipped schema end to end (build is instant — a
// clangApp entry does no compilation).
//
// Run: node tests/serve/test_mkpkg_clang.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const MKPKG = path.join(ROOT, 'tools', 'mkpkg.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const PAYLOAD = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
  Buffer.from('FAKE-DOOM-CLANG-WASM-PAYLOAD')]);

// Build a fake clang-simplified sibling whose out-image/overlay.json publishes
// /usr/bin/doom-clang. `tamper` writes a WRONG declared sha256 (the bytes stay
// the same → a mismatch loadOverlays must catch).
function makeSibling(tamper) {
  const sib = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-sib-'));
  const outImg = path.join(sib, 'out-image');
  const payDir = path.join(outImg, 'doom-clang');
  fs.mkdirSync(payDir, { recursive: true });
  fs.writeFileSync(path.join(payDir, 'doom-clang.wasm'), PAYLOAD);
  const realSha = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
  const sha = tamper ? realSha.replace(/./, (c) => (c === 'a' ? 'b' : 'a')) : realSha;
  fs.writeFileSync(path.join(outImg, 'overlay.json'), JSON.stringify({
    schema: 'overlay@1', id: 'clang-apps',
    provenance: { producer: 'clang-simplified', artifactRoot: '.', repo: { commitShort: 'cafe123', dirty: true } },
    files: { '/usr/bin/doom-clang': { bin: 'doom-clang/doom-clang.wasm', sha256: sha, size: PAYLOAD.length, mode: '755' } },
  }));
  return sib;
}

function runMkpkg(clangRoot, outDir) {
  return cp.spawnSync(process.execPath,
    [MKPKG, 'doom-clang', '--clang', `--clang-root=${clangRoot}`, `--out=${outDir}`, '--quiet'],
    { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
}

// --- 1. happy round-trip: payload copied + hash-verified + indexed ----------
{
  const sib = makeSibling(false);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-out-'));
  try {
    const r = runMkpkg(sib, out);
    check('round-trip: exit 0', r.status === 0, 'exit ' + r.status + '  ' + r.stderr);
    const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf-8'));
    check('round-trip: index gains doom-clang', !!(idx.packages && idx.packages['doom-clang']), Object.keys(idx.packages || {}).join(','));
    const url = idx.packages['doom-clang'].payload.url;
    const gz = fs.readFileSync(path.join(out, url));
    // Index sha256 is the payload's own hash — verify it self-describes.
    const gzSha = crypto.createHash('sha256').update(gz).digest('hex');
    check('round-trip: index sha256 matches the pool payload', gzSha === idx.packages['doom-clang'].payload.sha256, gzSha);
    // The verified clang bytes actually made it into the tarball.
    const tar = zlib.gunzipSync(gz);
    check('round-trip: pool tarball carries the verified clang bytes', tar.includes(PAYLOAD), 'not found in tar');
  } finally { fs.rmSync(sib, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
}

// --- 2. sha256 mismatch: loud exit 1, nothing copied ------------------------
{
  const sib = makeSibling(true);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-out-'));
  try {
    const r = runMkpkg(sib, out);
    check('tampered: exit 1', r.status === 1, 'exit ' + r.status);
    check('tampered: reports a sha256 mismatch', /sha256 mismatch/.test(r.stderr), r.stderr);
    check('tampered: no index written (nothing copied)', !fs.existsSync(path.join(out, 'index.json')), 'index.json exists');
  } finally { fs.rmSync(sib, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
