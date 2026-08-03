'use strict';
// The 0082 bake-input closure must cover a project's OUT-OF-DIRECTORY
// sources/includes, not just its `deps` (todos/0354).
//
// `newestBakeInput` expanded a project through `deps` and walked the project's
// own directory — nothing else. buildProject also pulls TUs in through
// `sources` and headers through `includes`/`srcRoots`/`-I`, and those paths may
// point anywhere in the repo. `vendor/cjson/cJSON.c` is exactly that shape: no
// bin.json of its own, compiled straight into five seeded binaries. So editing
// it changed five baked binaries while boot.js, serve.js and
// tests/lib/image-fixture.js all read the blob FRESH and reused it — an edit
// that silently does not take effect, which is the precise failure the 0082
// gate exists to prevent.
//
// Two legs, both of which FAIL on the pre-0354 os-common.js:
//   A. synthetic-tree red control — the general property, no vendor tree
//      involved: a file reached only via `sources` (and a header reached only
//      via `includes`) from outside the project dir must become the newest
//      bake input when it is the newest file on disk.
//   B. real-repo closure — instrument newestBakeInput's fs access against the
//      actual os/image.json and assert vendor/cjson is inside the closure,
//      then re-derive every project's escaping sources/includes INDEPENDENTLY
//      (this file's own expander, not os-common's) and assert the scan reached
//      all of them. Leg B is the standing sweep: a bin.json that starts
//      reaching into a new tree tomorrow is caught here, not by a re-audit.
//
// Plus the twin's red control (todos/0363): newestPkgInput — mkpkg's
// package-payload freshness gate, extracted to os-common so it can be pointed
// at a synthetic tree — gets one leg PER INPUT CLASS it claims to cover
// (definition, toolchain, project dir, deps recursion, external sources,
// bin/text/c+hdrs assets, tree enumeration, sibling overlay, extraInputs),
// each of which fails on a scan with that class removed, plus the
// narrow-scope pin (the os/ tree at large must NOT be an input — synthetic
// AND real-repo legs) and a real-repo entry-kind sweep so a new `files`
// vocabulary word cannot ship without a leg here.
//
//   node tests/host/test_bakeinput_sources.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

/* ---- leg A: synthetic tree ---------------------------------------------
 * A miniature repo with one seeded project whose inputs deliberately live
 * outside its directory. newestBakeInput is fully parameterized on rootDir,
 * so this needs no fixture and no bake. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bakeinput-'));
const w = (rel, text) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

w('compiler.js', '// toolchain\n');
w('host.js', '// toolchain\n');
w('os/myapp/bin.json', JSON.stringify({
  bin: true,
  name: 'myapp',
  includes: ['../../ext/inc'],
  sources: ['app.c', '../../ext/lib/ext.c'],
}, null, 2) + '\n');
w('os/myapp/app.c', 'int main(void){return 0;}\n');
const EXT_C = w('ext/lib/ext.c', 'int ext(void){return 1;}\n');
const EXT_H = w('ext/lib/ext.h', '#define EXT 1\n');   // beside the source, quoted-include reach
const INC_H = w('ext/inc/hdr.h', '#define HDR 1\n');
const OUTSIDE = w('unrelated/nothing.c', 'int nothing;\n');   // in no project's closure

const MANIFEST = { version: 1, system: { files: { '/bin/myapp': { project: 'os/myapp/bin.json' } } } };

// Age everything, then make one file the unambiguous newest.
const OLD = Date.now() - 60 * 60 * 1000;
const ageAll = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ageAll(p);
    else fs.utimesSync(p, OLD / 1000, OLD / 1000);
  }
};
const newestFor = (file) => {
  ageAll(tmp);
  const t = Date.now() + 5000;   // strictly newer than every other file
  fs.utimesSync(file, t / 1000, t / 1000);
  return COMMON.newestBakeInput(fs, path, tmp, MANIFEST);
};

check('a source outside the project dir is a bake input', () => {
  const r = newestFor(EXT_C);
  assert.strictEqual(r.path, EXT_C,
    'newest bake input should be the touched out-of-dir source, got ' + r.path);
});

check('a header beside that source is a bake input (dir granularity)', () => {
  const r = newestFor(EXT_H);
  assert.strictEqual(r.path, EXT_H,
    'a quoted include resolves beside its source; got ' + r.path);
});

check('an `includes` dir outside the project dir is a bake input', () => {
  const r = newestFor(INC_H);
  assert.strictEqual(r.path, INC_H,
    'newest bake input should be the touched out-of-dir header, got ' + r.path);
});

check('the closure does not swallow the whole repo', () => {
  const r = newestFor(OUTSIDE);
  assert.notStrictEqual(r.path, OUTSIDE,
    'a file no project references must stay OUT of the closure — a scan that ' +
    'invalidates on everything is not a freshness gate');
});

/* ---- leg B: the real repo ---------------------------------------------- */

