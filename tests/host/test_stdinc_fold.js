#!/usr/bin/env node
'use strict';
// Ticket #439 — baked standard-library headers (/usr/include).
//
// Guards the fold that plants the compiler's MERGED builtin-header map into
// the system image at the one bake choke point (os-common foldStdlibHeaders,
// called by bakeSystemImage):
//   - the planted set is EXACTLY the merged map (builtins + libc-ext.js's .h
//     entries), every entry byte-equal — generated, never hand-copied, so it
//     cannot drift from what `#include <...>` actually resolves (hazard 1)
//   - dirs derive parent-before-child (/usr/include, sys/, SDL3/, SDL3_image/)
//   - collisions with existing image entries throw loudly, both a file at a
//     header path and a file squatting a derived dir path (hazard 2)
//   - a folded srclib package (the /usr/include symlink-farm tier) coexists:
//     disjoint tops, no claim clash — verified against every shipped package
//   - a merged map MISSING the ext headers fails the bake loud (a silently
//     environment-dependent /usr/include is the failure mode, not a fallback)
//
// Run: node tests/host/test_stdinc_fold.js
const fs = require('fs');
const path = require('path');
const os = require('os');

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

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
const hdrs = COMMON.stdlibHeaderMap(CompilerJS);

/* ---- the merged map itself ---- */
check('merged map carries the builtin surface (stdio.h/stdlib.h/sys/stat.h/SDL3/SDL.h)',
  ['stdio.h', 'stdlib.h', 'string.h', 'sys/stat.h', 'SDL3/SDL.h', 'webgpu.h', 'guc.h']
    .every((n) => hdrs.has(n)));
check('merged map carries the ext headers (libc-ext.js loaded)',
  ['regex.h', 'fnmatch.h', 'glob.h'].every((n) => hdrs.has(n)));

/* ---- the fold on the real manifest ---- */
const folded = COMMON.foldStdlibHeaders(manifest, CompilerJS);
const planted = Object.keys(folded.system.files)
  .filter((p) => p.startsWith('/usr/include/'));
check('every merged-map header is planted at /usr/include, byte-equal (hazard 1)',
  [...hdrs.keys()].every((n) =>
    folded.system.files['/usr/include/' + n] &&
    folded.system.files['/usr/include/' + n].content === hdrs.get(n)));
check('nothing EXTRA is planted (the set is exactly the map)',
  planted.length === hdrs.size, planted.length + ' vs ' + hdrs.size);
check('subdirs derive parent-before-child', (() => {
  const dirs = folded.system.dirs;
  const i = dirs.indexOf('/usr/include');
  return i >= 0 && ['/usr/include/sys', '/usr/include/SDL3', '/usr/include/SDL3_image']
    .every((d) => dirs.indexOf(d) > i);
})(), JSON.stringify(folded.system.dirs.filter((d) => d.startsWith('/usr/include'))));
check('the input manifest is not mutated',
  !Object.keys(manifest.system.files).some((p) => p.startsWith('/usr/include/')));

/* ---- collisions throw (hazard 2) ---- */
{
  const m = JSON.parse(JSON.stringify(manifest));
  m.system.files['/usr/include/stdio.h'] = { content: 'liar\n' };
  throws('a pre-existing entry at a header path throws',
    () => COMMON.foldStdlibHeaders(m, CompilerJS), /conflicts with an existing image entry/);
}
{
  const m = JSON.parse(JSON.stringify(manifest));
  m.system.files['/usr/include/sys'] = { link: '/somewhere' };
  throws('a pre-existing entry squatting a derived dir path throws',
    () => COMMON.foldStdlibHeaders(m, CompilerJS), /conflicts with an existing image entry/);
}

/* ---- coexistence with the srclib symlink-farm tier ---- */
{
  // Fold a real srclib package first (the fat-image order: packages fold
  // before the bake-time header fold), then the headers — both claim under
  // /usr/include; the tops must stay disjoint and the fold silent.
  const withPkg = COMMON.foldPackages(fs, path, ROOT, manifest, ['libpng']).manifest;
  const both = COMMON.foldStdlibHeaders(withPkg, CompilerJS);
  check('srclib package tops (png.h) and baked headers (stdio.h) coexist',
    both.system.files['/usr/include/png.h'] !== undefined &&
    both.system.files['/usr/include/stdio.h'] !== undefined);
  // ...and against EVERY shipped package def at once (the fat bake).
  const all = COMMON.foldPackages(fs, path, ROOT, manifest, 'all').manifest;
  let ok = true, msg = '';
  try { COMMON.foldStdlibHeaders(all, CompilerJS); }
  catch (e) { ok = false; msg = String(e.message); }
  check('claim() stays silent across ALL shipped packages (hazard 2)', ok, msg);
}

/* ---- a map missing the ext headers fails loud ---- */
throws('a merged map missing the ext headers fails the bake loud', () => {
  const fake = {
    createDefaultPPRegistry: () => ({
      standardHeaders: new Map([['stdio.h', 'x']]),
      extProvidedHeaders: ['regex.h', 'fnmatch.h', 'glob.h'],
    }),
  };
  COMMON.foldStdlibHeaders({ version: 1, system: { dirs: [], files: {} } }, fake);
}, /libc-ext\.js was not loaded/);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
process.exit(failures ? 1 : 0);
