#!/usr/bin/env node
// Lane A (win32 source-lib design §1): filesystem resolution in the compiler,
// unit legs — no boot, no wasm run; the compiler library driven directly over
// an in-memory file map (parse + link only).
//
// Under test:
//   - PPRegistry.systemIncludePaths: a system-include tier searched AFTER the
//     builtin standardHeaders for both quote and angle includes; array order
//     is the tier order (/usr/local/include before /usr/include in-OS).
//   - The one security-relevant precedence: builtins ALWAYS beat ambient
//     system dirs; only an EXPLICIT -I may shadow a builtin (existing
//     semantics, kept). Quote includes keep same-dir-first.
//   - __require_source FS tiers: builtin -> libc-ext -> sourceRoots exact map
//     (prefix on the FIRST path component) -> sourcePaths search dirs.
//   - Name validation before any FS probe: relative [A-Za-z0-9._-]+
//     components only — '..'/'/'-leading/'\\'/empty components are LOUD
//     compile errors (the traversal seam).
//   - Path-identity dedup: a require whose resolved path is already a listed
//     TU (textually normalized) is skipped silently — the one-windows.h
//     enabler for host-vs-in-OS byte identity.
//   - buildProject/expandProjectJson srcRoots plumbing + --srcroot CLI flag
//     (conflicting remap of a namespace is loud).
//
// Run: node tests/kernel/test_cc_srclib.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(ROOT, 'os/os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Drive parseAllUnits (+ link) over an in-memory file map. `setup(pp)`
// configures the registry (system dirs, roots, -I). Returns {ok, err, units,
// linkErrors} — ok is parse success; linkErrors only meaningful when ok.
function compileMap(files, inputs, setup) {
  const pp = CompilerJS.createDefaultPPRegistry();
  let err = '';
  const writeErr = (s) => { err += s; };
  pp.fileReader = (p) => Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null;
  if (setup) setup(pp);
  const fsShim = {
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(p + ': No such file');
      return files[p];
    },
  };
  const options = {
    warningFlags: { pointerDecay: false, circularDependency: false, largeStackFrame: true },
    compilerOptions: { requireSources: [], backend: 'default' },
    writeErr,
  };
  try {
    const units = CompilerJS.parseAllUnits(fsShim, pp, inputs, options);
    const link = CompilerJS.linkTranslationUnits(units, options.compilerOptions);
    return { ok: true, err, units, linkErrors: link.errors };
  } catch (e) {
    if (!e.compilationFailed) throw e;
    return { ok: false, err, units: null, linkErrors: null };
  }
}

/* ---- defaults are empty (the byte-identity guarantee at the state level) ---- */
{
  const pp = CompilerJS.createDefaultPPRegistry();
  check('systemIncludePaths defaults empty', Array.isArray(pp.systemIncludePaths) && pp.systemIncludePaths.length === 0);
  check('sourceRoots defaults empty', Array.isArray(pp.sourceRoots) && pp.sourceRoots.length === 0);
  check('sourcePaths defaults empty', Array.isArray(pp.sourcePaths) && pp.sourcePaths.length === 0);
}

