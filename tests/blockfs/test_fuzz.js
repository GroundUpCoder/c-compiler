#!/usr/bin/env node
'use strict';
// Model-based / differential fuzzer for BlockFS.
//
// Runs random valid filesystem operations against (a) BlockFS and (b) a trivial
// in-memory reference model, asserting after EVERY op that:
//   1. a FRESH BlockFS instance over the same store matches the model
//      (catches per-instance cache divergence — the exact bug class that let two
//       live instances cross-corrupt),
//   2. fsck(store) is clean (catches structural corruption at its source),
//   3. (dual mode) two live instances over one store stay coherent when writes
//      alternate between them — the serialized-concurrent case the global lock
//      produces for real parallel runners.
// Deterministic per seed; on failure it prints the seed + op so you get a
// minimal repro. `node test_fuzz.js --long` runs more/seeds/ops.

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var { fsck } = require('./fsck.js');

var LONG = process.argv.indexOf('--long') >= 0;
var SEEDS = LONG ? 20 : 6;
var OPS = LONG ? 4000 : 1200;

// ---- deterministic PRNG (mulberry32) ----
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

var enc = new TextEncoder();
function parent(p) { var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Read a whole file via a BlockFS instance.
function readAll(fs, path) {
  var st = fs.stat(path);
  if (!st) throw new Error('stat failed for ' + path + ': ' + fs._lastError);
  var fd = fs.open(path, 0, 0); // O_RDONLY
  if (fd < 0) throw new Error('open failed for ' + path + ': ' + fs._lastError);
  var out = new Uint8Array(st.size), off = 0;
  while (off < st.size) { var n = fs.read(fd, out.subarray(off), st.size - off); if (n <= 0) break; off += n; }
  fs.close(fd);
  return out.subarray(0, off);
}
function listDir(fs, path) {
  var h = fs.opendir(path);
  if (h < 0) throw new Error('opendir failed for ' + path + ': ' + fs._lastError);
  var names = [], e;
  while ((e = fs.readdir(h)) !== null) { if (e.name !== '.' && e.name !== '..') names.push(e.name); }
  fs.closedir(h);
  return names.sort();
}

// Assert a BlockFS instance fully matches the model.
function verify(fs, model, ctx) {
  for (var path of model.files.keys()) {
    var got = readAll(fs, path);
    if (!eqBytes(got, model.files.get(path)))
      throw new Error(ctx + ': content mismatch at ' + path + ' (' + got.length + ' vs ' + model.files.get(path).length + ' bytes)');
  }
  for (var dir of model.dirs) {
    var want = childrenOf(model, dir);
    var got2 = listDir(fs, dir);
    if (want.join('|') !== got2.join('|'))
      throw new Error(ctx + ': listing mismatch at ' + dir + '\n  model: [' + want + ']\n  fs:    [' + got2 + ']');
  }
}
function childrenOf(model, dir) {
  var names = [];
  var add = function (p) { if (p !== '/' && parent(p) === dir) names.push(p.slice(p.lastIndexOf('/') + 1)); };
  model.files.forEach(function (_v, k) { add(k); });
  model.dirs.forEach(function (k) { add(k); });
  return names.sort();
}

function run(seed, dual) {
  var rand = rng(seed);
  var store = new MemoryByteStore(1024 * 1024);
  var instances = dual ? [BLOCK_FS.create(store), BLOCK_FS.create(store)] : [BLOCK_FS.create(store)];
  var model = { files: new Map(), dirs: new Set(['/']) };
  var counter = 0;
  var pick = function (arr) { return arr[Math.floor(rand() * arr.length)]; };
  var randName = function () { return 'n' + (counter++); };
  var randContent = function () {
    var len = Math.floor(rand() * rand() * 9000); // bias small, occasionally multi-block
    var b = new Uint8Array(len);
    for (var i = 0; i < len; i++) b[i] = Math.floor(rand() * 256);
    return b;
  };

  for (var step = 0; step < OPS; step++) {
    var fs = pick(instances); // dual: alternate which live instance mutates
    var dirs = Array.from(model.dirs);
    var files = Array.from(model.files.keys());
    var roll = rand();
    var op = '';
    try {
      if (roll < 0.30) { // mkdir
        var pd = pick(dirs); var np = (pd === '/' ? '' : pd) + '/' + randName();
        op = 'mkdir ' + np;
        if (fs.mkdir(np, 0o755) !== 0) throw new Error('mkdir failed: ' + fs._lastError);
        model.dirs.add(np);
      } else if (roll < 0.65) { // create/overwrite file
        var pd2 = pick(dirs); var fp = (pd2 === '/' ? '' : pd2) + '/' + randName();
        var content = randContent();
        op = 'write ' + fp + ' (' + content.length + 'b)';
        var fd = fs.open(fp, 0x40 | 0x200 | 0x1, 0o644); // O_CREAT|O_TRUNC|O_WRONLY
        if (fd < 0) throw new Error('open(w) failed: ' + fs._lastError);
        var w = 0; while (w < content.length) { var n = fs.write(fd, content.subarray(w), content.length - w); if (n <= 0) throw new Error('write failed: ' + fs._lastError); w += n; }
        fs.close(fd);
        model.files.set(fp, content);
      } else if (roll < 0.80 && files.length) { // unlink
        var uf = pick(files); op = 'unlink ' + uf;
        if (fs.unlink(uf) !== 0) throw new Error('unlink failed: ' + fs._lastError);
        model.files.delete(uf);
      } else if (roll < 0.90 && dirs.length > 1) { // rmdir (empty only)
        var rd = pick(dirs);
        if (rd !== '/' && childrenOf(model, rd).length === 0) {
          op = 'rmdir ' + rd;
          if (fs.rmdir(rd) !== 0) throw new Error('rmdir failed: ' + fs._lastError);
          model.dirs.delete(rd);
        } else continue;
      } else if (files.length) { // read-verify a specific file
        var rf = pick(files); op = 'read ' + rf;
        var got = readAll(fs, rf);
        if (!eqBytes(got, model.files.get(rf))) throw new Error('read mismatch at ' + rf);
        continue;
      } else continue;

      // After every mutation: structural + coherence checks.
      var problems = fsck(store);
      if (problems.length) throw new Error('fsck found:\n  - ' + problems.join('\n  - '));
      // A FRESH instance must match the model (read-through coherence).
      verify(BLOCK_FS.create(store), model, 'fresh-instance');
      // In dual mode, BOTH live instances must also match (multi-writer coherence).
      if (dual) for (var k = 0; k < instances.length; k++) verify(instances[k], model, 'live-instance-' + k);

      // Occasionally remount: drop live instances, recreate (persistence check).
      if (rand() < 0.02) instances = dual ? [BLOCK_FS.create(store), BLOCK_FS.create(store)] : [BLOCK_FS.create(store)];
    } catch (e) {
      throw new Error('seed ' + seed + (dual ? ' [dual]' : '') + ' step ' + step + ' op "' + op + '": ' + e.message);
    }
  }
}

var passed = 0, failed = 0;
for (var s = 1; s <= SEEDS; s++) {
  for (var dual = 0; dual <= 1; dual++) {
    try { run(s * 2654435761 | 0, !!dual); passed++; }
    catch (e) { failed++; console.error('FAIL: ' + e.message); }
  }
}
console.log('\n--- BlockFS Fuzz (' + SEEDS + ' seeds × {single,dual}, ' + OPS + ' ops each) ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
process.exitCode = failed ? 1 : 0;