// Record every path the scan touches, delegating to the real fs.
const statted = new Set(), listed = new Set();
const rel = (p) => path.relative(ROOT, p);
const spy = {
  statSync: (p) => { statted.add(rel(p)); return fs.statSync(p); },
  readdirSync: (p, o) => { listed.add(rel(p)); return fs.readdirSync(p, o); },
  realpathSync: (p) => fs.realpathSync(p),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  lstatSync: (p) => fs.lstatSync(p),
};

const rawManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
// The FAT manifest: tests/lib/image-fixture.js bakes `--packages=all`, so the
// fixture every kernel e2e and browser boot uses depends on the package
// closure too. Scan what that fixture actually depends on.
const manifest = COMMON.foldPackages(fs, path, ROOT, rawManifest, 'all').manifest;
COMMON.newestBakeInput(spy, path, ROOT, manifest);

check('vendor/cjson is inside the bake-input closure', () => {
  assert.ok(statted.has('vendor/cjson/cJSON.c'),
    'cJSON.c is compiled into five seeded binaries; the freshness scan must see it');
  assert.ok(statted.has('vendor/cjson/cJSON.h'),
    'cJSON.h changes the same five binaries');
});

check('os/ runtime-only files stay excluded', () => {
  // gucman's `includes: [".."]` reaches the os root — enrolling it must not
  // smuggle os.html/boot.js/the workers back in as "inputs".
  for (const f of ['os/os.html', 'os/boot.js', 'os/kernel-worker.js',
                   'os/process-worker.js', 'os/compositor.js']) {
    assert.ok(!statted.has(f), f + ' is runtime-only and must not restale the blob');
  }
});

