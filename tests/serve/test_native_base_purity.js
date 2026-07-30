// Guardrail (a) — BASE PURITY (CLANG-CPP-EPIC Part II §7; generalized to the
// native-sibling seam by todos/0416). The invariant that keeps "base gucOS
// ships ZERO clang and ZERO Rust" true by CONSTRUCTION: a package definition
// carrying `requires: "native-sibling:<producer>"` (the gate field of the
// *-clang / *-rust packages) is EXCLUDED from every default enumeration —
// mkpkg-no-flag, foldPackages('all') (→ serve.js's fat image, boot.js
// --packages=all, the test fixture) — and appears ONLY under an explicit
// producers opt-in (mkpkg --clang / --rust).
//
// ⚠️ The purity arms alone prove nothing — a tree with no gated definition at
// all would pass them. Every purity arm here rides beside its POSITIVE
// CONTROL: the same enumeration WITH the producer opted in DOES surface the
// gated name. (The mkpkg-level twin — a real `mkpkg --rust` build yielding
// the -rust payload — lives in tests/serve/test_mkpkg_rust.js.)
//
// Three levels: (1) the REAL packages/ tree — no gated name leaks into the
// base set, and the shipped examples DO surface under their producer;
// (2) producer SCOPING — a clang opt-in does not surface rust packages and
// the other way around (a build with the clang sibling present and the Rust
// sibling absent is a normal state); (3) a synthetic tree proving the filter
// mechanism (a gated def is dropped, an ungated one kept, an unknown-gate def
// stays excluded).
//
// Run: node tests/serve/test_native_base_purity.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '../..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

// --- 1. real repo: base enumeration carries no gated name --------------------
{
  const base = COMMON.listPackages(fs, path, ROOT);
  const withClang = COMMON.listPackages(fs, path, ROOT, { producers: ['clang'] });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
  const foldAll = COMMON.foldPackages(fs, path, ROOT, manifest, 'all');

  check('real: listPackages() has NO -clang name', !base.some((n) => /-clang$/.test(n)), base);
  check('real: listPackages() has NO -rust name', !base.some((n) => /-rust$/.test(n)), base);
  check('real: foldPackages("all") has NO -clang name', !foldAll.names.some((n) => /-clang$/.test(n)), foldAll.names);
  check('real: foldPackages("all") has NO -rust name', !foldAll.names.some((n) => /-rust$/.test(n)), foldAll.names);
  // The shipped example proves the gate is exercised, not vacuous.
  check('real: producers:[clang] surfaces the shipped doom-clang example', withClang.includes('doom-clang'), withClang);
  check('real: base EXCLUDES doom-clang', !base.includes('doom-clang'), base);
  // The producer opt-in is a strict superset of base.
  check('real: producers:[clang] ⊇ base', base.every((n) => withClang.includes(n)));
}

// --- 2. real repo: producer scoping ------------------------------------------
// "clang sibling present, Rust sibling absent" is a normal state: a clang
// opt-in must not pull in packages that need the OTHER producer.
{
  const withClang = COMMON.listPackages(fs, path, ROOT, { producers: ['clang'] });
  const withRust = COMMON.listPackages(fs, path, ROOT, { producers: ['rust'] });
  const withBoth = COMMON.listPackages(fs, path, ROOT, { producers: ['clang', 'rust'] });
  check('real: producers:[clang] surfaces NO -rust name', !withClang.some((n) => /-rust$/.test(n)), withClang);
  check('real: producers:[rust] surfaces NO -clang name', !withRust.some((n) => /-clang$/.test(n)), withRust);
  check('real: producers:[clang,rust] ⊇ each single-producer set',
    withClang.every((n) => withBoth.includes(n)) && withRust.every((n) => withBoth.includes(n)));
}

// --- 3. synthetic tree: the filter mechanism itself --------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-purity-'));
  const pkgs = path.join(dir, 'packages');
  fs.mkdirSync(pkgs);
  fs.writeFileSync(path.join(pkgs, 'bar.json'),
    JSON.stringify({ name: 'bar', version: '1', files: { bar: { text: 'x' } } }));
  fs.writeFileSync(path.join(pkgs, 'foo-clang.json'),
    JSON.stringify({ name: 'foo-clang', version: '1', requires: 'native-sibling:clang', files: { foo: { nativeApp: 'foo' } } }));
  fs.writeFileSync(path.join(pkgs, 'baz-rust.json'),
    JSON.stringify({ name: 'baz-rust', version: '1', requires: 'native-sibling:rust', files: { baz: { nativeApp: 'baz' } } }));
  // An unknown gate value must stay EXCLUDED from every enumeration (the base
  // stays pure); mkpkg's gate validation is where it fails loudly.
  fs.writeFileSync(path.join(pkgs, 'odd.json'),
    JSON.stringify({ name: 'odd', version: '1', requires: 'zig-sibling', files: { odd: { text: 'x' } } }));
  // A malformed def must NOT vanish silently — it stays visible so it fails
  // loud downstream (never a way to smuggle a gated payload past the filter).
  fs.writeFileSync(path.join(pkgs, 'broke.json'), '{ not json');

  try {
    const base = COMMON.listPackages(fs, path, dir);
    const withClang = COMMON.listPackages(fs, path, dir, { producers: ['clang'] });
    const withRust = COMMON.listPackages(fs, path, dir, { producers: ['rust'] });
    check('synthetic: base drops the gated foo-clang', !base.includes('foo-clang'), base);
    check('synthetic: base drops the gated baz-rust', !base.includes('baz-rust'), base);
    check('synthetic: base keeps the ungated bar', base.includes('bar'), base);
    check('synthetic: producers:[clang] includes foo-clang, not baz-rust',
      withClang.includes('foo-clang') && !withClang.includes('baz-rust'), withClang);
    check('synthetic: producers:[rust] includes baz-rust, not foo-clang',
      withRust.includes('baz-rust') && !withRust.includes('foo-clang'), withRust);
    check('synthetic: an unknown gate value stays excluded everywhere',
      !base.includes('odd') && !withClang.includes('odd') && !withRust.includes('odd'),
      { base, withClang, withRust });
    check('synthetic: malformed def stays visible (fails loud later, not silent)', base.includes('broke'), base);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- 4. the gate parser itself ------------------------------------------------
{
  const p = COMMON.nativeSiblingProducer;
  check('parser: native-sibling:clang -> clang', p('native-sibling:clang') === 'clang');
  check('parser: native-sibling:rust -> rust', p('native-sibling:rust') === 'rust');
  check('parser: bare native-sibling: -> null', p('native-sibling:') === null);
  check('parser: the pre-0416 value is DEAD (no alias)', p('clang-sibling') === null);
  check('parser: non-strings -> null', p(undefined) === null && p(42) === null);
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
