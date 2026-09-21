// Guardrail (a) — BASE PURITY (CLANG-CPP-EPIC Part II §7; generalized to the
// native-sibling seam by docs/archive/0416). The invariant that keeps "base gucOS
// ships ZERO native-sibling payloads" true by CONSTRUCTION: a package definition
// carrying `requires: "native-sibling:<producer>"` (the gate field of the
// *-clang packages) is EXCLUDED from every default enumeration —
// mkpkg-no-flag, foldPackages('all') (→ serve.js's fat image, boot.js
// --packages=all, the test fixture) — and appears ONLY under an explicit
// producers opt-in (mkpkg --clang).
//
// ⚠️ The purity arms alone prove nothing — a tree with no gated definition at
// all would pass them. Every purity arm here rides beside its POSITIVE
// CONTROL: the same enumeration WITH the producer opted in DOES surface the
// gated name.
// Two levels: (1) the REAL packages/ tree — no gated name leaks into the
// base set, and the shipped examples DO surface under their producer;
// (2) a synthetic tree proving the filter
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
  check('real: foldPackages("all") has NO -clang name', !foldAll.names.some((n) => /-clang$/.test(n)), foldAll.names);
  // The shipped example proves the gate is exercised, not vacuous.
  check('real: producers:[clang] surfaces the shipped doom-clang example', withClang.includes('doom-clang'), withClang);
  check('real: base EXCLUDES doom-clang', !base.includes('doom-clang'), base);
  // The producer opt-in is a strict superset of base.
  check('real: producers:[clang] ⊇ base', base.every((n) => withClang.includes(n)));
}

// --- 2. synthetic tree: the filter mechanism itself --------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-purity-'));
  const pkgs = path.join(dir, 'packages');
  fs.mkdirSync(pkgs);
  fs.writeFileSync(path.join(pkgs, 'bar.json'),
    JSON.stringify({ name: 'bar', version: '1', files: { bar: { text: 'x' } } }));
  fs.writeFileSync(path.join(pkgs, 'foo-clang.json'),
    JSON.stringify({ name: 'foo-clang', version: '1', requires: 'native-sibling:clang', files: { foo: { nativeApp: 'foo' } } }));
  fs.writeFileSync(path.join(pkgs, 'baz-fixture.json'),
    JSON.stringify({ name: 'baz-fixture', version: '1', requires: 'native-sibling:fixture', files: { baz: { nativeApp: 'baz' } } }));
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
    const withfixture = COMMON.listPackages(fs, path, dir, { producers: ['fixture'] });
    check('synthetic: base drops the gated foo-clang', !base.includes('foo-clang'), base);
    check('synthetic: base drops the gated baz-fixture', !base.includes('baz-fixture'), base);
    check('synthetic: base keeps the ungated bar', base.includes('bar'), base);
    check('synthetic: producers:[clang] includes foo-clang, not baz-fixture',
      withClang.includes('foo-clang') && !withClang.includes('baz-fixture'), withClang);
    check('synthetic: producers:[fixture] includes baz-fixture, not foo-clang',
      withfixture.includes('baz-fixture') && !withfixture.includes('foo-clang'), withfixture);
    check('synthetic: an unknown gate value stays excluded everywhere',
      !base.includes('odd') && !withClang.includes('odd') && !withfixture.includes('odd'),
      { base, withClang, withfixture });
    check('synthetic: malformed def stays visible (fails loud later, not silent)', base.includes('broke'), base);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- 3. the gate parser itself ------------------------------------------------
{
  const p = COMMON.nativeSiblingProducer;
  check('parser: native-sibling:clang -> clang', p('native-sibling:clang') === 'clang');
  check('parser: native-sibling:fixture -> fixture', p('native-sibling:fixture') === 'fixture');
  check('parser: bare native-sibling: -> null', p('native-sibling:') === null);
  check('parser: the pre-0416 value is DEAD (no alias)', p('clang-sibling') === null);
  check('parser: non-strings -> null', p(undefined) === null && p(42) === null);
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
