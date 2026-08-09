// minBase honesty (#518).
//
// mkpkg stamps an UNDECLARED minBase with the current os/image.json version,
// and for a payload the tool compiles that is correct by construction: the
// binary is built by today's pipeline against today's host env surface, whose
// import set grows (measured: today's doom-bin imports __clip_has/
// __getentropy/__mkdir_impl — none exist in the v133 host, so instantiation
// on an older base is a LinkError). A DECLARED minBase is the opposite kind
// of claim — "this package genuinely works against base v<minBase>" — and is
// honest only for payloads that carry no compiled code, whose floor is the
// gucman control-key mechanism version (stable; it does not move when the
// platform grows). Adjudication of every def: logs/2026-08-07/
// 0518-package-minbase.md.
//
// This file pins both halves of that contract on the REAL tool plus a lint
// over the REAL definitions:
//
//   DECLARED   a def's minBase rides into index.json verbatim — including 0,
//              the "ungated" sentinel software.c documents and the
//              synthesized -sources defs use (a truthiness check would
//              silently eat it).
//   DEFAULT    an undeclared def stamps the current image version.
//   REFUSAL    garbage refuses loudly instead of `|0`-coercing into a wrong
//              claim: non-integer, negative, and above-current-version defs
//              all fail the build naming the package.
//   LINT       every packages/*.json whose payload carries no compiled code
//              (no project/c/nativeApp entry, no srclib section) MUST declare
//              an explicit minBase — the class this ticket fixed cannot
//              silently regrow — and every declared value is an integer in
//              [1, current version]. The classifier carries its own red/green
//              controls so an empty scan can never fake a clean pass.
//
// Run: node tests/serve/test_mkpkg_minbase.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const MKPKG = path.join(ROOT, 'tools', 'mkpkg.js');
const PKGS_DIR = path.join(ROOT, 'packages');
const IMAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8')).version | 0;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkpkg-minbase-'));

// content-only defs: a whole build is milliseconds (nothing compiles, and no
// -sources unit is synthesized for a def with no project/c entry).
function writeDefs(dirName, defs) {
  const d = path.join(tmp, dirName);
  fs.mkdirSync(d, { recursive: true });
  for (const def of defs) {
    fs.writeFileSync(path.join(d, def.name + '.json'), JSON.stringify(def, null, 2) + '\n');
  }
  return d;
}
function fixtureDef(name, minBase) {
  const def = {
    name, version: '1.0', summary: 'minBase fixture ' + name,
    files: { note: { content: 'minBase fixture ' + name + '\n' } },
  };
  if (minBase !== undefined) def.minBase = minBase;
  return def;
}
function mkpkg(out, defsDir) {
  return cp.spawnSync(process.execPath,
    [MKPKG, '--no-baseline', '--quiet', `--out=${out}`, `--packages-dir=${defsDir}`],
    { encoding: 'utf-8', timeout: 120000 });
}

/* ---- DECLARED + DEFAULT: one build, three defs ---- */
{
  const out = path.join(tmp, 'out-green');
  const defs = writeDefs('defs-green', [
    fixtureDef('mb-declared', 42),
    fixtureDef('mb-zero', 0),
    fixtureDef('mb-default'),
  ]);
  const r = mkpkg(out, defs);
  check('green build succeeds', r.status === 0, r.stderr);
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf-8'));
  check('declared minBase rides into the index verbatim',
    idx.packages['mb-declared'] && idx.packages['mb-declared'].minBase === 42,
    JSON.stringify(idx.packages['mb-declared']));
  check('declared minBase 0 (the ungated sentinel) survives — not eaten by a truthiness check',
    idx.packages['mb-zero'] && idx.packages['mb-zero'].minBase === 0,
    JSON.stringify(idx.packages['mb-zero']));
  check('undeclared minBase defaults to the current image version',
    idx.packages['mb-default'] && idx.packages['mb-default'].minBase === IMAGE_VERSION,
    JSON.stringify(idx.packages['mb-default']));
}

/* ---- REFUSAL: garbage never coerces into a claim ---- */
for (const [label, bad] of [
  ['a string', '42'],
  ['a negative number', -1],
  ['a non-integer', 1.5],
  ['above the current image version', IMAGE_VERSION + 1],
]) {
  const out = path.join(tmp, 'out-bad-' + label.replace(/[^a-z]+/g, '-'));
  const defs = writeDefs('defs-bad-' + label.replace(/[^a-z]+/g, '-'),
    [fixtureDef('mb-bad', bad)]);
  const r = mkpkg(out, defs);
  const all = (r.stdout || '') + (r.stderr || '');
  check(`minBase ${label} refuses the build`, r.status !== 0, 'exit=' + r.status);
  check(`minBase ${label} refusal names the package and the field`,
    all.includes('mb-bad') && all.includes('minBase'), all.slice(-400));
}

/* ---- LINT over the real definitions ---- */
// "Code-bearing" = the payload contains something the base must be able to
// run or compile: a wasm binary our pipeline built (project/c), a native
// sibling artifact (nativeApp), or in-OS-compiled source (srclib). Those
// floors track the CURRENT platform/sources and would rot as declared
// numbers, so they stay undeclared on purpose. Everything else is pure data
// with a stable mechanism floor and MUST carry an explicit claim.
const CODE_KEYS = ['project', 'c', 'nativeApp'];
function isCodeBearing(def) {
  if (def.srclib !== undefined) return true;
  return Object.values(def.files || {})
    .some((e) => e && typeof e === 'object' && CODE_KEYS.some((k) => k in e));
}
// Classifier controls: it must flag the shape we lint for and pass the
// shapes we exempt — without these, an empty or misread packages/ scan
// would report a clean lint that tested nothing.
check('classifier control: a pure-data def is not code-bearing',
  !isCodeBearing({ files: { 'a.ttf': { bin: 'x.ttf' }, pages: { tree: 'v/p' } } }));
check('classifier control: a project def is code-bearing',
  isCodeBearing({ files: { app: { project: 'v/bin.json' } } }));
check('classifier control: a srclib def is code-bearing',
  isCodeBearing({ files: { 'src/x': { tree: 'v/x' } }, srclib: { src: { x: 'src/x' } } }));

const names = fs.readdirSync(PKGS_DIR).filter((f) => f.endsWith('.json')).sort();
check('the packages/ scan is non-empty', names.length > 0, String(names.length));
let pureData = 0;
for (const f of names) {
  const def = JSON.parse(fs.readFileSync(path.join(PKGS_DIR, f), 'utf-8'));
  if (!isCodeBearing(def)) {
    pureData++;
    check(`pure-data package ${def.name} declares an explicit minBase`,
      def.minBase !== undefined, 'undeclared — it would silently inherit the current image version');
  }
  if (def.minBase !== undefined) {
    check(`${def.name}: declared minBase is an integer in [1, ${IMAGE_VERSION}]`,
      Number.isInteger(def.minBase) && def.minBase >= 1 && def.minBase <= IMAGE_VERSION,
      JSON.stringify(def.minBase));
  }
}
check('the lint saw at least one pure-data package (else it is vacuous)',
  pureData > 0, String(pureData));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll minBase checks passed');
process.exit(failures ? 1 : 0);
