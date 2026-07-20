// Guardrail (a) — BASE PURITY (CLANG-CPP-EPIC Part II §7). The invariant that
// keeps "base gucOS ships ZERO clang" true by CONSTRUCTION: a package definition
// carrying `requires` (the *-clang gate field) is EXCLUDED from every default
// enumeration — mkpkg-no-flag, foldPackages('all') (→ serve.js's fat image,
// boot.js --packages=all, the test fixture) — and appears ONLY under an
// explicit --clang / withClang opt-in.
//
// Two levels: (1) the REAL packages/ tree — no *-clang name leaks into the base
// set, and the shipped example (doom-clang) DOES surface under withClang;
// (2) a synthetic tree proving the filter mechanism (a gated def is dropped, an
// ungated one is kept).
//
// Run: node tests/serve/test_clang_base_purity.js
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

// --- 1. real repo: base enumeration carries no -clang name ------------------
{
  const base = COMMON.listPackages(fs, path, ROOT);
  const withClang = COMMON.listPackages(fs, path, ROOT, { withClang: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
  const foldAll = COMMON.foldPackages(fs, path, ROOT, manifest, 'all');

  check('real: listPackages() has NO -clang name', !base.some((n) => /-clang$/.test(n)), base);
  check('real: foldPackages("all") has NO -clang name', !foldAll.names.some((n) => /-clang$/.test(n)), foldAll.names);
  // The shipped example proves the gate is exercised, not vacuous.
  check('real: withClang surfaces the shipped doom-clang example', withClang.includes('doom-clang'), withClang);
  check('real: base EXCLUDES doom-clang', !base.includes('doom-clang'), base);
  // withClang is a strict superset of base.
  check('real: withClang ⊇ base', base.every((n) => withClang.includes(n)));
}

// --- 2. synthetic tree: the filter mechanism itself -------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-purity-'));
  const pkgs = path.join(dir, 'packages');
  fs.mkdirSync(pkgs);
  fs.writeFileSync(path.join(pkgs, 'bar.json'),
    JSON.stringify({ name: 'bar', version: '1', files: { bar: { text: 'x' } } }));
  fs.writeFileSync(path.join(pkgs, 'foo-clang.json'),
    JSON.stringify({ name: 'foo-clang', version: '1', requires: 'clang-sibling', files: { foo: { clangApp: 'foo' } } }));
  // A malformed def must NOT vanish silently — it stays visible so it fails
  // loud downstream (never a way to smuggle a gated payload past the filter).
  fs.writeFileSync(path.join(pkgs, 'broke.json'), '{ not json');

  try {
    const base = COMMON.listPackages(fs, path, dir);
    const withClang = COMMON.listPackages(fs, path, dir, { withClang: true });
    check('synthetic: base drops the gated foo-clang', !base.includes('foo-clang'), base);
    check('synthetic: base keeps the ungated bar', base.includes('bar'), base);
    check('synthetic: withClang includes foo-clang', withClang.includes('foo-clang'), withClang);
    check('synthetic: malformed def stays visible (fails loud later, not silent)', base.includes('broke'), base);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
