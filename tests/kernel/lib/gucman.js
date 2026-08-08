// tests/kernel/lib/gucman.js — shared fixtures for the gucman e2es
// (test_gucman_e2e.js = the engine acceptance on punes, test_gucman_quake_e2e.js
// = the fat-data payload leg): the cached MINIMAL (no-packages) system blob,
// the mkpkg package repo, and a serve.js static-repo server.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

/* The minimal system blob (no packages), baked once + cached under
 * build/test-fixtures/ — version- AND input-fresh gated (the 0082 rule),
 * and required to carry an EMPTY package set. */
function ensureMinimalImage(log) {
  const MIN = path.join(ROOT, 'build', 'test-fixtures', 'os-system.min.img');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
  let fresh = false;
  try {
    const st = fs.statSync(MIN);
    const store = new COMMON.NodeFileStore(fs, MIN, false);
    const v = COMMON.bakedVersion(BLOCK_FS, store);
    const pk = COMMON.bakedPackages(BLOCK_FS, store);
    store.close();
    fresh = v === (raw.version | 0) && pk.length === 0 &&
      st.mtimeMs >= COMMON.newestBakeInput(fs, path, ROOT, raw).mtimeMs;
  } catch (e) { /* missing -> bake */ }
  if (!fresh) {
    (log || console.log)('[gucman] baking the minimal (no-packages) system blob…');
    fs.mkdirSync(path.dirname(MIN), { recursive: true });
    const r = cp.spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'mkimage.js'), `--out=${MIN}`, '--quiet'],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
    if (r.status !== 0) throw new Error('mkimage (minimal) failed');
  }
  return MIN;
}

/* The package repo (mkpkg output). Returns { dir, index }: `dir` is what the
 * caller hands to startServer, `index` the parsed index.json. `need` = package
 * names the caller requires.
 *
 * PER-TEST repo, SHARED payload store (todos/0388). These e2es used to build
 * into the one <repo>/dist/packages, which made the repo shared mutable state:
 * a base build's orphan prune deletes every payload its index doesn't name, so
 * at -j2 a sibling test would rewrite the index and delete the -clang payloads
 * out from under a clang test that had already served them — measured landing
 * 1.1s after that test's OS started booting. Each test now owns
 * build/test-packages/<test>/ outright, while --pool keeps the ONE warm
 * content-addressed cache that makes a rebuild ~0.1s instead of ~90s. */
const PKG_ROOT = path.join(ROOT, 'build', 'test-packages');
const POOL = path.join(PKG_ROOT, 'pool');

/* One repo per RUNNING INSTANCE, not per test file. `--repeat N` runs the same
 * file concurrently, so a name derived from the file alone collides with
 * itself — mkpkg's one-writer lock catches that loudly (which is how this was
 * found), but the right answer is for each instance to own a repo. mkdtemp
 * gives that unconditionally; the shared POOL is what carries the speed, so a
 * fresh dir costs only the hardlink view. Removed at exit — the dir is a view,
 * never the cache. */
const repoDirs = [];
function testRepoDir(tag) {
  const self = path.basename(process.argv[1] || 'unknown').replace(/\.js$/, '');
  fs.mkdirSync(PKG_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(PKG_ROOT, `${self}${tag ? '.' + tag : ''}-`));
  repoDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const d of repoDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

function runMkpkg(dir, extraArgs, timeout) {
  fs.mkdirSync(dir, { recursive: true });
  const r = cp.spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet', `--out=${dir}`, `--pool=${POOL}`,
     ...extraArgs],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout });
  if (r.status !== 0) throw new Error(`mkpkg ${extraArgs.join(' ')} failed (exit ${r.status})`);
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'));
}

function requireEntries(index, need, what) {
  for (const n of need || []) {
    if (!index.packages[n]) throw new Error(`${what} produced no ${n} entry`);
  }
}

function ensurePackages(need, opts) {
  const dir = testRepoDir((opts || {}).tag);
  const index = runMkpkg(dir, [], 600000);
  requireEntries(index, need, 'mkpkg');
  return { dir, index };
}

/* A producer SUPERSET repo (`mkpkg --<producer>` over a sibling root —
 * todos/0416: 'clang' and 'rust' are peers under one rule). Same isolation;
 * the only difference is the definition set, which is exactly what used to
 * collide with the base one. */
function ensureProducerPackages(producer, need, siblingRoot, opts) {
  const dir = testRepoDir((opts || {}).tag || producer);
  const index = runMkpkg(dir, [`--${producer}`, `--${producer}-root=${siblingRoot}`], 900000);
  requireEntries(index, need, `mkpkg --${producer}`);
  return { dir, index };
}
function ensureClangPackages(need, clangRoot, opts) {
  return ensureProducerPackages('clang', need, clangRoot, opts);
}

/* Spawn serve.js over a static dir, resolve its port. The tree has no
 * os/image.json, so serve's own image gate self-skips. Children are killed
 * at process exit. */
const servers = [];
function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [path.join(ROOT, 'serve.js'), dir, '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(child);
    let buf = '';
    const to = setTimeout(() => {
      reject(new Error('serve.js never announced a port (stale output: ' + buf + ')'));
    }, 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /http:\/\/localhost:(\d+)/.exec(buf);
      if (m) { clearTimeout(to); resolve(parseInt(m[1], 10)); }
    });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
    child.on('exit', (code) => { clearTimeout(to); reject(new Error('serve.js exited ' + code)); });
  });
}
process.on('exit', () => { for (const s of servers) { try { s.kill(); } catch (e) {} } });

module.exports = { ROOT, ensureMinimalImage, ensurePackages, ensureClangPackages,
                   ensureProducerPackages, startServer, PKG_ROOT, POOL };
