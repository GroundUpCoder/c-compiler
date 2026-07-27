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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? failures + ' check(s) FAILED' : 'bake-input source closure OK');
process.exit(failures ? 1 : 0);