/* ---- system-include tier: angle + quote resolution, tier order ---- */
{
  const files = {
    '/app/main.c': '#include <mylib.h>\nint main(void){return MYLIB_TAG;}\n',
    '/sys1/mylib.h': '#define MYLIB_TAG 0\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.systemIncludePaths = ['/sys1', '/sys2']; });
  check('angle include resolves via systemIncludePaths', r.ok, r.err);
}
{
  const files = {
    '/app/main.c': '#include "mylib.h"\nint main(void){return MYLIB_TAG;}\n',
    '/sys1/mylib.h': '#define MYLIB_TAG 0\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.systemIncludePaths = ['/sys1']; });
  check('quote include resolves via systemIncludePaths', r.ok, r.err);
}
{
  // Tier order is array order: the first dir (the admin /usr/local/include
  // slot in-OS) shadows the second (the baked /usr/include slot).
  const files = {
    '/app/main.c': '#include <mylib.h>\n#if MYLIB_TAG != 1\n#error wrong tier won\n#endif\nint main(void){return 0;}\n',
    '/sys1/mylib.h': '#define MYLIB_TAG 1\n',
    '/sys2/mylib.h': '#define MYLIB_TAG 2\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.systemIncludePaths = ['/sys1', '/sys2']; });
  check('first system dir shadows the second (local-before-baked)', r.ok, r.err);
}
{
  // The security-relevant precedence: a planted stdio.h in a system dir must
  // NOT hijack the builtin.
  const files = {
    '/app/main.c': '#include <stdio.h>\nint main(void){printf("x");return 0;}\n',
    '/sys1/stdio.h': '#error planted stdio.h hijacked the builtin\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.systemIncludePaths = ['/sys1']; });
  check('builtin header beats ambient system dir', r.ok, r.err);
}
{
  // An EXPLICIT -I still shadows a builtin (existing semantics, kept).
  const files = {
    '/app/main.c': '#include <stdio.h>\n#ifndef MY_SHADOW\n#error -I did not shadow the builtin\n#endif\nint main(void){return 0;}\n',
    '/inc/stdio.h': '#define MY_SHADOW 1\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => {
    pp.includePaths.push('/inc');
    pp.systemIncludePaths = ['/sys1'];
  });
  check('explicit -I beats builtin (kept)', r.ok, r.err);
}
{
  // Quote include keeps same-dir-first even with system dirs configured.
  const files = {
    '/app/main.c': '#include "mylib.h"\n#if MYLIB_TAG != 7\n#error same-dir lost\n#endif\nint main(void){return 0;}\n',
    '/app/mylib.h': '#define MYLIB_TAG 7\n',
    '/sys1/mylib.h': '#define MYLIB_TAG 2\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.systemIncludePaths = ['/sys1']; });
  check('quote same-dir beats system tier', r.ok, r.err);
}
{
  // A header found in a system dir is a real TU citizen: its own quote
  // includes resolve relative to where it lives.
  const files = {
    '/app/main.c': '#include <mylib.h>\nint main(void){return MYLIB_INNER;}\n',
    '/sys1/mylib.h': '#include "mylib_inner.h"\n',
    '/sys1/mylib_inner.h': '#define MYLIB_INNER 0\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.systemIncludePaths = ['/sys1']; });
  check('system-dir header quote-includes its neighbors', r.ok, r.err);
}

/* ---- require resolution: sourceRoots exact map + sourcePaths search ---- */
const MAIN_REQ = '__require_source("mylib/impl.c");\nint mylib_fn(void);\nint main(void){return mylib_fn();}\n';
{
  const files = {
    '/app/main.c': MAIN_REQ,
    '/roots/mylib/impl.c': 'int mylib_fn(void){return 1;}\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => {
    pp.sourceRoots = [{ prefix: 'mylib', dir: '/roots/mylib' }];
  });
  check('require resolves via sourceRoots exact map', r.ok && r.linkErrors.length === 0,
    r.err + JSON.stringify(r.linkErrors || null));
}
{
  const files = {
    '/app/main.c': MAIN_REQ,
    '/sp1/mylib/impl.c': 'int mylib_fn(void){return 1;}\n',
    '/sp2/mylib/impl.c': '#error second search dir must not win\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.sourcePaths = ['/sp1', '/sp2']; });
  check('sourcePaths searched in order (first hit wins)', r.ok && r.linkErrors.length === 0, r.err);
}
{
  // sourceRoots (exact map) is probed before the sourcePaths search.
  const files = {
    '/app/main.c': MAIN_REQ,
    '/roots/mylib/impl.c': 'int mylib_fn(void){return 1;}\n',
    '/sp1/mylib/impl.c': '#error sourcePaths must not win over sourceRoots\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => {
    pp.sourceRoots = [{ prefix: 'mylib', dir: '/roots/mylib' }];
    pp.sourcePaths = ['/sp1'];
  });
  check('sourceRoots tier beats sourcePaths tier', r.ok && r.linkErrors.length === 0, r.err);
}
{
  // A builtin require name planted on the FS still resolves builtin:
  // __alloca.c is auto-required by EVERY compile — a poisoned FS twin would
  // break this compile if the FS tier were consulted first.
  const files = {
    '/app/main.c': 'int main(void){return 0;}\n',
    '/sp1/__alloca.c': '#error planted __alloca.c hijacked the builtin\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.sourcePaths = ['/sp1']; });
  check('builtin require name beats FS tiers', r.ok, r.err);
}
{
  // Transitive drain: an FS-resolved TU's own __require_source joins the
  // drain, and its quote includes resolve beside its resolved path.
  const files = {
    '/app/main.c': MAIN_REQ,
    '/roots/mylib/impl.c': '__require_source("mylib/impl2.c");\n#include "impl_priv.h"\nint mylib_fn2(void);\nint mylib_fn(void){return IMPL_PRIV + mylib_fn2();}\n',
    '/roots/mylib/impl_priv.h': '#define IMPL_PRIV 1\n',
    '/roots/mylib/impl2.c': 'int mylib_fn2(void){return 2;}\n',
  };
  const r = compileMap(files, ['/app/main.c'], (pp) => {
    pp.sourceRoots = [{ prefix: 'mylib', dir: '/roots/mylib' }];
  });
  check('FS-resolved TU: transitive requires + same-dir quote includes', r.ok && r.linkErrors.length === 0,
    r.err + JSON.stringify(r.linkErrors || null));
}

/* ---- name validation (the security seam): loud errors, not silent misses ---- */
for (const bad of ['../../etc/shadow.c', '/etc/passwd', 'a/../b.c', 'a\\b.c', 'a//b.c', './x.c']) {
  const files = { '/app/main.c': `__require_source("${bad.replace(/\\/g, '\\\\')}");\nint main(void){return 0;}\n` };
  const r = compileMap(files, ['/app/main.c'], (pp) => { pp.sourcePaths = ['/sp1']; });
  check(`invalid require name rejected loud: ${JSON.stringify(bad)}`,
    !r.ok && r.err.includes('invalid required source name'), r.err.slice(0, 200));
}

/* ---- unknown require name: diagnostic names the searched tiers ---- */
{
  const files = { '/app/main.c': '__require_source("nolib/none.c");\nint main(void){return 0;}\n' };
  const r = compileMap(files, ['/app/main.c'], (pp) => {
    pp.sourceRoots = [{ prefix: 'nolib', dir: '/roots/nolib' }];
    pp.sourcePaths = ['/sp1'];
  });
  check('unknown require: error lists searched locations',
    !r.ok && r.err.includes('unknown required source nolib/none.c')
      && r.err.includes('/roots/nolib') && r.err.includes('/sp1'), r.err.slice(0, 300));
}
{
  const files = { '/app/main.c': '__require_source("nolib/none.c");\nint main(void){return 0;}\n' };
  const r = compileMap(files, ['/app/main.c'], null);
  check('unknown require with no tiers configured says so',
    !r.ok && r.err.includes('no source roots or source paths configured'), r.err.slice(0, 300));
}

/* ---- path-identity dedup: explicit TU + require of the same path ---- */
{
  const files = {
    '/app/main.c': MAIN_REQ,
    '/roots/mylib/impl.c': 'int mylib_fn(void){return 1;}\n',
  };
  // impl.c listed as an explicit input AND required by main.c: compiled once
  // (a double compile would be a duplicate-definition link error).
  const r = compileMap(files, ['/app/main.c', '/roots/mylib/impl.c'], (pp) => {
    pp.sourceRoots = [{ prefix: 'mylib', dir: '/roots/mylib' }];
  });
  check('dedup: explicit TU + require of same path compiles once',
    r.ok && r.linkErrors.length === 0 && r.units.length === 3 /* main + impl + __alloca */,
    r.err + ' units=' + (r.units ? r.units.length : '-') + ' ' + JSON.stringify(r.linkErrors || null));
}
{
  // Dedup is on TEXTUALLY NORMALIZED paths: a denormalized spelling of the
  // same input file still collapses.
  const files = {
    '/app/main.c': MAIN_REQ,
    '/roots/./mylib//impl.c': 'int mylib_fn(void){return 1;}\n',   // the shim map is literal-keyed
  };
  files['/roots/mylib/impl.c'] = files['/roots/./mylib//impl.c'];
  const r = compileMap(files, ['/app/main.c', '/roots/./mylib//impl.c'], (pp) => {
    pp.sourceRoots = [{ prefix: 'mylib', dir: '/roots/mylib' }];
  });
  check('dedup normalizes ./ and // spellings', r.ok && r.linkErrors.length === 0,
    r.err + JSON.stringify(r.linkErrors || null));
}

/* ---- buildProject srcRoots plumbing (os-common.js) ---- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srclib-bp-'));
  fs.mkdirSync(path.join(tmp, 'proj/mylib'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'proj/main.c'), MAIN_REQ);
  fs.writeFileSync(path.join(tmp, 'proj/mylib/impl.c'), 'int mylib_fn(void){return 1;}\n');
  fs.writeFileSync(path.join(tmp, 'proj/bin.json'), JSON.stringify({
    name: 'srclibdemo', sources: ['main.c', 'mylib/impl.c'], srcRoots: { mylib: 'mylib' },
  }));
  const readHostFile = (p) => fs.readFileSync(path.join(tmp, p), 'utf-8');
  let wasm = null, err = null;
  try { wasm = COMMON.buildProject(CompilerJS, 'proj/bin.json', readHostFile); }
  catch (e) { err = e.message; }
  check('buildProject: srcRoots registers + require dedups against listed TU',
    wasm !== null && wasm.length > 0, err);

  // Conflicting remap of the same namespace across dep jsons throws loud.
  fs.writeFileSync(path.join(tmp, 'proj/dep.json'), JSON.stringify({
    name: 'dep', type: 'lib', sources: [], srcRoots: { mylib: '.' },
  }));
  fs.writeFileSync(path.join(tmp, 'proj/bin2.json'), JSON.stringify({
    name: 'srclibdemo2', deps: ['dep.json'], sources: ['main.c'], srcRoots: { mylib: 'mylib' },
  }));
  let conflictMsg = null;
  try { COMMON.buildProject(CompilerJS, 'proj/bin2.json', readHostFile); }
  catch (e) { conflictMsg = e.message; }
  check('buildProject: conflicting srcRoot remap throws',
    conflictMsg !== null && conflictMsg.includes('conflicting srcRoot remap'), conflictMsg);

  // Same ns -> same dir from two jsons (diamond) dedups silently.
  fs.writeFileSync(path.join(tmp, 'proj/dep2.json'), JSON.stringify({
    name: 'dep2', type: 'lib', sources: [], srcRoots: { mylib: 'mylib' },
  }));
  fs.writeFileSync(path.join(tmp, 'proj/bin3.json'), JSON.stringify({
    name: 'srclibdemo3', deps: ['dep2.json'], sources: ['main.c'], srcRoots: { mylib: 'mylib' },
  }));
  let wasm3 = null, err3 = null;
  try { wasm3 = COMMON.buildProject(CompilerJS, 'proj/bin3.json', readHostFile); }
  catch (e) { err3 = e.message; }
  check('buildProject: same-dir srcRoot re-declaration is a no-op', wasm3 !== null, err3);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---- CLI: --srcroot flag + project-json srcRoots expansion ---- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srclib-cli-'));
  fs.mkdirSync(path.join(tmp, 'mylib'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'main.c'), MAIN_REQ);
  fs.writeFileSync(path.join(tmp, 'mylib/impl.c'), 'int mylib_fn(void){return 1;}\n');
  const compilerPath = path.join(ROOT, 'compiler.js');

  let r = cp.spawnSync('node', [compilerPath, '--srcroot', 'mylib=' + path.join(tmp, 'mylib'),
    '-o', path.join(tmp, 'a.wasm'), path.join(tmp, 'main.c')], { encoding: 'utf8', timeout: 120000 });
  check('CLI --srcroot resolves a require', r.status === 0, (r.stderr || '').slice(0, 300));

  r = cp.spawnSync('node', [compilerPath,
    '--srcroot', 'mylib=' + path.join(tmp, 'mylib'),
    '--srcroot', 'mylib=' + tmp,
    '-o', path.join(tmp, 'b.wasm'), path.join(tmp, 'main.c')], { encoding: 'utf8', timeout: 120000 });
  check('CLI conflicting --srcroot remap fails loud',
    r.status === 1 && (r.stderr || '').includes('conflicting --srcroot remap'), (r.stderr || '').slice(0, 300));

  // Project-json expansion: lib.json srcRoots flow through expandProjectJson.
  fs.writeFileSync(path.join(tmp, 'proj.json'), JSON.stringify({
    name: 'clidemo', sources: ['main.c', 'mylib/impl.c'], srcRoots: { mylib: 'mylib' },
  }));
  r = cp.spawnSync('node', [compilerPath, '-o', path.join(tmp, 'c.wasm'), path.join(tmp, 'proj.json')],
    { encoding: 'utf8', timeout: 120000 });
  check('CLI project json srcRoots expands + dedups', r.status === 0, (r.stderr || '').slice(0, 300));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
