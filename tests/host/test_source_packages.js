#!/usr/bin/env node
'use strict';
// todos #407 — the mechanical `<name>-sources` companion packages.
//
// Guards the ONE rule (os-common sourcePackageDefs) that derives a source
// package per source-bearing unit, with no per-package hand edits:
//   - both derivations produce units: gcode-sources (an image binary — the
//     jku acceptance demo) and lua-sources (a catalog package), each with
//     the right version lineage and its compile closure at repo paths
//   - the exclusions are mechanical, not a hand list: a source-only package
//     (win32), a data package (font-unifont), a seed package
//     (netsurf-demos), and every native-sibling-gated def get NO unit
//   - every def is uniform: name = <parent>-sources, minBase 0,
//     srclib {src:{<parent>:'.'}}, every file a repo-mirroring bin entry
//   - the synthesis is deterministic (same tree -> same defs)
//   - srclib.src accepts '.' (the payload root, #407) end to end:
//     validator, the /usr/src fold twin, and a real mkpkg build whose
//     control.json carries the section and whose payload carries the
//     closure members
//
// Run: node tests/host/test_source_packages.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '../..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function throws(name, fn, re) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, re.test(String(e.message)), String(e.message)); }
}

/* ---- the synthesis rule ---- */
const units = COMMON.sourcePackageDefs(fs, path, ROOT, { CompilerJS });
const byName = new Map(units.map((u) => [u.name, u]));
const imageVersion = String(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8')).version | 0);

const gcode = byName.get('gcode-sources');
check('gcode-sources exists (image derivation)', gcode && gcode.kind === 'image');
check('gcode-sources version is the image version', gcode && gcode.def.version === imageVersion,
  gcode && gcode.def.version);
check('gcode-sources closure carries gcode.c + its project + cJSON',
  gcode && gcode.def.files['os/gcode/gcode.c'] !== undefined &&
  gcode.def.files['os/gcode/bin.json'] !== undefined &&
  gcode.def.files['vendor/cjson/cJSON.c'] !== undefined);

const lua = byName.get('lua-sources');
const luaVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'lua.json'), 'utf-8')).version;
check('lua-sources exists (package derivation)', lua && lua.kind === 'package');
check('lua-sources version is the lua package version', lua && lua.def.version === luaVer,
  lua && lua.def.version);
check('lua-sources closure carries the interpreter source',
  lua && Object.keys(lua.def.files).some((f) => f === 'vendor/lua/src/lua.c'));

check('win32 (source-only package) gets NO unit', !byName.has('win32-sources'));
check('font-unifont (data package) gets NO unit', !byName.has('font-unifont-sources'));
check('netsurf-demos (seed package) gets NO unit', !byName.has('netsurf-demos-sources'));
check('no gated (-clang/-rust) def gets a unit',
  units.every((u) => !/-(clang|rust)-sources$/.test(u.name)),
  units.map((u) => u.name).filter((n) => /-(clang|rust)-sources$/.test(n)).join(','));

check('every unit is uniform (name/minBase/srclib; bin-mirror or builtin-content files)', units.every((u) => {
  const d = u.def;
  // The 'builtin' derivation (#439) carries generated `content` entries —
  // its source is compiler.js's literal maps, not repo files; the repo
  // derivations stay strict bin mirrors.
  const filesOk = u.kind === 'builtin'
    ? Object.keys(d.files).every((rel) => typeof d.files[rel].content === 'string')
    : Object.keys(d.files).every((rel) => d.files[rel].bin === rel);
  return d.name === u.parent + '-sources' && d.minBase === 0 &&
    JSON.stringify(d.srclib) === JSON.stringify({ src: { [u.parent]: '.' } }) &&
    Object.keys(d.files).length > 0 && filesOk;
}));
check('synthesis is deterministic',
  JSON.stringify(units) === JSON.stringify(COMMON.sourcePackageDefs(fs, path, ROOT, { CompilerJS })));

/* ---- the 'builtin' derivation (#439): the compiler's own libc ---- */
const libc = byName.get('libc-sources');
check('libc-sources exists (builtin derivation)', libc && libc.kind === 'builtin');
check('libc-sources version is the image version', libc && libc.def.version === imageVersion,
  libc && libc.def.version);
