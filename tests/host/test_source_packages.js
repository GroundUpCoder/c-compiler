#!/usr/bin/env node
'use strict';
// todos #407 — the mechanical `<name>-sources` companion packages.
//
// Guards the ONE rule (os-common sourcePackageDefs) that derives a source
// package per source-bearing unit, with no per-package hand edits:
//   - both derivations produce units: gucman-sources (an image binary — the
//     package manager itself, the one unit that can never move out of the
//     image, so this exemplar never needs re-pointing) and gcode-sources +
//     lua-sources (catalog packages; gcode was the image exemplar until
//     #578 shipped it as a package), each with the right version lineage
//     and its compile closure at repo paths
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

const gucman = byName.get('gucman-sources');
check('gucman-sources exists (image derivation)', gucman && gucman.kind === 'image');
check('gucman-sources version is the image version', gucman && gucman.def.version === imageVersion,
  gucman && gucman.def.version);
check('legacy image summary keeps the baked-history marker used by mkpkg',
  gucman && gucman.def.summary.includes(`(base image v${imageVersion})`),
  gucman && gucman.def.summary);
check('gucman-sources closure carries gucman.c + its project + cJSON',
  gucman && gucman.def.files['os/gucman/gucman.c'] !== undefined &&
  gucman.def.files['os/gucman/bin.json'] !== undefined &&
  gucman.def.files['vendor/cjson/cJSON.c'] !== undefined);

const gcode = byName.get('gcode-sources');
const gcodeDef = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'gcode.json'), 'utf-8'));
check('gcode-sources exists (package derivation — #578 pulled gcode out of the image)',
  gcode && gcode.kind === 'package');
