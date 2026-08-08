// Version-ordering guard (#595).
//
// The additive upsert (#580) overwrites an existing index entry
// unconditionally, and the index is what every gucman client trusts as
// "current" — before this guard, publishing cpython-clang 0.9 after 1.2
// shipped offered every client 0.9 as current, silently. mkpkg now refuses a
// rebuilt entry whose version orders STRICTLY BELOW the already-published one
// (loud exit 1 naming both versions), unless --allow-downgrade states the
// rollback intent. Ordering is rpm/dpkg-style token comparison (verCompare in
// tools/mkpkg.js): digit runs compare numerically — so "0.10" > "0.9", the
// case a naive string `<` gets backwards — letter runs lexically, a proper
// token prefix is older, and EQUAL is not a downgrade (every routine rebuild
// republishes the unchanged version over itself).
//
// This file drives the REAL tool through a sequence of publishes into one out
// dir, checking at each step both the exit status and what the published
// index.json actually says — a refusal must leave the served repo untouched.
//
// Run: node tests/serve/test_mkpkg_version_guard.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const MKPKG = path.join(ROOT, 'tools', 'mkpkg.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-verguard-'));
const defsDir = path.join(tmp, 'defs');
const out = path.join(tmp, 'out');
fs.mkdirSync(defsDir, { recursive: true });

// content-only def: a whole build is milliseconds (nothing compiles, and no
// -sources unit is synthesized for a def with no project/c entry).
function writeDef(version) {
  fs.writeFileSync(path.join(defsDir, 'vg.json'), JSON.stringify({
    name: 'vg', version, summary: 'version-guard fixture',
    files: { note: { content: 'version-guard fixture ' + version + '\n' } },
  }, null, 2) + '\n');
}
function mkpkg(extra) {
  return cp.spawnSync(process.execPath,
    [MKPKG, '--quiet', `--out=${out}`, `--packages-dir=${defsDir}`].concat(extra || []),
    { encoding: 'utf-8', timeout: 120000 });
}
function publishedVersion() {
  return JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf-8')).packages.vg.version;
}
// One step of the sequence: publish `version`, expect acceptance or refusal,
// and always re-read what the repo now serves.
function publish(version, { refused, extra, label } = {}) {
  writeDef(version);
  const r = mkpkg(extra);
  const name = label || `publish ${version}${extra ? ' ' + extra.join(' ') : ''}`;
  if (refused) {
    check(`${name} refuses (exit 1)`, r.status === 1, 'exit=' + r.status + ' ' + r.stderr);
    check(`${name} names the package and BOTH versions`,
      (r.stderr || '').includes('vg') && (r.stderr || '').includes(version) &&
      (r.stderr || '').includes(refused), (r.stderr || '').slice(-400));
    check(`${name} names the --allow-downgrade override`,
      (r.stderr || '').includes('--allow-downgrade'), (r.stderr || '').slice(-400));
    check(`${name} leaves the published index untouched (still ${refused})`,
      publishedVersion() === refused, publishedVersion());
  } else {
    check(`${name} publishes (exit 0)`, r.status === 0, 'exit=' + r.status + ' ' + r.stderr);
    check(`${name}: index now serves ${version}`,
      publishedVersion() === version, publishedVersion());
  }
}

publish('1.0', { label: 'fresh publish 1.0 (no prev entry)' });
publish('1.0', { label: 'equal republish 1.0 (the routine rebuild)' });
publish('0.9', { refused: '1.0' });
publish('0.9', { extra: ['--allow-downgrade'], label: 'stated rollback to 0.9' });
// The two-digit case: a naive string `<` calls "0.10" < "0.9" — the guard
// must order numerically in BOTH directions.
publish('0.10', { label: 'two-digit increase 0.9 -> 0.10' });
publish('0.9', { refused: '0.10', label: 'two-digit downgrade 0.10 -> 0.9' });
// A proper token prefix is older: 0.10 -> 0.10.1 is an increase, the reverse
// a downgrade.
publish('0.10.1', { label: 'prefix increase 0.10 -> 0.10.1' });
publish('0.10', { refused: '0.10.1', label: 'prefix downgrade 0.10.1 -> 0.10' });
// Leading zeros compare numerically: 2.004 == 2.4, and equal is never a
// downgrade — the republish goes through.
publish('2.4', { label: 'increase 0.10.1 -> 2.4' });
publish('2.004', { label: 'equal republish 2.4 as 2.004 (leading zeros)' });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll version-guard checks passed');
process.exit(failures ? 1 : 0);
