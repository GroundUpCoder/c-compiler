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

/* The package repo (mkpkg output), built once + reused when fresh; returns
 * the parsed index. `need` = package names the caller requires. */
function ensurePackages(need) {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mkpkg.js'), '--quiet'],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 });
  if (r.status !== 0) throw new Error('mkpkg failed');
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'packages', 'index.json'), 'utf-8'));
  for (const n of need || []) {
    if (!idx.packages[n]) throw new Error(`mkpkg produced no ${n} entry`);
  }
  return idx;
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

module.exports = { ROOT, ensureMinimalImage, ensurePackages, startServer };
