#!/usr/bin/env node
'use strict';
// Tests for fsck itself: a clean image must pass; hand-corrupted images must be
// caught. (Who checks the checker? These do.)

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var { fsck } = require('./fsck.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + name); console.error('  ' + (e.stack || e.message)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
var enc = new TextEncoder();
function encode(s) { return enc.encode(s); }

// on-disk offsets (mirror host.js) for crafting corruption
var SB_MAGIC = 0, SB_INODE_TBL_EXTENT = 20, SB_NEXT_INODE_ID = 28;
var INODE_SIZE = 32, INO_EXTENT_OFFSET = 0, INO_MODE = 12, BLOCK_OVERHEAD = 8;

function makeFS() {
  var store = new MemoryByteStore(1024 * 1024);
  return { fs: BLOCK_FS.create(store), store: store };
}
function createFile(fs, path, content) {
  var fd = fs.open(path, 0x40 | 0x200 | 0x2, 0o644); // O_CREAT|O_TRUNC|O_RDWR
  if (fd < 0) throw new Error('create ' + path + ' failed: ' + fs._lastError);
  if (content) { var b = encode(content); fs.write(fd, b, b.length); }
  fs.close(fd);
}
function clean(store, label) {
  var p = fsck(store);
  assert(p.length === 0, (label || 'image') + ' should be clean, got:\n  ' + p.join('\n  '));
}
function caught(store, substr) {
  var p = fsck(store);
  assert(p.length > 0, 'expected fsck to report a problem, but it was clean');
  if (substr) assert(p.some(function (s) { return s.indexOf(substr) >= 0; }),
    'expected a problem containing "' + substr + '", got:\n  ' + p.join('\n  '));
}

// ---- clean images pass ----
test('fresh fs is clean', function () { clean(makeFS().store, 'fresh'); });

test('fs with files, dirs, writes is clean', function () {
  var r = makeFS();
  r.fs.mkdir('/a', 0o755); r.fs.mkdir('/a/b', 0o755);
  createFile(r.fs, '/a/hello.txt', 'hello world');
  createFile(r.fs, '/a/b/data.bin', 'x'.repeat(5000)); // multi-block extent
  createFile(r.fs, '/empty.txt', '');
  clean(r.store, 'populated');
});

test('fs after inode-table growth (>64 files) is clean', function () {
  var r = makeFS();
  for (var i = 0; i < 80; i++) createFile(r.fs, '/f' + i + '.txt', 'data-' + i);
  clean(r.store, 'grown');
});

test('fs stays clean after unlink', function () {
  var r = makeFS();
  createFile(r.fs, '/x.txt', 'abc');
  createFile(r.fs, '/y.txt', 'def');
  r.fs.unlink('/x.txt');
  clean(r.store, 'after-unlink');
});

// ---- corruption is caught ----
test('bad magic is caught', function () {
  var r = makeFS();
  r.store.setUint32(SB_MAGIC, 0xDEADBEEF);
  caught(r.store, 'bad magic');
});

test('nextInodeId < 2 is caught', function () {
  var r = makeFS();
  createFile(r.fs, '/f.txt', 'hi');
  r.store.setUint32(SB_NEXT_INODE_ID, 1);
  caught(r.store, 'nextInodeId');
});

test('nlink mismatch on a file is caught', function () {
  var r = makeFS();
  createFile(r.fs, '/f.txt', 'hi'); // inode 2
  var off = r.store.getUint32(SB_INODE_TBL_EXTENT) + 2 * INODE_SIZE;
  var word = r.store.getUint32(off + INO_MODE);
  var mode = word & 0xFFFF, nlink = word >>> 16;
  r.store.setUint32(off + INO_MODE, mode | ((nlink + 7) << 16)); // inflate nlink
  caught(r.store, 'nlink');
});

test('a referenced extent marked FREE is caught', function () {
  var r = makeFS();
  createFile(r.fs, '/f.txt', 'has data'); // inode 2, non-null extent
  var off = r.store.getUint32(SB_INODE_TBL_EXTENT) + 2 * INODE_SIZE;
  var extent = r.store.getUint32(off + INO_EXTENT_OFFSET);
  var block = extent - BLOCK_OVERHEAD;
  r.store.setUint32(block, r.store.getUint32(block) | 1); // set FREE_BIT
  caught(r.store, 'FREE');
});

test('dirent pointing at a dead inode is caught', function () {
  var r = makeFS();
  createFile(r.fs, '/f.txt', 'hi'); // inode 2, referenced by root dirent
  var off = r.store.getUint32(SB_INODE_TBL_EXTENT) + 2 * INODE_SIZE;
  r.store.setUint32(off + INO_MODE, 0); // mode 0 → inode looks free, but dirent remains
  caught(r.store, 'not live');
});

test('two inodes sharing one extent (double-allocation) is caught', function () {
  var r = makeFS();
  createFile(r.fs, '/a.txt', 'aaaa'); // inode 2
  createFile(r.fs, '/b.txt', 'bbbb'); // inode 3
  var base = r.store.getUint32(SB_INODE_TBL_EXTENT);
  var extentA = r.store.getUint32(base + 2 * INODE_SIZE + INO_EXTENT_OFFSET);
  // Point inode 3's extent at inode 2's extent → double claim.
  r.store.setUint32(base + 3 * INODE_SIZE + INO_EXTENT_OFFSET, extentA);
  caught(r.store, 'double-allocation');
});

console.log('\n--- fsck Tests ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);
process.exit(failed ? 1 : 0);