check('every escaping source/include in the manifest closure is covered', () => {
  // Independent re-derivation: this expander shares no code with
  // newestBakeInput, so it can disagree with it.
  const norm = (p) => {
    const out = [];
    p.split('/').forEach((s) => {
      if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop();
      else if (s !== '.') out.push(s);
    });
    return out.join('/');
  };
  const seen = new Set();
  const missing = [];
  const inside = (p, dir) => p === dir || p.startsWith(dir + '/');
  // A dir counts as covered when the scan listed it or any ancestor of it
  // (walk recurses, so listing an ancestor covers the subtree).
  const dirCovered = (d) => {
    for (let p = d; p; p = p.slice(0, p.lastIndexOf('/')) ) {
      if (listed.has(p)) return true;
      if (p.indexOf('/') < 0) break;
    }
    return listed.has(d);
  };
  const expand = (relPath) => {
    const n = norm(relPath);
    if (seen.has(n)) return;
    seen.add(n);
    const dir = n.slice(0, n.lastIndexOf('/'));
    let proj;
    try { proj = JSON.parse(fs.readFileSync(path.join(ROOT, n), 'utf-8')); } catch (e) { return; }
    (proj.deps || []).forEach((d) => expand(dir + '/' + d));
    (proj.sources || []).forEach((s) => {
      const f = norm(dir + '/' + s);
      if (!inside(f, dir) && !statted.has(f)) missing.push(n + ' sources ' + f);
    });
    (proj.includes || []).forEach((i) => {
      const d = norm(dir + '/' + i);
      if (!inside(d, dir) && !dirCovered(d)) missing.push(n + ' includes ' + d);
    });
    Object.keys(proj.srcRoots || {}).forEach((ns) => {
      const d = norm(dir + '/' + proj.srcRoots[ns]);
      if (!inside(d, dir) && !dirCovered(d)) missing.push(n + ' srcRoots ' + d);
    });
    (proj.compilerArgs || []).forEach((a) => {
      if (a.indexOf('-I') !== 0) return;
      const d = norm(dir + '/' + a.slice(2));
      if (!inside(d, dir) && !dirCovered(d)) missing.push(n + ' -I ' + d);
    });
  };
  const files = (COMMON.foldDesktopDefaults(manifest).system || {}).files || {};
  Object.keys(files).forEach((fp) => {
    if (files[fp].project !== undefined) expand(files[fp].project);
  });
  assert.ok(seen.size > 20, 'expanded only ' + seen.size + ' projects — the manifest closure did not load');
  assert.deepStrictEqual(missing, [],
    'these project inputs live outside their project dir and the scan never saw them');
});

