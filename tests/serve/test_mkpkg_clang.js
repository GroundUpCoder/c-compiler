// Guardrail (c) — mkpkg --clang sha256 ROUND-TRIP (CLANG-CPP-EPIC Part II §7).
// A `nativeApp` package entry copies its payload out of the sibling's published
// overlay artifact, byte-verified through os-common's loadOverlays (the SAME
// sha256/size enforcement the bake overlay uses — one verifier, no drift). This
// proves: (1) a fresh fake sibling → the payload lands in the pool tarball and
// the index gains the -clang name; (2) a TAMPERED payload (sha256 mismatch) is
// a loud exit(1), never a silently-copied wrong binary.
//
// Plus the OVERLAY-DRIFT gate (todos/0337): a sibling that publishes a
// /usr/bin app no packages/*.json claims is a loud exit(1) — that app would
// otherwise be built and then silently never ship — unless the payload is
// EXPLICITLY exempted with a reason in tools/clang-unpackaged.json, and a
// stale exemption is itself a failure.
//
// Uses the REAL packages/doom-clang.json definition against a synthetic sibling
// overlay, so it exercises the shipped schema end to end (build is instant — a
// nativeApp entry does no compilation).
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
// the same → a mismatch loadOverlays must catch). `extraApp` additionally
// publishes an app under that name — the drift-gate fixture: a payload the
// sibling builds that no packages/*.json claims.
function makeSibling(tamper, extraApp) {
  const sib = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-sib-'));
  const outImg = path.join(sib, 'out-image');
  const payDir = path.join(outImg, 'doom-clang');
  fs.mkdirSync(payDir, { recursive: true });
  fs.writeFileSync(path.join(payDir, 'doom-clang.wasm'), PAYLOAD);
  const realSha = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
  const sha = tamper ? realSha.replace(/./, (c) => (c === 'a' ? 'b' : 'a')) : realSha;
  const files = {
    '/usr/bin/doom-clang': { bin: 'doom-clang/doom-clang.wasm', sha256: sha, size: PAYLOAD.length, mode: '755' },
  };
  if (extraApp) {
    files['/usr/bin/' + extraApp] = { bin: 'doom-clang/doom-clang.wasm', sha256: sha, size: PAYLOAD.length, mode: '755' };
  }
  fs.writeFileSync(path.join(outImg, 'overlay.json'), JSON.stringify({
    schema: 'overlay@1', id: 'clang-apps',
    provenance: { producer: 'clang-simplified', artifactRoot: '.', repo: { commitShort: 'cafe123', dirty: true } },
    files,
  }));
  return sib;
}

function runMkpkg(clangRoot, outDir, extraArgs) {
  return cp.spawnSync(process.execPath,
    [MKPKG, 'doom-clang', '--clang', `--clang-root=${clangRoot}`, `--out=${outDir}`, '--quiet']
      .concat(extraArgs || []),
    { cwd: ROOT, encoding: 'utf-8', timeout: 60000 });
}

// Write an exemption list for --clang-unpackaged=; returns its path.
function writeAllowList(dir, unpackaged) {
  const p = path.join(dir, 'clang-unpackaged.json');
  fs.writeFileSync(p, JSON.stringify({ unpackaged }));
  return p;
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

// --- 3. drift gate: an unclaimed overlay app fails the build ----------------
// The whole point: a clang app the sibling publishes but nothing packages would
// otherwise be built and then silently never reach a single user.
{
  const sib = makeSibling(false, 'orphan-clang');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-out-'));
  try {
    const r = runMkpkg(sib, out);
    check('drift: unclaimed overlay app → exit 1', r.status === 1, 'exit ' + r.status);
    check('drift: names the orphan payload', /\/usr\/bin\/orphan-clang/.test(r.stderr), r.stderr);
    check('drift: nothing built', !fs.existsSync(path.join(out, 'index.json')), 'index.json exists');
  } finally { fs.rmSync(sib, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
}

// --- 4. drift gate: an EXPLICIT exemption is honoured, a stale one is not ----
{
  const sib = makeSibling(false, 'orphan-clang');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-out-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-cfg-'));
  try {
    const ok = writeAllowList(cfg, { 'orphan-clang': 'test fixture: deliberately not a package' });
    const r = runMkpkg(sib, out, [`--clang-unpackaged=${ok}`]);
    check('drift: explicit exemption builds clean', r.status === 0, 'exit ' + r.status + '  ' + r.stderr);

    // Same allow-list, sibling no longer publishing it → the exemption is
    // stale and must fail, not linger as a rule nobody re-checks.
    const sib2 = makeSibling(false);
    const r2 = runMkpkg(sib2, out, [`--clang-unpackaged=${ok}`]);
    check('drift: stale exemption → exit 1', r2.status === 1, 'exit ' + r2.status);
    check('drift: names the stale entry', /stale.*orphan-clang/s.test(r2.stderr), r2.stderr);
    fs.rmSync(sib2, { recursive: true, force: true });
  } finally {
    fs.rmSync(sib, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