check('libc-sources inputs name the literal-map files',
  libc && JSON.stringify(libc.inputs) === JSON.stringify(['compiler.js', 'libc-ext.js']),
  libc && JSON.stringify(libc.inputs));
{
  const hdrs = COMMON.stdlibHeaderMap(CompilerJS);
  const srcs = CompilerJS.getStdlibSources();
  check('libc-sources carries every merged header BYTE-EQUAL to the compiler map',
    libc && [...hdrs.keys()].every((n) => libc.def.files[n] &&
      libc.def.files[n].content === hdrs.get(n)));
  check('libc-sources carries every builtin .c unit BYTE-EQUAL to the compiler map',
    libc && Object.keys(srcs).every((n) => libc.def.files[n] &&
      libc.def.files[n].content === srcs[n]));
  check('libc-sources carries the ext .c units (TRE regex engine et al)',
    libc && ['fnmatch.c', 'glob.c', 'regcomp.c', 'regexec.c', 'regerror.c', 'tre-mem.c']
      .every((n) => libc.def.files[n] && libc.def.files[n].content.length > 0));
}
check('sourcePackageDefs without CompilerJS fails loud (never a silently smaller index)', (() => {
  try { COMMON.sourcePackageDefs(fs, path, ROOT, {}); return false; }
  catch (e) { return /CompilerJS is required/.test(String(e.message)); }
})());

/* ---- srclib.src '.' (the payload root) ---- */
check('validateSrclibShape accepts a payload-root namespace', (() => {
  const v = COMMON.validateSrclibShape({ src: { gcode: '.' } }, 't');
  return v.src.gcode === '.';
})());
throws('validateSrclibShape still refuses a bad namespace',
  () => COMMON.validateSrclibShape({ src: { 'Bad.Name': '.' } }, 't'), /must match/);
throws('validateSrclibShape still refuses an escaping dir',
  () => COMMON.validateSrclibShape({ src: { x: '../out' } }, 't'), /bad srclib src dir/);
check('packageControl carries the payload-root srclib', (() => {
  const c = COMMON.packageControl({ name: 'x', version: '1', srclib: { src: { x: '.' } } }, 't');
  return c.srclib && c.srclib.src.x === '.';
})());

/* ---- the fold twin ---- */
const foldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srcfold-'));
try {
  fs.writeFileSync(path.join(foldDir, 'srcdemo.json'), JSON.stringify({
    name: 'srcdemo', version: '1', summary: 't',
    files: { 'a/f.txt': { content: 'hi\n' } },
    srclib: { src: { srcdemo: '.' } },
  }));
  const manifest = { version: 1, system: { dirs: [], files: {} } };
  const folded = COMMON.foldPackages(fs, path, ROOT, manifest, ['srcdemo'],
    { packagesDir: foldDir }).manifest;
  const link = folded.system.files['/usr/src/srcdemo'];
  check('fold plants the /usr/src browse twin at the payload root',
    link && link.link === '/usr/opt/srcdemo', JSON.stringify(link));
  check('fold adds the /usr/src tier dir', folded.system.dirs.includes('/usr/src'));

  fs.writeFileSync(path.join(foldDir, 'srcbad.json'), JSON.stringify({
    name: 'srcbad', version: '1', summary: 't',
    files: { 'a/f.txt': { content: 'hi\n' } },
    srclib: { src: { srcbad: 'missing' } },
  }));
  throws('fold refuses a src dir not in the payload',
    () => COMMON.foldPackages(fs, path, ROOT, { version: 1, system: { dirs: [], files: {} } },
      ['srcbad'], { packagesDir: foldDir }), /srclib src dir missing is not in the payload/);
} finally {
  fs.rmSync(foldDir, { recursive: true, force: true });
}

/* ---- one real mkpkg build of a synthesized unit (cc-sources: 1 file) ---- */
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpkg-'));
try {
  const r = cp.spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet', `--out=${out}`, 'cc-sources'],
    { encoding: 'utf-8', timeout: 120000 });
  check('mkpkg builds cc-sources', r.status === 0, String(r.stderr));
  const idx = JSON.parse(fs.readFileSync(path.join(out, 'index.json'), 'utf-8'));
  const ent = idx.packages['cc-sources'];
  check('index entry has minBase 0', ent && ent.minBase === 0, JSON.stringify(ent));
  const tar = zlib.gunzipSync(fs.readFileSync(path.join(out, ent.payload.url)));
  const names = [];
  let control = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const nm = tar.slice(off, off + 100).toString('utf-8').replace(/\0.*$/, '');
    if (!nm) break;
    const size = parseInt(tar.slice(off + 124, off + 136).toString('ascii'), 8) || 0;
    names.push(nm);
    if (nm === 'control.json') control = JSON.parse(tar.slice(off + 512, off + 512 + size).toString('utf-8'));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  check('payload carries the closure at repo paths', names.includes('opt/cc-sources/os/cc.c'), names.join(','));
  check('control.json carries srclib {src:{cc:"."}}',
    control && control.srclib && JSON.stringify(control.srclib.src) === JSON.stringify({ cc: '.' }),
    JSON.stringify(control && control.srclib));
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