/* ---- leg C: newestPkgInput, synthetic tree (todos/0363) ----------------
 * One package definition exercising every input class the scan claims to
 * cover. Each check makes ONE file the unambiguous newest on disk and
 * asserts the scan finds exactly it — so a scan with that input class
 * removed fails that leg (verified red at landing time by neutering each
 * class in turn). */
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pkginput-'));
const w2 = (rel, text) => {
  const p = path.join(tmp2, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

const P_COMPILER = w2('compiler.js', '// toolchain\n');
const P_MKPKG = w2('tools/mkpkg.js', '// tar+control encoding\n');
const P_OSCOMMON = w2('os/os-common.js', '// packageControl/buildProject\n');
const P_DEF = w2('packages/mypkg.json', '{}\n');   // content read via `pkg` param; mtime is the input
w2('vendor/myproj/bin.json', JSON.stringify({
  bin: true, name: 'myproj',
  deps: ['../mydep/lib.json'],
  sources: ['main.c', '../../shared/util.c'],
}, null, 2) + '\n');
const P_MAIN = w2('vendor/myproj/main.c', 'int main(void){return 0;}\n');
w2('vendor/mydep/lib.json', JSON.stringify({ name: 'mydep', sources: ['dep.c'] }, null, 2) + '\n');
const P_DEP = w2('vendor/mydep/dep.c', 'int dep(void){return 2;}\n');
const P_EXT = w2('shared/util.c', 'int util(void){return 3;}\n');   // reached ONLY via sources escape (0354)
const P_BIN = w2('assets/blob.bin', 'BLOB\n');
const P_TEXT = w2('os/motd.txt', 'hello\n');
const P_C = w2('os/tool.c', 'int tool(void){return 4;}\n');
const P_HDR = w2('os/tool.h', '#define TOOL 4\n');
const P_TREE = w2('treedir/sub/file.x', 'tree payload\n');
const P_OVERLAY = w2('overlay/overlay.json', '{"overlay":1}\n');
const P_SYNTH = w2('synth/parent.json', '{}\n');   // an extraInputs derivation input
const P_OS_STRAY = w2('os/unrelated.c', 'int stray;\n');   // os/ at large — must NOT be an input
const P_STRAY = w2('elsewhere/nothing.c', 'int nothing2;\n');   // referenced by nothing

const PKG = {
  name: 'mypkg', version: '1.0',
  requires: 'native-sibling:clang',
  files: {
    'bin/myproj': { project: 'vendor/myproj/bin.json' },
    'share/blob': { bin: 'assets/blob.bin' },
    'etc/motd': { text: 'motd.txt' },
    'bin/tool': { c: 'tool.c', hdrs: ['tool.h'] },
    'src': { tree: 'treedir' },
    'bin/native': { nativeApp: 'native' },
  },
};
const pkgNewestFor = (file) => {
  ageAll(tmp2);
  const t = Date.now() + 5000;   // strictly newer than every other file
  fs.utimesSync(file, t / 1000, t / 1000);
  return COMMON.newestPkgInput(fs, path, tmp2, 'mypkg', PKG, {
    pkgDir: path.join(tmp2, 'packages'),
    extraInputs: ['synth/parent.json'],
    overlayPathFor: (p) => (p === 'clang' ? P_OVERLAY : null),
  });
};

const pkgLeg = (label, file) => check('pkg: ' + label, () => {
  const r = pkgNewestFor(file);
  assert.strictEqual(r.path, file,
    'newest package input should be the touched file, got ' + r.path +
    ' — an input class newestPkgInput claims to cover is not wired');
});
pkgLeg('the definition file is an input', P_DEF);
pkgLeg('compiler.js is an input (toolchain)', P_COMPILER);
pkgLeg('tools/mkpkg.js is an input (tar/control encoding)', P_MKPKG);
pkgLeg('os/os-common.js is an input (packageControl lives there)', P_OSCOMMON);
pkgLeg('a project-dir source is an input', P_MAIN);
pkgLeg('a source reached through `deps` is an input', P_DEP);
pkgLeg('a source OUTSIDE the project dir is an input (the 0354 hole)', P_EXT);
pkgLeg('a `bin` blob is an input', P_BIN);
pkgLeg('a `text` asset is an input (os/-relative)', P_TEXT);
pkgLeg('a `c` entry is an input (os/-relative)', P_C);
pkgLeg('a `hdrs` header is an input', P_HDR);
pkgLeg('a file under a `tree` entry is an input', P_TREE);
pkgLeg('the native sibling overlay manifest is an input', P_OVERLAY);
pkgLeg('an extraInputs derivation input is an input (synthesized defs)', P_SYNTH);

check('pkg: the os/ tree at large is NOT an input (narrow scope)', () => {
  // The gate's documented scope: unrelated OS work must not restale every
  // package. A scan that walks os/ (or the repo root) wholesale passes every
  // leg above while destroying the dev loop — pin the exclusion.
  const r = pkgNewestFor(P_OS_STRAY);
  assert.notStrictEqual(r.path, P_OS_STRAY,
    'an os/ file no entry references must stay OUT of the package closure — ' +
    'a scan that invalidates on all of os/ is the over-invalidation the ' +
    'gate\'s header forbids');
});

check('pkg: a file referenced by nothing is NOT an input', () => {
  const r = pkgNewestFor(P_STRAY);
  assert.notStrictEqual(r.path, P_STRAY,
    'a file outside every entry\'s closure must not restale the package');
});

/* ---- leg D: newestPkgInput, real repo ---------------------------------- */

check('pkg: real defs never pull in the repo root or os/ wholesale', () => {
  // The standing narrow-scope sweep: run the real scan over EVERY shipped
  // definition with a recording fs and assert it never enumerates the repo
  // root or the os/ tree at large. A vendored project whose sources/includes
  // start escaping to `..` or `os` tomorrow is caught here, not by a
  // re-audit.
  const pkgDir = path.join(ROOT, 'packages');
  const defs = fs.readdirSync(pkgDir).filter((n) => /\.json$/.test(n));
  assert.ok(defs.length > 10, 'only ' + defs.length + ' packages/*.json found — ' +
    'if the definition dir moved, re-pin this sweep');
  // The ONE sanctioned way a single def may walk os/: a project whose OWN
  // dir is the os root (dir granularity walks the project's directory
  // wholesale — demos.json's os/gpubox.json today). That over-invalidates
  // exactly that package, the cheap direction. Pinned by NAME so a new
  // arrival is a deliberate decision, not drift — and checked for presence
  // so the exception list can't outlive its member.
  const OS_ROOT_PROJECT_DEFS = ['demos.json'];
  for (const n of OS_ROOT_PROJECT_DEFS) {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, n), 'utf-8'));
    assert.ok(Object.keys(pkg.files || {}).some((f) => {
      const proj = pkg.files[f].project;
      return proj !== undefined && /^os\/[^/]+\.json$/.test(proj);
    }), n + ' no longer has an os-root project entry — its exception here is ' +
       'stale, remove it (and if the def moved, re-pin this sweep)');
  }
  let sweepListed = 0;   // presence: a spy that never fires proves nothing
  for (const n of defs) {
    const pkgListed = new Set();
    const pkgSpy = {
      statSync: (p) => fs.statSync(p),
      readdirSync: (p, o) => { pkgListed.add(rel(p)); return fs.readdirSync(p, o); },
      realpathSync: (p) => fs.realpathSync(p),
      readFileSync: (p, e) => fs.readFileSync(p, e),
      lstatSync: (p) => fs.lstatSync(p),
    };
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, n), 'utf-8'));
    COMMON.newestPkgInput(pkgSpy, path, ROOT, n.replace(/\.json$/, ''), pkg,
      { pkgDir, overlayPathFor: () => null });
    sweepListed += pkgListed.size;
    assert.ok(!pkgListed.has(''), n + ': the closure enumerated the REPO ROOT');
    if (!OS_ROOT_PROJECT_DEFS.includes(n)) {
      assert.ok(!pkgListed.has('os'), n + ': the closure enumerated os/ at large — ' +
        'the gate\'s narrow scope is broken (OS edits would restale this package); ' +
        'if this def deliberately gained an os-root project, add it to ' +
        'OS_ROOT_PROJECT_DEFS with that reasoning');
    }
  }
  assert.ok(sweepListed > 0,
    'the scan enumerated no directory across every def — the recording spy is not wired');
});

