// Guardrails for `mkpkg --rust` (todos/0416 — the native-sibling packaging
// seam, second producer). Mirrors test_mkpkg_clang.js over a synthetic
// gucos-rust sibling, and carries the todos/0416 acceptance arms:
//
//   1. PURITY + POSITIVE CONTROL, in the same run: a plain `mkpkg` yields no
//      name matching -rust$ AND prints nothing about Rust — and `mkpkg
//      --rust` DOES yield the -rust name with the verified payload bytes in
//      the pool tarball. The purity arm alone proves nothing (a build that
//      produces nothing at all would pass it); the positive control is what
//      carries the weight.
//   2. A sha256 that does not match refuses the payload (loud exit 1,
//      nothing copied).
//   3. An explicit --rust with no sibling present exits 1 and prints the fix
//      command; naming the gated package without the flag is a loud exit 2
//      pointing at --rust.
//   4. The drift gate runs for rust exactly as for clang: an unclaimed
//      /usr/bin overlay payload fails the build; --rust-unpackaged exempts
//      with a reason; a stale exemption fails.
//   5. Gate validation: a definition whose `requires` is not a known
//      native-sibling gate fails EVERY build loudly (a typo'd gate must not
//      silently vanish from all enumerations).
//
// Uses the REAL packages/wc-rust.json definition against the synthetic
// sibling, so it exercises the shipped schema end to end (build is instant —
// a nativeApp entry does no compilation).
//
// Run: node tests/serve/test_mkpkg_rust.js
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
  Buffer.from('FAKE-WC-RUST-WASM-PAYLOAD')]);

// A synthetic gucos-rust sibling whose out-image/overlay.json publishes
// /usr/bin/wc-rust. `tamper` declares a WRONG sha256 (bytes unchanged → a
// mismatch loadOverlays must catch). `extraApp` publishes an app no
// packages/*.json claims — the drift-gate fixture.
function makeSibling(tamper, extraApp) {
  const sib = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rsib-'));
  const outImg = path.join(sib, 'out-image');
  const payDir = path.join(outImg, 'wc-rust');
  fs.mkdirSync(payDir, { recursive: true });
  fs.writeFileSync(path.join(payDir, 'wc-rust.wasm'), PAYLOAD);
  const realSha = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
  const sha = tamper ? realSha.replace(/./, (c) => (c === 'a' ? 'b' : 'a')) : realSha;
  const files = {
    '/usr/bin/wc-rust': { bin: 'wc-rust/wc-rust.wasm', sha256: sha, size: PAYLOAD.length, mode: '755' },
  };
  if (extraApp) {
    files['/usr/bin/' + extraApp] = { bin: 'wc-rust/wc-rust.wasm', sha256: sha, size: PAYLOAD.length, mode: '755' };
  }
  fs.writeFileSync(path.join(outImg, 'overlay.json'), JSON.stringify({
    schema: 'overlay@1', id: 'rust-apps',
    provenance: { producer: 'gucos-rust', artifactRoot: '.', repo: { commitShort: 'cafe123', dirty: true } },
    files,
  }));
  return sib;
}

