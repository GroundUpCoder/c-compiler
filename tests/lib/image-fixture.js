'use strict';
// Prebaked system-image fixture gate (todos/0082).
//
// The boot.js e2e family materializes its per-test image pair by COPYING
// os/os-system.img (os/boot.js's default --fixture) instead of re-baking an
// identical blob (~40-60s of compiling per file — 97% of the kernel suite's
// serial cost, measured in todos/done/0081). Suite runners call
// ensurePrebakedImage() once up front so that fixture exists and is
// INPUT-fresh: a blob baked before the current compiler.js/os//vendor tree
// re-bakes HERE (one visible mkimage run) rather than being silently copied
// by every test — or, on the browser path, silently fetched through
// serve.js by kernel-worker.js (serve.js runs the same gate at startup;
// this pre-step just makes the bake visible and attributable instead of
// mysteriously slowing the first test file).
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const IMG = path.join(ROOT, 'os', 'os-system.img');

// { fresh: true, version } | { fresh: false, reason }
function fixtureState() {
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'os', 'image.json'), 'utf-8'));
  let st;
  try { st = fs.statSync(IMG); } catch (e) { return { fresh: false, reason: 'missing' }; }
  const store = new COMMON.NodeFileStore(fs, IMG, false);
  const v = COMMON.bakedVersion(BLOCK_FS, store);
  store.close();
  if (v < (manifest.version | 0)) {
    return { fresh: false, reason: `${v < 0 ? 'unreadable' : 'v' + v} < manifest v${manifest.version}` };
  }
  const inp = COMMON.newestBakeInput(fs, path, ROOT, manifest);
  if (st.mtimeMs < inp.mtimeMs) {
    return { fresh: false, reason: `input-stale (${path.relative(ROOT, inp.path)} is newer)` };
  }
  return { fresh: true, version: v };
}

// Returns true when a fresh fixture is in place (baking once if needed);
// false when the bake failed — callers proceed anyway and let the per-file
// boots surface the real compile errors (each bakes privately and fails
// with diagnostics in its own log).
function ensurePrebakedImage(log) {
  log = log || ((m) => process.stderr.write(m + '\n'));
  const st = fixtureState();
  if (st.fresh) { log(`[fixture] os/os-system.img fresh (v${st.version})`); return true; }
  log(`[fixture] os/os-system.img ${st.reason} — baking once (node tools/mkimage.js)…`);
  const t0 = Date.now();
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'mkimage.js'), '--quiet'],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    log('[fixture] mkimage FAILED — e2e boots will bake privately (expect slow failures)');
    return false;
  }
  log(`[fixture] baked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

module.exports = { ensurePrebakedImage, fixtureState };