check('pkg: every `files` entry kind in real defs has a leg here', () => {
  // The vocabulary pin: newestPkgInput covers project/bin/text/c(+hdrs)/
  // tree(+exclude)/nativeApp/nativeFile; `content`/`mode` live inside the
  // definition file itself (already an input). A NEW entry kind must get an
  // input class in newestPkgInput AND a synthetic leg above — add it to this
  // set only alongside both.
  const covered = new Set(['project', 'bin', 'text', 'c', 'hdrs', 'content',
                           'mode', 'tree', 'exclude', 'nativeApp', 'nativeFile']);
  const pkgDir = path.join(ROOT, 'packages');
  const unknown = [];
  const seenKinds = new Set();
  for (const n of fs.readdirSync(pkgDir).filter((f) => /\.json$/.test(f))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, n), 'utf-8'));
    for (const rel of Object.keys(pkg.files || {})) {
      for (const k of Object.keys(pkg.files[rel])) {
        seenKinds.add(k);
        if (!covered.has(k)) unknown.push(n + ' ' + rel + ': ' + k);
      }
    }
  }
  // Presence: the sweep must still be seeing the kinds it exists to guard —
  // an empty or vocabulary-less packages/ means the fixture decayed, not
  // that all is well.
  assert.ok(seenKinds.has('project') && seenKinds.has('tree'),
    'real defs no longer use project/tree entries — this sweep has decayed, re-pin it');
  assert.deepStrictEqual(unknown, [],
    'unknown `files` entry kind(s): give each an input class in newestPkgInput ' +
    'and a red-control leg in this file, then add them to `covered`');
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
console.log(failures ? failures + ' check(s) FAILED' : 'bake-input source closure OK');
process.exit(failures ? 1 : 0);
