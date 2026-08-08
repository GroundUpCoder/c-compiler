// #598: construction requires an explicit baseline decision. A supplied
// served index is authoritative even with no warm out/index.json, its
// provenance is recorded, and published -sources history requires an explicit
// sourcesVersion on a package-derived companion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const MKPKG = process.env.MKPKG_UNDER_TEST || path.join(ROOT, 'tools', 'mkpkg.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-baseline-'));
let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function run(args) {
  return cp.spawnSync(process.execPath, [MKPKG, '--quiet', ...args],
    { cwd: path.resolve(path.dirname(MKPKG), '..'), encoding: 'utf-8', timeout: 120000 });
}
function writeIndex(file, packages) {
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, baseVersion: 244, packages }));
}

const defs = path.join(tmp, 'defs');
fs.mkdirSync(defs);
fs.writeFileSync(path.join(defs, 'vg.json'), JSON.stringify({
  name: 'vg', version: '1', summary: 'fixture', minBase: 0,
  files: { note: { content: 'fixture\n' } },
}));
const base = path.join(tmp, 'baseline.json');
writeIndex(base, { vg: { version: '2' } });

let r = run([`--out=${path.join(tmp, 'bare')}`, `--packages-dir=${defs}`]);
check('bare mkpkg refuses without an explicit baseline decision', r.status === 2, r.stderr);
check('refusal names all three choices', ['--baseline <file>', '--baseline-url <url>', '--no-baseline']
  .every((s) => r.stderr.includes(s)), r.stderr);

r = run([`--out=${path.join(tmp, 'down')}`, `--packages-dir=${defs}`, '--baseline', base]);
check('served baseline downgrade refuses with no warm index', r.status === 1, r.stderr);
check('served refusal names both versions', r.stderr.includes('vg 1') && r.stderr.includes('2'), r.stderr);

writeIndex(base, { vg: { version: '1' } });
const out = path.join(tmp, 'ok');
r = run([`--out=${out}`, `--packages-dir=${defs}`, `--baseline=${base}`]);
check('file baseline construction succeeds', r.status === 0, r.stderr);
if (r.status === 0) {
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json')));
  check('candidate records source, retrieval time, and content hash',
    idx.baseline.source === base && /^\d{4}-/.test(idx.baseline.retrievalTime) &&
      /^[0-9a-f]{64}$/.test(idx.baseline.sha256), JSON.stringify(idx.baseline));
}

const dataUrl = 'data:application/json,' + encodeURIComponent(fs.readFileSync(base, 'utf-8'));
r = run([`--out=${path.join(tmp, 'url')}`, `--packages-dir=${defs}`, '--baseline-url', dataUrl]);
check('URL baseline construction succeeds', r.status === 0, r.stderr);

const srcDefs = path.join(tmp, 'srcdefs');
fs.mkdirSync(srcDefs);
fs.writeFileSync(path.join(srcDefs, 'future.json'), JSON.stringify({
  name: 'future', version: '0.1', summary: 'unbake fixture',
  files: { future: { c: 'hello.c' } }, bin: { future: 'future' },
}));
writeIndex(base, { 'future-sources': { version: '244' } });
r = run([`--out=${path.join(tmp, 'unbake')}`, `--packages-dir=${srcDefs}`,
  '--baseline', base, 'future-sources']);
check('published companion history without sourcesVersion refuses loudly', r.status === 1, r.stderr);
check('omission refusal names companion, old version, and sourcesVersion',
  r.stderr.includes('future-sources') && r.stderr.includes('244') &&
    r.stderr.includes('sourcesVersion'), r.stderr);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} baseline check(s) FAILED` : 'All mkpkg baseline checks passed');
process.exit(failures ? 1 : 0);
