// fsck_v4 correctness + a v4 filesystem-level model fuzzer (the v4 parallels of
// test_fsck.js + test_fuzz.js). Random fs ops, with fsck_v4 + a model comparison
// after every op, plus dual-instance coherence (two BlockFS instances over one
// store stay consistent — the read-through property the concurrent runner relies
// on), plus hand-corruption tests proving fsck_v4 catches breakage.

'use strict';
const fs = require('fs');
const path = require('path');
const hostSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'host.js'), 'utf8').replace(/^#![^\n]*\n/, '');
const BLOCK_FS = new Function(`${hostSrc}\nreturn BLOCK_FS;`)();
const { createV4, MemoryByteStore } = BLOCK_FS;
const { fsck } = require('./fsck_v4.js');

const O_RDONLY = 0, O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;
let passed = 0, failed = 0;
function ok(c, m) { if (c) passed++; else { failed++; console.error('FAIL:', m); } }
function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function wfile(b, p, s) { const fd = b.open(p, O_CREAT | O_TRUNC | O_WRONLY, 0o644); const buf = Buffer.from(s); if (buf.length) b.write(fd, buf, buf.length); b.close(fd); }
function rfile(b, p) { const fd = b.open(p, O_RDONLY, 0); if (typeof fd !== 'number' || fd < 0) return null; const sz = b.stat(p).size; const u = new Uint8Array(sz); const n = sz ? b.read(fd, u, sz) : 0; b.close(fd); return Buffer.from(u.slice(0, n)).toString(); }

// ---- 1. fsck is clean on a varied image ----
{
  const store = new MemoryByteStore(1 << 20);
  const b = createV4(store);
  b.mkdir('/d', 0o755); b.mkdir('/d/e', 0o755);
  wfile(b, '/d/x.txt', 'hello'); wfile(b, '/d/e/big.bin', 'Q'.repeat(30000));
  b.link('/d/x.txt', '/d/x2.txt');
  const probs = fsck(store);
  ok(probs.length === 0, 'fsck clean on a varied v4 image: ' + probs.join('; '));
}

// ---- 2. Model fuzzer: random ops, fsck + model after each, dual-instance coherence ----
function fuzz(seed, ops) {
  const rand = rng(seed);
  const store = new MemoryByteStore(1 << 18);
  let b = createV4(store);
  const files = new Map(); // path -> content
  const dirs = new Set(['/']);
  let seq = 0;
  const pick = (set) => { const a = [...set]; return a[Math.floor(rand() * a.length)]; };
  for (let i = 0; i < ops; i++) {
    const roll = rand();
    if (roll < 0.4) {                                   // create/overwrite a file
      const dir = pick(dirs); const name = `f${seq++}`;
      const p = dir === '/' ? '/' + name : dir + '/' + name;
      const content = `c${i}-` + 'x'.repeat(Math.floor(rand() * 500));
      wfile(b, p, content); files.set(p, content);
    } else if (roll < 0.55 && dirs.size < 40) {          // mkdir
      const dir = pick(dirs); const name = `d${seq++}`;
      const p = dir === '/' ? '/' + name : dir + '/' + name;
      if (b.mkdir(p, 0o755) === 0) dirs.add(p);
    } else if (roll < 0.8 && files.size) {               // unlink a file
      const p = pick(new Set(files.keys())); b.unlink(p); files.delete(p);
    } else if (files.size) {                             // re-read a random file (verify content)
      const p = pick(new Set(files.keys()));
      if (rfile(b, p) !== files.get(p)) return `seed ${seed} op ${i}: content mismatch at ${p}`;
    }
    const probs = fsck(store);
    if (probs.length) return `seed ${seed} op ${i}: fsck: ${probs.join('; ')}`;
    // Dual-instance coherence: a fresh instance over the same store sees the same
    // files (read-through), and writes through it are visible to the original.
    if (i % 50 === 49) {
      const b2 = createV4(store);
      for (const [p, c] of files) if (rfile(b2, p) !== c) return `seed ${seed} op ${i}: instance-2 mismatch at ${p}`;
      const probe = '/coh' + i + '.txt';
      wfile(b2, probe, 'coherent'); files.set(probe, 'coherent');
      if (rfile(b, probe) !== 'coherent') return `seed ${seed} op ${i}: instance-1 did not see instance-2's write`;
      b = createV4(store); // continue on a fresh instance too
    }
  }
  return null;
}
{
  let fail = null;
  for (let s = 1; s <= 10 && !fail; s++) fail = fuzz(s, 600);
  ok(!fail, 'v4 fs fuzzer (10 seeds x 600 ops, fsck + model + dual-instance): ' + (fail || 'clean'));
}

// ---- 3. Corruption detection: fsck_v4 catches deliberate breakage ----
function freshImage() {
  const store = new MemoryByteStore(1 << 18);
  const b = createV4(store);
  b.mkdir('/dir', 0o755); wfile(b, '/dir/a.txt', 'data'); wfile(b, '/b.bin', 'Z'.repeat(5000));
  ok(fsck(store).length === 0, 'baseline image is clean');
  return store;
}
const SB4_INODE_EXTENT = 16, I_DATA_SIZE = 24, INODE_SIZE = 128, I_MODE = 0;
function inodeOff(store, ino) {
  const ext = store.getUint32(SB4_INODE_EXTENT) + store.getUint32(SB4_INODE_EXTENT + 4) * 0x100000000;
  return ext + ino * INODE_SIZE;
}
{
  let s = freshImage(); s.setUint32(0, 0); // bad magic
  ok(fsck(s).some(p => /magic/.test(p)), 'catches bad magic');

  s = freshImage(); s.setUint32(4, 99); // bad version
  ok(fsck(s).some(p => /version/.test(p)), 'catches bad version');

  s = freshImage(); s.setUint32(inodeOff(s, 2) + I_DATA_SIZE, 0xFFFFFFF0); // dataSize >> extentCap
  ok(fsck(s).some(p => /dataSize/.test(p)), 'catches dataSize past extent capacity');

  s = freshImage(); s.setUint32(inodeOff(s, 1) + I_MODE, 0o100644); // root mode -> regular file
  ok(fsck(s).some(p => /root inode is not a directory/.test(p)), 'catches non-directory root');
}

// ---- 4. Duplicate dirent names (todos/0375) ----
// open(O_CREAT) through a dangling symlink used to append a SECOND dirent
// under the link's own name — and fsck_v4 passed the image CLEAN (no
// name-uniqueness invariant), so the corruption was invisible to the checker.
// This is the POSITIVE CONTROL for that invariant: build a known-corrupt
// image by raw surgery (rename one of two same-length sibling entries to the
// other's name — independent of any host.js code path) and prove fsck goes
// red on it.
{
  const store = new MemoryByteStore(1 << 18);
  const b = createV4(store);
  wfile(b, '/aa', 'one'); wfile(b, '/ab', 'two');
  ok(fsck(store).length === 0, 'dup-dirent control: image clean before surgery');
  // Root dir extent: scan entries, rewrite the name bytes of 'ab' -> 'aa'.
  const rootOff = inodeOff(store, 1);
  const I_EXTENT_OFF = 8;
  const extOff = store.getUint32(rootOff + I_EXTENT_OFF) + store.getUint32(rootOff + I_EXTENT_OFF + 4) * 0x100000000;
  const dataSize = store.getUint32(rootOff + I_DATA_SIZE) + store.getUint32(rootOff + I_DATA_SIZE + 4) * 0x100000000;
  const DIR_ENT_HEADER = 6;
  let pos = 0, renamed = false;
  while (pos < dataSize) {
    const nameLen = store.getUint32(extOff + pos + 4) & 0xFFFF;
    const name = Buffer.from(store.getBytes(extOff + pos + DIR_ENT_HEADER, nameLen)).toString();
    if (name === 'ab') { store.setBytes(extOff + pos + DIR_ENT_HEADER, Buffer.from('aa')); renamed = true; break; }
    pos += DIR_ENT_HEADER + nameLen;
  }
  ok(renamed, 'dup-dirent control: surgery found and renamed the ab entry');
  ok(fsck(store).some(p => /duplicate/.test(p)),
    'catches duplicate dirent names (todos/0375 — the invariant that made the O_CREAT-through-dangling-symlink corruption invisible)');
}

console.log(`\nfsck_v4: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