check('gcode-sources version uses its explicit companion lineage',
  gcode && gcode.def.version === gcodeDef.sourcesVersion,
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
  // Derived from libc-ext.js, not hardcoded (#535): the original list pinned
  // the 6 launch units, so the 8 search.h-family units #111 added got ZERO
  // payload coverage while the test stayed green. The .c filter is
  // load-bearing — libc-ext.js also carries headers (search.h, tsearch.h),
  // which ride the merged HEADER map, not this assertion.
  const extMap = JSON.parse((() => {
    const t = fs.readFileSync(path.join(ROOT, 'libc-ext.js'), 'utf-8');
    return t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  })());
  const extC = Object.keys(extMap).filter((n) => n.endsWith('.c'));
  check('libc-ext.js yields a non-empty ext .c unit list (parse sanity)',
    extC.length > 0, String(extC.length));
  check(`libc-sources carries every ext .c unit BYTE-EQUAL to libc-ext.js (${extC.length} units)`,
    libc && extC.every((n) => libc.def.files[n] &&
      libc.def.files[n].content === extMap[n]),
    libc && JSON.stringify(extC.filter((n) => !libc.def.files[n])));
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
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet', `--out=${out}`, 'cc-sources'],
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

/* ---- #617: the closure follows textual #include — and REBUILDS ----------
 * The measured hole (#568 dogfood D1): busybox's `#include "x_template.c"`
 * idiom is listed nowhere (not a source, not a header under an include dir,
 * not a dep), so the -sources payload omitted it and the shipped sources
 * could not rebuild the shipped binary — while the bake never noticed,
 * because bake-time cc resolves includes against the full repo tree. The
 * fix follows quoted includes transitively in cc's resolution order. These
 * legs pin it three ways: the real-repo pins, a synthetic transitive
 * fixture, and — the leg whose absence let this ship — a real compile from
 * PAYLOAD-ONLY inputs in a hermetic dir. */

// Real-repo pins: the exact dogfooded miss, and the wholesale-headers miss.
check('#617: gcode closure carries the busybox template idiom',
  Object.prototype.hasOwnProperty.call(byName.get('gcode-sources').def.files,
    'vendor/busybox/src/libbb/xatonum_template.c'));
check('#617: doom closure carries its includer-relative sibling headers',
  Object.prototype.hasOwnProperty.call(byName.get('doom-sources').def.files,
    'vendor/doom/src/d_main.h'),
  'doom declares no include dir, so every header rides the include follower');

// Materialize a unit's payload (its def's bin entries, verbatim) into a
// hermetic dir and compile the named project from THOSE files only — the
// exact in-OS `gucman install <p>-sources` + `cc` loop, host-side.
function compileFromPayload(unit, srcRoot, projRel) {
  const her = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpkg-hermetic-'));
  try {
    for (const [rel, entry] of Object.entries(unit.def.files)) {
      const dst = path.join(her, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(srcRoot, entry.bin), dst);
    }
    const wasm = COMMON.buildProject(CompilerJS, projRel,
      (p) => fs.readFileSync(path.join(her, p), 'utf-8'));
    return wasm && wasm.length;
  } finally {
    fs.rmSync(her, { recursive: true, force: true });
  }
}

check('#617: 🔴 gcode REBUILDS from payload-only inputs (the dogfood loop, hermetic)', (() => {
  try { return compileFromPayload(byName.get('gcode-sources'), ROOT, 'os/gcode/bin.json') > 0; }
  catch (e) { console.log('         ' + String(e.message).split('\n').slice(0, 4).join('\n         ')); return false; }
})());

// Synthetic transitive fixture: a template chain two levels deep, an
// -I-resolved non-header include, and an include escaping the source root
// (must be SKIPPED, and must not poison the closure's escape validation).
{
  const fixRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'srcpkg-follow-'));
  const fix = path.join(fixRoot, 'repo');
  const wf = (rel, text) => {
    const p = path.join(fix, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  fs.writeFileSync(path.join(fixRoot, 'outside.c'), 'int outside;\n');   // exists, but OUTSIDE the root
  wf('libc-ext.js', 'var EXT_LIB_MAP = {};\n');
  wf('src/app/bin.json', JSON.stringify({
    bin: true, name: 'app', sources: ['app.c'], compilerArgs: ['-I../../inc'],
  }) + '\n');
  wf('src/app/app.c', [
    '#include "app_template.c"',
    // The follower is TEXTUAL — it sees through #if 0, which is exactly why
    // an unresolvable target must be a silent skip (cc never took the
    // branch) and an escaping one must be skipped, not shipped and not a
    // validation error. cc itself skips the block, so the hermetic compile
    // still proves the payload complete.
    '#if 0',
    '#include "../../../outside.c"',    // escapes the source root: never ship
    '#include "no_such_file.h"',        // unresolved anywhere: builtin/conditional shape
    '#endif',
    'int main(void) { return t_value() + I_VALUE; }',
    '',
  ].join('\n'));
  wf('src/app/app_template.c', [
    '#include "deep/nested.inc.c"',     // transitive, includer-relative
    '#include "only_in_incdir.c"',      // resolves via -I only
    'int t_value(void) { return NESTED; }',
    '',
  ].join('\n'));
  wf('src/app/deep/nested.inc.c', '#define NESTED 40\n');
  wf('inc/only_in_incdir.c', '#define I_VALUE 2\n');
  try {
    const fixUnits = COMMON.sourcePackageDefs(fs, path, fix, {
      CompilerJS,
      imageManifest: { version: 1, system: { files: { '/bin/app': { project: 'src/app/bin.json' } } } },
    });
    const app = fixUnits.find((u) => u.name === 'app-sources');
    const fset = Object.keys(app.def.files);
    check('#617: a template include rides the closure', fset.includes('src/app/app_template.c'), fset.join(','));
    check('#617: the follower is TRANSITIVE (template → nested include)',
      fset.includes('src/app/deep/nested.inc.c'), fset.join(','));
    check('#617: an -I-resolved non-header include rides the closure',
      fset.includes('inc/only_in_incdir.c'), fset.join(','));
    check('#617: an include escaping the source root is skipped, not shipped',
      !fset.some((f) => /outside\.c$/.test(f)), fset.join(','));
    check('#617: the synthetic unit also rebuilds payload-only', (() => {
      try { return compileFromPayload(app, fix, 'src/app/bin.json') > 0; }
      catch (e) { console.log('         ' + String(e.message).split('\n').slice(0, 4).join('\n         ')); return false; }
    })());
  } finally {
    fs.rmSync(fixRoot, { recursive: true, force: true });
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