function run(args) {
  return cp.spawnSync(process.execPath, [MKPKG, ...args],
    { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
}
function runRust(rustRoot, outDir, extraArgs) {
  return run(['wc-rust', '--rust', `--rust-root=${rustRoot}`, `--out=${outDir}`, '--quiet']
    .concat(extraArgs || []));
}

// --- 1. purity + POSITIVE CONTROL, same invocation of this test -------------
{
  const sib = makeSibling(false);
  const outBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rout-'));
  const outRust = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rout-'));
  try {
    // The purity arm: plain mkpkg over the REAL packages/ tree — the cheapest
    // named base package (a font blob copy, no compilation) keeps the run
    // fast; the written index is the assertion surface. The sibling root
    // points at the live synthetic sibling so the arm cannot pass by mere
    // absence of a resolvable overlay.
    const rb = run(['font-unifont', `--rust-root=${sib}`, `--out=${outBase}`, '--quiet',
                    `--pool=${path.join(ROOT, 'build', 'test-packages', 'pool')}`]);
    check('purity: plain mkpkg exits 0', rb.status === 0, 'exit ' + rb.status + '  ' + rb.stderr);
    const idxB = JSON.parse(fs.readFileSync(path.join(outBase, 'index.json'), 'utf-8'));
    check('purity: base index has NO -rust name',
      !Object.keys(idxB.packages || {}).some((n) => /-rust$/.test(n)),
      Object.keys(idxB.packages || {}).join(','));
    check('purity: plain mkpkg prints NOTHING about rust',
      !/rust/i.test(rb.stdout) && !/rust/i.test(rb.stderr),
      JSON.stringify({ stdout: rb.stdout, stderr: rb.stderr }));

    // The POSITIVE CONTROL: --rust DOES yield the -rust name, and the pool
    // tarball carries the sha256-verified sibling bytes.
    const rr = runRust(sib, outRust);
    check('positive control: mkpkg --rust exits 0', rr.status === 0, 'exit ' + rr.status + '  ' + rr.stderr);
    const idxR = JSON.parse(fs.readFileSync(path.join(outRust, 'index.json'), 'utf-8'));
    check('positive control: index gains wc-rust', !!(idxR.packages && idxR.packages['wc-rust']),
      Object.keys(idxR.packages || {}).join(','));
    const url = idxR.packages['wc-rust'].payload.url;
    const gz = fs.readFileSync(path.join(outRust, url));
    const gzSha = crypto.createHash('sha256').update(gz).digest('hex');
    check('positive control: index sha256 matches the pool payload',
      gzSha === idxR.packages['wc-rust'].payload.sha256, gzSha);
    const tar = zlib.gunzipSync(gz);
    check('positive control: pool tarball carries the verified sibling bytes',
      tar.includes(PAYLOAD), 'not found in tar');
  } finally {
    fs.rmSync(sib, { recursive: true, force: true });
    fs.rmSync(outBase, { recursive: true, force: true });
    fs.rmSync(outRust, { recursive: true, force: true });
  }
}

// --- 2. sha256 mismatch: loud exit 1, nothing copied ------------------------
{
  const sib = makeSibling(true);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rout-'));
  try {
    const r = runRust(sib, out);
    check('tampered: exit 1', r.status === 1, 'exit ' + r.status);
    check('tampered: reports a sha256 mismatch', /sha256 mismatch/.test(r.stderr), r.stderr);
    check('tampered: no index written (nothing copied)', !fs.existsSync(path.join(out, 'index.json')), 'index.json exists');
  } finally { fs.rmSync(sib, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
}

// --- 3. absent sibling: explicit --rust is loud; the flagless name is loud ---
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rout-'));
  const gone = path.join(os.tmpdir(), 'no-such-gucos-rust-' + process.pid);
  try {
    const r = runRust(gone, out);
    check('absent sibling: --rust exits 1', r.status === 1, 'exit ' + r.status);
    check('absent sibling: names the missing root and the fix',
      r.stderr.includes(gone) && /--rust-root=PATH/.test(r.stderr), r.stderr);

    // Naming the gated package without the flag: exit 2, pointing at --rust.
    const r2 = run(['wc-rust', `--out=${out}`, '--quiet']);
    check('flagless gated name: exit 2', r2.status === 2, 'exit ' + r2.status);
    check('flagless gated name: points at --rust',
      /gated on the rust sibling/.test(r2.stderr) && /--rust/.test(r2.stderr), r2.stderr);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}

// --- 4. drift gate: rust rides the same relation as clang -------------------
{
  const sib = makeSibling(false, 'orphan-rust');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rout-'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rcfg-'));
  try {
    const r = runRust(sib, out);
    check('drift: unclaimed overlay app → exit 1', r.status === 1, 'exit ' + r.status);
    check('drift: names the orphan payload', /\/usr\/bin\/orphan-rust/.test(r.stderr), r.stderr);

    const allow = path.join(cfg, 'rust-unpackaged.json');
    fs.writeFileSync(allow, JSON.stringify({ unpackaged: { 'orphan-rust': 'test fixture: deliberately not a package' } }));
    const r2 = runRust(sib, out, [`--rust-unpackaged=${allow}`]);
    check('drift: explicit exemption builds clean', r2.status === 0, 'exit ' + r2.status + '  ' + r2.stderr);

    const sib2 = makeSibling(false);
    const r3 = runRust(sib2, out, [`--rust-unpackaged=${allow}`]);
    check('drift: stale exemption → exit 1', r3.status === 1, 'exit ' + r3.status);
    check('drift: names the stale entry', /stale.*orphan-rust/s.test(r3.stderr), r3.stderr);
    fs.rmSync(sib2, { recursive: true, force: true });
  } finally {
    fs.rmSync(sib, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(cfg, { recursive: true, force: true });
  }
}

// --- 5. gate validation: an unknown `requires` fails EVERY build loudly ------
{
  const pkgs = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rgate-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-rout-'));
  try {
    fs.writeFileSync(path.join(pkgs, 'odd.json'),
      JSON.stringify({ name: 'odd', version: '1', requires: 'zig-sibling', files: { odd: { text: 'x' } } }));
    const r = run([`--packages-dir=${pkgs}`, `--out=${out}`, '--quiet']);
    check('gate validation: unknown requires → exit 1 on a PLAIN build', r.status === 1, 'exit ' + r.status);
    check('gate validation: names the def, the value and the known producers',
      /odd\.json/.test(r.stderr) && /zig-sibling/.test(r.stderr) && /clang, rust/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(pkgs, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
