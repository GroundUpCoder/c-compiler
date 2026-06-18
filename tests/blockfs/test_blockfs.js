#!/usr/bin/env node
// BlockFS unit tests — pure JS, MemoryByteStore, no OPFS
'use strict';

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var TLSFAllocator = BLOCK_FS.TLSFAllocator;

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + name);
    console.error('  ' + (e.stack || e.message));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertEq') + ': ' + a + ' !== ' + b);
}

var encoder = new TextEncoder();

function encode(s) { return encoder.encode(s); }
function decode(b) { return new TextDecoder().decode(b); }

// Make a fresh 1MB filesystem for each test
function makeFS() {
  var store = new MemoryByteStore(1024 * 1024);
  var fs = BLOCK_FS.create(store);
  return { fs: fs, store: store };
}

// ---------------------------------------------------------------
// Basic file I/O
// ---------------------------------------------------------------

test('open non-existent file fails', function () {
  var r = makeFS();
  var fd = r.fs.open('/nonexistent', 0, 0);
  assert(fd < 0 || fd === null, 'open should fail');
  assertEq(r.fs._lastError, 'ENOENT');
});

test('create and open file', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200;
  var fd = r.fs.open('/hello.txt', O_CREAT | O_TRUNC, 0o644);
  assert(fd >= 3, 'fd should be >= 3, got ' + fd);
  r.fs.close(fd);
});

test('write and read back', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;

  var fd = r.fs.open('/data.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3);

  var data = encode('Hello, World!');
  var nw = r.fs.write(fd, data, data.length);
  assertEq(nw, 13);

  // Seek back to start
  r.fs.lseek(fd, 0, 0);

  var buf = new Uint8Array(20);
  var nr = r.fs.read(fd, buf, 20);
  assertEq(nr, 13);
  assertEq(decode(buf.subarray(0, 13)), 'Hello, World!');

  r.fs.close(fd);
});

test('write past end extends file', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200;

  var fd = r.fs.open('/grow.bin', O_CREAT | O_TRUNC, 0o644);

  // Write 100 bytes at position 0
  var data = new Uint8Array(100);
  for (var i = 0; i < 100; i++) data[i] = i & 0xFF;
  r.fs.write(fd, data, 100);

  // Write at position 1000
  r.fs.lseek(fd, 1000, 0);
  var data2 = new Uint8Array(50);
  for (var j = 0; j < 50; j++) data2[j] = 0xAA;
  r.fs.write(fd, data2, 50);

  // File should now be 1050 bytes
  r.fs.lseek(fd, 0, 0);
  var buf = new Uint8Array(1100);
  var nr = r.fs.read(fd, buf, 1100);
  // Should read at least 1050
  assert(nr >= 1050, 'expected >= 1050 bytes read, got ' + nr);

  r.fs.close(fd);
});

test('O_APPEND writes to end', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200, O_APPEND = 0x400, O_RDWR = 0x2;

  var fd = r.fs.open('/append.txt', O_CREAT | O_TRUNC | O_APPEND | O_RDWR, 0o644);
  r.fs.write(fd, encode('first '), 6);
  r.fs.write(fd, encode('second'), 6);

  // Seek to 0, read back
  r.fs.lseek(fd, 0, 0);
  var buf = new Uint8Array(20);
  var nr = r.fs.read(fd, buf, 20);
  assertEq(decode(buf.subarray(0, nr)), 'first second');
  r.fs.close(fd);
});

test('lseek SEEK_SET/CUR/END', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;

  var fd = r.fs.open('/seek.txt', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  r.fs.write(fd, encode('ABCDEFGHIJ'), 10);

  assertEq(r.fs.lseek(fd, 0, 0), 0);   // SEEK_SET
  assertEq(r.fs.lseek(fd, 3, 1), 3);   // SEEK_CUR from 0
  assertEq(r.fs.lseek(fd, -2, 2), 8);  // SEEK_END - 2
  r.fs.close(fd);
});

test('O_EXCL fails when file exists', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_EXCL = 0x80;

  var fd = r.fs.open('/excl.txt', O_CREAT, 0o644);
  r.fs.close(fd);

  var fd2 = r.fs.open('/excl.txt', O_CREAT | O_EXCL, 0o644);
  assert(fd2 < 0 || fd2 === null, 'O_EXCL should fail');
  assertEq(r.fs._lastError, 'EEXIST');
});

test('O_TRUNC truncates file', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;

  var fd = r.fs.open('/trunc.txt', O_CREAT | O_RDWR, 0o644);
  r.fs.write(fd, encode('lots of data here'), 18);
  r.fs.close(fd);

  var fd2 = r.fs.open('/trunc.txt', O_TRUNC | O_RDWR, 0o644);
  var buf = new Uint8Array(5);
  var nr = r.fs.read(fd2, buf, 5);
  assertEq(nr, 0, 'truncated file should be empty');
  r.fs.close(fd2);
});

// ---------------------------------------------------------------
// Directories
// ---------------------------------------------------------------

test('mkdir and stat directory', function () {
  var r = makeFS();
  var ret = r.fs.mkdir('/subdir', 0o755);
  assertEq(ret, 0);

  var st = r.fs.stat('/subdir');
  assert(st !== null && st !== undefined);
  assert((st.mode & 0o170000) === 0o040000, 'should be S_IFDIR');
});

test('rmdir empty directory', function () {
  var r = makeFS();
  r.fs.mkdir('/todel', 0o755);
  var ret = r.fs.rmdir('/todel');
  assertEq(ret, 0);

  var st = r.fs.stat('/todel');
  assert(st === null || st < 0, 'stat should fail after rmdir');
});

test('rmdir non-empty fails', function () {
  var r = makeFS();
  r.fs.mkdir('/hasfile', 0o755);
  var O_CREAT = 0x40;
  var fd = r.fs.open('/hasfile/child.txt', O_CREAT, 0o644);
  r.fs.close(fd);

  var ret = r.fs.rmdir('/hasfile');
  assert(ret < 0 || ret === null);
  assertEq(r.fs._lastError, 'ENOTEMPTY');
});

test('mkdir existing fails with EEXIST', function () {
  var r = makeFS();
  r.fs.mkdir('/dup', 0o755);
  var ret = r.fs.mkdir('/dup', 0o755);
  assert(ret < 0 || ret === null);
  assertEq(r.fs._lastError, 'EEXIST');
});

// ---------------------------------------------------------------
// Unlink / remove
// ---------------------------------------------------------------

test('unlink file', function () {
  var r = makeFS();
  var O_CREAT = 0x40;
  var fd = r.fs.open('/killme.txt', O_CREAT, 0o644);
  r.fs.close(fd);

  var ret = r.fs.unlink('/killme.txt');
  assertEq(ret, 0);

  var st = r.fs.stat('/killme.txt');
  assert(st === null || st < 0, 'stat should fail after unlink');
});

test('unlink directory fails with EPERM', function () {
  var r = makeFS();
  r.fs.mkdir('/adir', 0o755);
  var ret = r.fs.unlink('/adir');
  assert(ret < 0 || ret === null);
  assertEq(r.fs._lastError, 'EPERM');
});

// ---------------------------------------------------------------
// Rename
// ---------------------------------------------------------------

test('rename file', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_RDWR = 0x2;
  var fd = r.fs.open('/old.txt', O_CREAT | O_RDWR, 0o644);
  r.fs.write(fd, encode('rename test'), 11);
  r.fs.close(fd);

  var ret = r.fs.rename('/old.txt', '/new.txt');
  assertEq(ret, 0);

  // Old should not exist
  var stOld = r.fs.stat('/old.txt');
  assert(stOld === null || stOld < 0);

  // New should have the data
  var fd2 = r.fs.open('/new.txt', O_RDWR, 0o644);
  var buf = new Uint8Array(20);
  var nr = r.fs.read(fd2, buf, 20);
  assertEq(decode(buf.subarray(0, nr)), 'rename test');
  r.fs.close(fd2);
});

test('rename overwrites target', function () {
  var r = makeFS();
  var O_CREAT = 0x40;

  var fd1 = r.fs.open('/src.txt', O_CREAT, 0o644);
  r.fs.close(fd1);
  var fd2 = r.fs.open('/dst.txt', O_CREAT, 0o644);
  r.fs.close(fd2);

  var ret = r.fs.rename('/src.txt', '/dst.txt');
  assertEq(ret, 0);

  // Old source gone
  assert(r.fs.stat('/src.txt') === null || r.fs.stat('/src.txt') < 0);
  // Target exists
  assert(r.fs.stat('/dst.txt') !== null);
});

test('rename across directories', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_RDWR = 0x2;

  r.fs.mkdir('/a', 0o755);
  r.fs.mkdir('/b', 0o755);

  var fd = r.fs.open('/a/f.txt', O_CREAT | O_RDWR, 0o644);
  r.fs.write(fd, encode('moved'), 5);
  r.fs.close(fd);

  r.fs.rename('/a/f.txt', '/b/g.txt');

  var fd2 = r.fs.open('/b/g.txt', O_RDWR, 0o644);
  var buf = new Uint8Array(10);
  var nr = r.fs.read(fd2, buf, 10);
  assertEq(decode(buf.subarray(0, nr)), 'moved');
  r.fs.close(fd2);
});

// ---------------------------------------------------------------
// Directory listing (opendir / readdir / closedir)
// ---------------------------------------------------------------

test('opendir and readdir', function () {
  var r = makeFS();
  var O_CREAT = 0x40;

  r.fs.open('/one.txt', O_CREAT, 0o644);
  r.fs.open('/two.txt', O_CREAT, 0o644);
  r.fs.open('/three.txt', O_CREAT, 0o644);

  var handle = r.fs.opendir('/');
  assert(handle >= 0);

  var names = [];
  var ent;
  while ((ent = r.fs.readdir(handle)) !== null) {
    names.push(ent.name);
  }

  // Should find at least the three we created (plus . and ..)
  assert(names.indexOf('.') >= 0, 'should have .');
  assert(names.indexOf('..') >= 0, 'should have ..');
  assert(names.indexOf('one.txt') >= 0, 'should have one.txt');
  assert(names.indexOf('two.txt') >= 0, 'should have two.txt');
  assert(names.indexOf('three.txt') >= 0, 'should have three.txt');

  r.fs.closedir(handle);
});

test('readdir returns DT_DIR for directories', function () {
  var r = makeFS();
  r.fs.mkdir('/mydir', 0o755);

  var handle = r.fs.opendir('/');
  var foundDir = false;
  var ent;
  while ((ent = r.fs.readdir(handle)) !== null) {
    if (ent.name === 'mydir') {
      assertEq(ent.type, 4, 'DT_DIR'); // 4 = DT_DIR
      foundDir = true;
    }
  }
  r.fs.closedir(handle);
  assert(foundDir, 'should find mydir');
});

test('opendir non-existent fails', function () {
  var r = makeFS();
  var handle = r.fs.opendir('/nope');
  assert(handle < 0 || handle === null);
  assertEq(r.fs._lastError, 'ENOENT');
});

// ---------------------------------------------------------------
// stat / fstat
// ---------------------------------------------------------------

test('stat returns correct size', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_RDWR = 0x2;

  var fd = r.fs.open('/sized.txt', O_CREAT | O_RDWR, 0o644);
  r.fs.write(fd, encode('1234567890'), 10);
  r.fs.close(fd);

  var st = r.fs.stat('/sized.txt');
  assertEq(st.size, 10);
});

test('fstat on stdout returns character device', function () {
  var r = makeFS();
  var st = r.fs.fstat(1);
  assert((st.mode & 0o170000) === 0o020000, 'S_IFCHR');
});

// ---------------------------------------------------------------
// getcwd / chdir
// ---------------------------------------------------------------

test('getcwd starts at root', function () {
  var r = makeFS();
  assertEq(r.fs.getcwd(), '/');
});

test('chdir and getcwd', function () {
  var r = makeFS();
  r.fs.mkdir('/sub', 0o755);
  r.fs.mkdir('/sub/deep', 0o755);
  r.fs.chdir('/sub/deep');
  assertEq(r.fs.getcwd(), '/sub/deep');
});

test('relative path resolution', function () {
  var r = makeFS();
  var O_CREAT = 0x40;
  r.fs.mkdir('/sub', 0o755);
  r.fs.chdir('/sub');

  // Create file using relative path
  var fd = r.fs.open('localfile.txt', O_CREAT, 0o644);
  assert(fd >= 3);
  r.fs.close(fd);

  // Should exist at /sub/localfile.txt
  var st = r.fs.stat('/sub/localfile.txt');
  assert(st !== null && st !== undefined);
});

// ---------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------

test('pipe read/write', function () {
  var r = makeFS();
  var fds = r.fs.pipe();
  var readFd = fds[0], writeFd = fds[1];

  var data = encode('pipe data');
  r.fs.write(writeFd, data, data.length);

  var buf = new Uint8Array(20);
  var nr = r.fs.read(readFd, buf, 20);
  assertEq(nr, 9);
  assertEq(decode(buf.subarray(0, 9)), 'pipe data');

  r.fs.close(readFd);
  r.fs.close(writeFd);
});

test('pipe EPIPE when read end closed', function () {
  var r = makeFS();
  var fds = r.fs.pipe();
  r.fs.close(fds[0]); // close read end

  var ret = r.fs.write(fds[1], encode('x'), 1);
  assert(ret < 0 || ret === null);
  assertEq(r.fs._lastError, 'EPIPE');

  r.fs.close(fds[1]);
});

// ---------------------------------------------------------------
// dup / dup2
// ---------------------------------------------------------------

test('dup creates new fd', function () {
  var r = makeFS();
  var O_CREAT = 0x40;
  var fd = r.fs.open('/dupfile.txt', O_CREAT, 0o644);

  var fd2 = r.fs.dup(fd);
  assert(fd2 >= 3 && fd2 !== fd, 'dup should return new fd');

  // Writing to the original fd advances position
  r.fs.write(fd, encode('test'), 4);
  // Reading from dup'd fd should show that we're past the data
  r.fs.lseek(fd2, 0, 0);
  var buf = new Uint8Array(10);
  var nr = r.fs.read(fd2, buf, 10);
  assertEq(decode(buf.subarray(0, nr)), 'test');

  r.fs.close(fd);
  r.fs.close(fd2);
});

test('dup2 replaces target fd', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_RDWR = 0x2;

  var fd = r.fs.open('/dup2a.txt', O_CREAT | O_RDWR, 0o644);
  var fd2 = r.fs.open('/dup2b.txt', O_CREAT | O_RDWR, 0o644);

  var ret = r.fs.dup2(fd, fd2);
  assertEq(ret, fd2);
  // fd2 now points to the same file as fd
  r.fs.write(fd, encode('shared'), 6);

  r.fs.lseek(fd2, 0, 0);
  var buf = new Uint8Array(10);
  r.fs.read(fd2, buf, 10);
  assertEq(decode(buf.subarray(0, 6)), 'shared');

  r.fs.close(fd);
  r.fs.close(fd2);
});

// ---------------------------------------------------------------
// access
// ---------------------------------------------------------------

test('access existing file', function () {
  var r = makeFS();
  var O_CREAT = 0x40;
  r.fs.open('/exists.txt', O_CREAT, 0o644);
  assertEq(r.fs.access('/exists.txt', 0), 0);
});

test('access non-existent fails', function () {
  var r = makeFS();
  var ret = r.fs.access('/nope.txt', 0);
  assert(ret < 0 || ret === null);
  assertEq(r.fs._lastError, 'ENOENT');
});

// ---------------------------------------------------------------
// Persistence (close and reopen)
// ---------------------------------------------------------------

test('data survives reopen', function () {
  var store = new MemoryByteStore(1024 * 1024);

  // Create and write data
  var fs1 = BLOCK_FS.create(store);
  var O_CREAT = 0x40, O_RDWR = 0x2;
  var fd = fs1.open('/persist.txt', O_CREAT | O_RDWR, 0o644);
  fs1.write(fd, encode('survives'), 8);
  fs1.close(fd);

  // Reopen from same store
  var fs2 = BLOCK_FS.create(store);
  var fd2 = fs2.open('/persist.txt', O_RDWR, 0o644);
  var buf = new Uint8Array(20);
  var nr = fs2.read(fd2, buf, 20);
  assertEq(decode(buf.subarray(0, nr)), 'survives');
  fs2.close(fd2);
});

test('directory structure survives reopen', function () {
  var store = new MemoryByteStore(1024 * 1024);

  var fs1 = BLOCK_FS.create(store);
  fs1.mkdir('/a', 0o755);
  fs1.mkdir('/a/b', 0o755);
  var O_CREAT = 0x40;
  var fd = fs1.open('/a/b/c.txt', O_CREAT, 0o644);
  fs1.close(fd);

  var fs2 = BLOCK_FS.create(store);
  var st = fs2.stat('/a/b/c.txt');
  assert(st !== null && st !== undefined, 'file should exist after reopen');

  var handle = fs2.opendir('/a/b');
  var names = [];
  var ent;
  while ((ent = fs2.readdir(handle)) !== null) names.push(ent.name);
  assert(names.indexOf('c.txt') >= 0);
  fs2.closedir(handle);
});

// ---------------------------------------------------------------
// Many files
// ---------------------------------------------------------------

test('many files in one directory', function () {
  var r = makeFS();
  var O_CREAT = 0x40;

  for (var i = 0; i < 50; i++) {
    var fd = r.fs.open('/f' + i + '.txt', O_CREAT, 0o644);
    r.fs.close(fd);
  }

  var handle = r.fs.opendir('/');
  var count = 0;
  var ent;
  while ((ent = r.fs.readdir(handle)) !== null) {
    if (ent.name[0] === 'f') count++;
  }
  r.fs.closedir(handle);
  assertEq(count, 50);
});

// ---------------------------------------------------------------
// Large file
// ---------------------------------------------------------------

test('large file read/write (100KB)', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;

  var fd = r.fs.open('/big.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);

  // Write 100KB with a pattern
  var chunk = new Uint8Array(4096);
  for (var i = 0; i < 25; i++) {
    for (var j = 0; j < 4096; j++) chunk[j] = (i + j) & 0xFF;
    r.fs.write(fd, chunk, 4096);
  }

  // Read back and verify at random positions
  r.fs.lseek(fd, 50000, 0);
  var buf = new Uint8Array(100);
  var nr = r.fs.read(fd, buf, 100);
  assertEq(nr, 100);

  // Verify pattern: at offset 50000, block index = 12 (50000/4096),
  // offset within block = 848 (50000%4096), byte value = (12 + 848) & 0xFF = 0x5C
  var expectedByte = (12 + 848) & 0xFF;
  assertEq(buf[0], expectedByte);

  r.fs.close(fd);
});

// ---------------------------------------------------------------
// Stress: max inodes
// ---------------------------------------------------------------

test('allocate many files, verify they all exist', function () {
  var r = makeFS();
  var O_CREAT = 0x40;
  var count = 500; // well within a 1MB store

  for (var i = 0; i < count; i++) {
    var fd = r.fs.open('/f' + i + '.txt', O_CREAT, 0o644);
    assert(fd >= 3, 'create file ' + i);
    r.fs.close(fd);
  }

  // Verify stat works on a sampling
  var st;
  st = r.fs.stat('/f0.txt'); assert(st !== null, 'stat f0');
  st = r.fs.stat('/f' + (count - 1) + '.txt'); assert(st !== null, 'stat f' + (count - 1));
  st = r.fs.stat('/f250.txt'); assert(st !== null, 'stat f250');
});

// ---------------------------------------------------------------
// Stress: large directory (500 entries)
// ---------------------------------------------------------------

test('directory with 500 entries', function () {
  var r = makeFS();
  var O_CREAT = 0x40;

  for (var i = 0; i < 500; i++) {
    var fd = r.fs.open('/entry_' + i + '.dat', O_CREAT, 0o644);
    r.fs.close(fd);
  }

  var handle = r.fs.opendir('/');
  var count = 0;
  var ent;
  while ((ent = r.fs.readdir(handle)) !== null) {
    if (ent.name[0] === 'e') count++;
  }
  r.fs.closedir(handle);
  assertEq(count, 500);

  // Binary search lookup should still find entries
  var st = r.fs.stat('/entry_0.dat');
  assert(st !== null);
  st = r.fs.stat('/entry_499.dat');
  assert(st !== null);
  st = r.fs.stat('/entry_250.dat');
  assert(st !== null);
});

// ---------------------------------------------------------------
// Stress: rename with many files
// ---------------------------------------------------------------

test('rename 100 files in sequence', function () {
  var r = makeFS();
  var O_CREAT = 0x40;

  for (var i = 0; i < 100; i++) {
    var fd = r.fs.open('/orig_' + i + '.txt', O_CREAT, 0o644);
    r.fs.close(fd);
    var ret = r.fs.rename('/orig_' + i + '.txt', '/renamed_' + i + '.txt');
    assertEq(ret, 0, 'rename ' + i);
  }

  // Verify all originals gone and all renames exist
  for (var j = 0; j < 100; j++) {
    assert(r.fs.stat('/orig_' + j + '.txt') === null, 'orig_' + j + ' should not exist');
    assert(r.fs.stat('/renamed_' + j + '.txt') !== null, 'renamed_' + j + ' should exist');
  }
});

// ---------------------------------------------------------------
// Stress: many concurrent open fds
// ---------------------------------------------------------------

test('100 concurrently open files', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_RDWR = 0x2;
  var fds = [];

  for (var i = 0; i < 100; i++) {
    var fd = r.fs.open('/concurrent_' + i + '.bin', O_CREAT | O_RDWR, 0o644);
    assert(fd >= 3, 'fd ' + i + ' should be valid, got ' + fd);
    fds.push(fd);
  }

  // Write to each
  for (var j = 0; j < 100; j++) {
    var expected = 'file_' + j;
    var data = encode(expected);
    var nw = r.fs.write(fds[j], data, data.length);
    assertEq(nw, expected.length, 'write fd ' + j);
  }

  // Seek and read back
  for (var k = 0; k < 100; k++) {
    r.fs.lseek(fds[k], 0, 0);
    var expected = 'file_' + k;
    var buf = new Uint8Array(expected.length);
    r.fs.read(fds[k], buf, expected.length);
    assertEq(decode(buf), expected, 'read back fd ' + k);
  }

  // Close all
  for (var c = 0; c < 100; c++) {
    r.fs.close(fds[c]);
  }
});

// ---------------------------------------------------------------
// Stress: large extent growth (2MB file, single write)
// ---------------------------------------------------------------

test('2MB file write (single write) and verify', function () {
  var store = new MemoryByteStore(8 * 1024 * 1024);
  var fs = BLOCK_FS.create(store);

  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;
  var fd = fs.open('/big2.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3);

  var size = 2 * 1024 * 1024; // 2MB
  var data = new Uint8Array(size);
  for (var i = 0; i < size; i++) data[i] = (i ^ (i >> 8)) & 0xFF;

  var nw = fs.write(fd, data, size);
  assertEq(nw, size, 'write 2MB');

  // Spot checks
  fs.lseek(fd, 0, 0);
  var buf = new Uint8Array(10);
  fs.read(fd, buf, 10);
  assertEq(buf[0], 0, 'byte 0');
  assertEq(buf[9], (9 ^ 0) & 0xFF, 'byte 9');

  fs.lseek(fd, 1000000, 0);
  fs.read(fd, buf, 10);
  assertEq(buf[0], (1000000 ^ (1000000 >> 8)) & 0xFF, 'byte 1M');

  fs.lseek(fd, size - 10, 0);
  fs.read(fd, buf, 10);
  assertEq(buf[9], ((size - 1) ^ ((size - 1) >> 8)) & 0xFF, 'last byte');

  var st = fs.stat('/big2.bin');
  assertEq(st.size, size);

  fs.close(fd);
});

// ---------------------------------------------------------------
// Stress: sequential writes that trigger extent growth
// Exercises the realloc-and-copy path multiple times.
// We use small writes to test growth without the O(n^2) copy issue
// dominating — total file is only 256KB.
// ---------------------------------------------------------------

test('sequential small writes triggering extent growth', function () {
  var r = makeFS();
  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;
  var fd = r.fs.open('/seqgrow.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);

  // Write 1 byte at a time for 512 bytes, forcing several extent reallocs
  // Initial extent is 256 bytes, then doubles to 512
  var total = 0;
  var one = new Uint8Array(1);
  for (var i = 0; i < 512; i++) {
    one[0] = i & 0xFF;
    var nw = r.fs.write(fd, one, 1);
    assertEq(nw, 1, 'write at byte ' + i);
    total++;
  }

  // Read back
  r.fs.lseek(fd, 0, 0);
  var buf = new Uint8Array(total);
  var nr = r.fs.read(fd, buf, total);
  assertEq(nr, total, 'read back ' + total + ' bytes');

  var errors = 0;
  for (var j = 0; j < total; j++) {
    if (buf[j] !== (j & 0xFF)) errors++;
  }
  assertEq(errors, 0, 'data integrity after sequential growth');

  r.fs.close(fd);
});

// ---------------------------------------------------------------
// Stress: delete and recreate many times
// ---------------------------------------------------------------

test('create/delete cycle (200 iterations)', function () {
  var r = makeFS();
  var O_CREAT = 0x40;

  for (var i = 0; i < 200; i++) {
    var fd = r.fs.open('/cycle.txt', O_CREAT, 0o644);
    r.fs.write(fd, encode('data'), 4);
    r.fs.close(fd);
    var ret = r.fs.unlink('/cycle.txt');
    assertEq(ret, 0, 'unlink iteration ' + i);
  }
  // Should be able to create one more time
  var fd2 = r.fs.open('/cycle.txt', O_CREAT, 0o644);
  assert(fd2 >= 3);
  r.fs.close(fd2);
});

// ---------------------------------------------------------------
// Large files (test dynamic pool growth + extent realloc)
// ---------------------------------------------------------------

test('100MB file: write, inspect, read back, verify', function () {
  var store = new MemoryByteStore(4 * 1024 * 1024); // start tiny, force growth
  var fs = BLOCK_FS.create(store);
  var initialSize = store.size();

  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;
  var fd = fs.open('/huge.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3);

  // Write 100MB in 1MB chunks with a per-chunk marker
  var chunkSize = 1024 * 1024; // 1MB
  var chunks = 100;
  var chunk = new Uint8Array(chunkSize);

  for (var i = 0; i < chunks; i++) {
    // First 4 bytes of each chunk: chunk index
    chunk[0] = (i >>> 24) & 0xFF;
    chunk[1] = (i >>> 16) & 0xFF;
    chunk[2] = (i >>> 8) & 0xFF;
    chunk[3] = i & 0xFF;
    // Fill rest with a simple pattern
    for (var j = 4; j < chunkSize; j++) chunk[j] = (i ^ j) & 0xFF;

    var nw = fs.write(fd, chunk, chunkSize);
    assertEq(nw, chunkSize, 'write chunk ' + i);
  }

  // Inspect filesystem state
  var info = fs.inspect();
  assertEq(info.integrityErrors.length, 0, 'integrity: ' + JSON.stringify(info.integrityErrors));
  assert(info.poolSize > initialSize, 'pool should have grown from ' + initialSize + ' to ' + info.poolSize);
  assert(info.bytes.used >= 100 * 1024 * 1024, 'at least 100MB used, got ' + info.bytes.used);
  console.log('    pool grew from ' + (initialSize / 1024 / 1024).toFixed(1) + 'MB to ' + (info.poolSize / 1024 / 1024).toFixed(1) + 'MB, ' + info.blocks.used + ' used blocks, ' + info.blocks.free + ' free blocks');

  // Verify every 10th chunk at random offsets within each chunk
  fs.lseek(fd, 0, 0);
  for (var k = 0; k < chunks; k += 10) {
    fs.lseek(fd, k * chunkSize, 0);
    var marker = new Uint8Array(4);
    fs.read(fd, marker, 4);
    var chunkIdx = (marker[0] << 24) | (marker[1] << 16) | (marker[2] << 8) | marker[3];
    assertEq(chunkIdx, k, 'chunk ' + k + ' marker');

    // Spot check a byte mid-chunk
    fs.lseek(fd, k * chunkSize + 1000, 0);
    var b = new Uint8Array(1);
    fs.read(fd, b, 1);
    assertEq(b[0], (k ^ 1000) & 0xFF, 'chunk ' + k + ' byte 1000');
  }

  // Verify first and last bytes
  fs.lseek(fd, 0, 0);
  var fb = new Uint8Array(1);
  fs.read(fd, fb, 1);
  assertEq(fb[0], (0 >>> 24) & 0xFF, 'first byte');

  fs.lseek(fd, chunks * chunkSize - 1, 0);
  var lb = new Uint8Array(1);
  fs.read(fd, lb, 1);
  assertEq(lb[0], ((chunks - 1) ^ (chunkSize - 1)) & 0xFF, 'last byte');

  var st = fs.stat('/huge.bin');
  assertEq(st.size, chunks * chunkSize, 'stat size');

  fs.close(fd);

  // Inspect after close — should still be consistent
  var info2 = fs.inspect();
  assertEq(info2.integrityErrors.length, 0, 'post-close integrity');
});

test('3 x 32MB files: interleaved writes, verify all', function () {
  var store = new MemoryByteStore(4 * 1024 * 1024);
  var fs = BLOCK_FS.create(store);

  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;
  var fdA = fs.open('/A.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  var fdB = fs.open('/B.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  var fdC = fs.open('/C.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);

  var chunkSize = 1024 * 1024; // 1MB
  var chunksPerFile = 32;
  var chunk = new Uint8Array(chunkSize);

  // Write interleaved: write chunk i to each file in sequence
  for (var i = 0; i < chunksPerFile; i++) {
    for (var j = 0; j < chunkSize; j++) chunk[j] = (i ^ j) & 0xFF;

    // Stamp each file's chunk with a unique prefix
    chunk[0] = 0xAA; chunk[1] = i & 0xFF;
    var nw = fs.write(fdA, chunk, chunkSize);
    assertEq(nw, chunkSize, 'A chunk ' + i);

    chunk[0] = 0xBB; chunk[1] = i & 0xFF;
    nw = fs.write(fdB, chunk, chunkSize);
    assertEq(nw, chunkSize, 'B chunk ' + i);

    chunk[0] = 0xCC; chunk[1] = i & 0xFF;
    nw = fs.write(fdC, chunk, chunkSize);
    assertEq(nw, chunkSize, 'C chunk ' + i);
  }

  // Verify each file at sampled chunks
  function verifyFile(fd, prefix, fileName) {
    for (var k = 0; k < chunksPerFile; k += 8) {
      fs.lseek(fd, k * chunkSize, 0);
      var hdr = new Uint8Array(2);
      fs.read(fd, hdr, 2);
      assertEq(hdr[0], prefix, fileName + ' chunk ' + k + ' prefix byte 0');
      assertEq(hdr[1], k & 0xFF, fileName + ' chunk ' + k + ' prefix byte 1');
    }

    var st = fs.fstat(fd);
    assertEq(st.size, chunksPerFile * chunkSize, fileName + ' size');
  }

  verifyFile(fdA, 0xAA, 'A');
  verifyFile(fdB, 0xBB, 'B');
  verifyFile(fdC, 0xCC, 'C');

  var info = fs.inspect();
  assertEq(info.integrityErrors.length, 0, 'integrity after 3x32MB');
  assert(info.bytes.used >= 3 * 32 * 1024 * 1024, 'at least 96MB used');
  console.log('    3x32MB: pool=' + (info.poolSize / 1024 / 1024).toFixed(1) + 'MB, used=' + (info.bytes.used / 1024 / 1024).toFixed(1) + 'MB, free=' + (info.bytes.free / 1024 / 1024).toFixed(1) + 'MB, largestFree=' + (info.bytes.largestFree / 1024 / 1024).toFixed(1) + 'MB');

  fs.close(fdA); fs.close(fdB); fs.close(fdC);
});

test('delete 100MB file, verify space reclaimed', function () {
  var store = new MemoryByteStore(4 * 1024 * 1024);
  var fs = BLOCK_FS.create(store);

  var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2;
  var fd = fs.open('/reclaim.bin', O_CREAT | O_TRUNC | O_RDWR, 0o644);

  var chunkSize = 1024 * 1024;
  var chunk = new Uint8Array(chunkSize);
  for (var i = 0; i < 80; i++) {
    var nw = fs.write(fd, chunk, chunkSize);
    assertEq(nw, chunkSize, 'write chunk ' + i);
  }
  fs.close(fd);

  var before = fs.inspect();
  var usedBefore = before.bytes.used;

  // Delete the file — space should be reclaimed
  var ret = fs.unlink('/reclaim.bin');
  assertEq(ret, 0, 'unlink');

  var after = fs.inspect();
  assertEq(after.integrityErrors.length, 0, 'integrity after delete');
  assert(after.bytes.free > before.bytes.free, 'free space should increase after delete');
  // The entire 80MB extent should be freed
  console.log('    before delete: used=' + (usedBefore / 1024 / 1024).toFixed(1) + 'MB after: used=' + (after.bytes.used / 1024 / 1024).toFixed(1) + 'MB free=' + (after.bytes.free / 1024 / 1024).toFixed(1) + 'MB');
});

// ---------------------------------------------------------------
// stat/fstat metadata exposure (uid, gid, nlink)
// ---------------------------------------------------------------

var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2, O_WRONLY = 1;
var S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;

test('stat exposes uid/gid/nlink', function () {
  var r = makeFS();
  var fd = r.fs.open('/meta.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  assert(fd >= 3, 'open');
  r.fs.close(fd);

  var st = r.fs.stat('/meta.txt');
  assert(st, 'stat should succeed');
  assertEq(st.uid, 0, 'uid');
  assertEq(st.gid, 0, 'gid');
  assertEq(st.nlink, 1, 'nlink');
  assertEq(st.mode & S_IFMT, S_IFREG, 'is regular file');
  assertEq(st.mode & 0o777, 0o644, 'mode bits');
});

test('fstat exposes uid/gid/nlink', function () {
  var r = makeFS();
  var fd = r.fs.open('/f.txt', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3, 'open');
  var st = r.fs.fstat(fd);
  assertEq(st.uid, 0, 'uid');
  assertEq(st.gid, 0, 'gid');
  assertEq(st.nlink, 1, 'nlink');
  // open() ignores its mode arg and creates 0o644 (DEFAULT_FILE_MODE).
  assertEq(st.mode & 0o777, 0o644, 'create mode bits');
  // fchmod must flow through to a subsequent fstat on the same fd.
  assertEq(r.fs.fchmod(fd, 0o600), 0, 'fchmod');
  assertEq(r.fs.fstat(fd).mode & 0o777, 0o600, 'mode after fchmod');
  r.fs.close(fd);
});

test('chmod updates mode but preserves uid/gid/nlink', function () {
  var r = makeFS();
  var fd = r.fs.open('/c.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);
  assertEq(r.fs.chmod('/c.txt', 0o600), 0, 'chmod');
  var st = r.fs.stat('/c.txt');
  assertEq(st.mode & 0o777, 0o600, 'mode after chmod');
  assertEq(st.uid, 0, 'uid preserved');
  assertEq(st.gid, 0, 'gid preserved');
  assertEq(st.nlink, 1, 'nlink preserved');
});

test('directory stat exposes metadata', function () {
  var r = makeFS();
  assertEq(r.fs.mkdir('/d', 0o755), 0, 'mkdir');
  var st = r.fs.stat('/d');
  assertEq(st.mode & S_IFMT, S_IFDIR, 'is directory');
  assert(st.nlink >= 1, 'nlink >= 1');
  assertEq(st.uid, 0, 'uid');
  assertEq(st.gid, 0, 'gid');
});

// ---------------------------------------------------------------
// statfs() — the basis for `df`
// ---------------------------------------------------------------

test('statfs reports coherent capacity', function () {
  var r = makeFS();
  var sf = r.fs.statfs();
  assert(sf.totalBytes > 0, 'totalBytes > 0');
  assert(sf.freeBytes > 0, 'freeBytes > 0');
  assert(sf.freeBytes <= sf.totalBytes, 'free <= total');
  assertEq(sf.usedBytes, sf.totalBytes - sf.freeBytes, 'used = total - free');
  assertEq(sf.blockSize, 4096, 'blockSize');
  assertEq(sf.totalBlocks, Math.floor(sf.totalBytes / 4096), 'totalBlocks');
  assertEq(sf.freeBlocks, Math.floor(sf.freeBytes / 4096), 'freeBlocks');
  assertEq(sf.nameMax, 255, 'nameMax');
  assert(sf.storeSize >= sf.totalBytes, 'storeSize >= totalBytes');
  assert(sf.totalInodes >= 1, 'totalInodes >= 1');
});

test('statfs free space tracks writes and deletes', function () {
  var r = makeFS();
  var free0 = r.fs.statfs().freeBytes;

  var fd = r.fs.open('/big.bin', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  var chunk = new Uint8Array(100 * 1024); // 100 KB
  var nw = r.fs.write(fd, chunk, chunk.length);
  assertEq(nw, chunk.length, 'write 100KB');
  r.fs.close(fd);

  var sf1 = r.fs.statfs();
  assert(sf1.freeBytes < free0, 'free decreased after write: ' + sf1.freeBytes + ' !< ' + free0);
  assert(sf1.usedBytes > 0, 'used > 0');

  assertEq(r.fs.unlink('/big.bin'), 0, 'unlink');
  var sf2 = r.fs.statfs();
  assert(sf2.freeBytes > sf1.freeBytes, 'free increased after delete');
});

test('statfs inode counts track files', function () {
  var r = makeFS();
  var used0 = r.fs.statfs().usedInodes;
  for (var i = 0; i < 3; i++) {
    var fd = r.fs.open('/file' + i, O_CREAT | O_TRUNC | O_WRONLY, 0o644);
    r.fs.close(fd);
  }
  var sf = r.fs.statfs();
  assertEq(sf.usedInodes, used0 + 3, 'usedInodes += 3');
  assertEq(sf.freeInodes, sf.totalInodes - sf.usedInodes, 'freeInodes = total - used');
});

// ---------------------------------------------------------------
// atime / btime (stored in the reclaimed uid/gid + reserved bytes)
// ---------------------------------------------------------------

test('new file stamps btime/atime/mtime/ctime at creation', function () {
  var r = makeFS();
  r.fs._now = function () { return 1000; };
  var fd = r.fs.open('/n.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);
  var st = r.fs.stat('/n.txt');
  assertEq(st.btime, 1000, 'btime');
  assertEq(st.atime, 1000, 'atime');
  assertEq(st.mtime, 1000, 'mtime');
  assertEq(st.ctime, 1000, 'ctime');
  assertEq(st.uid, 0, 'uid constant 0');
  assertEq(st.gid, 0, 'gid constant 0');
});

test('btime is frozen across writes while mtime advances', function () {
  var r = makeFS();
  var t = 1000;
  r.fs._now = function () { return t; };
  var fd = r.fs.open('/b.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);
  assertEq(r.fs.stat('/b.txt').btime, 1000, 'btime at creation');

  t = 2000;
  fd = r.fs.open('/b.txt', O_WRONLY, 0o644);
  r.fs.write(fd, encode('hello'), 5);
  r.fs.close(fd);
  var st = r.fs.stat('/b.txt');
  assertEq(st.btime, 1000, 'btime unchanged after write');
  assertEq(st.mtime, 2000, 'mtime advanced after write');
});

test('atime bumps on read then stays put (relatime)', function () {
  var r = makeFS();
  var t = 1000;
  r.fs._now = function () { return t; };
  var fd = r.fs.open('/a.txt', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  r.fs.write(fd, encode('data'), 4);
  r.fs.close(fd);

  // First read after the write: atime (1000) <= mtime (1000), so it bumps.
  t = 1500;
  fd = r.fs.open('/a.txt', 0, 0); // O_RDONLY
  var buf = new Uint8Array(4);
  assertEq(r.fs.read(fd, buf, 4), 4, 'read');
  r.fs.close(fd);
  assertEq(r.fs.stat('/a.txt').atime, 1500, 'atime bumped to read time');

  // Second read later: atime (1500) now exceeds mtime/ctime → no rewrite.
  t = 2000;
  fd = r.fs.open('/a.txt', 0, 0); // O_RDONLY
  r.fs.read(fd, buf, 4);
  r.fs.close(fd);
  assertEq(r.fs.stat('/a.txt').atime, 1500, 'atime not bumped again (relatime)');
});

test('chmod bumps ctime, not btime or mtime', function () {
  var r = makeFS();
  var t = 1000;
  r.fs._now = function () { return t; };
  var fd = r.fs.open('/c2.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);
  t = 3000;
  assertEq(r.fs.chmod('/c2.txt', 0o600), 0, 'chmod');
  var st = r.fs.stat('/c2.txt');
  assertEq(st.btime, 1000, 'btime unchanged by chmod');
  assertEq(st.mtime, 1000, 'mtime unchanged by chmod');
  assertEq(st.ctime, 3000, 'ctime bumped by chmod');
});

test('zeroed legacy bytes read as atime/btime 0 (old-image compat)', function () {
  var r = makeFS();
  var fd = r.fs.open('/legacy', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);
  // Pre-atime/btime images had these bytes as uid/gid/reserved == 0.
  var inoId = r.fs.stat('/legacy').ino;
  var ino = r.fs._inodes.read(inoId);
  ino.btime = 0; ino.atime = 0;
  r.fs._inodes.write(inoId, ino);
  var st = r.fs.stat('/legacy');
  assertEq(st.btime, 0, 'btime 0 = unknown');
  assertEq(st.atime, 0, 'atime 0 = unknown');
  assertEq(st.mode & S_IFMT, S_IFREG, 'rest of inode intact');
});

// ---------------------------------------------------------------
// Hard links (regression: unlink must respect the file's link count)
// ---------------------------------------------------------------

test('hard link shares inode and survives unlink of the original', function () {
  var r = makeFS();
  var fd = r.fs.open('/orig', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.write(fd, encode('hello'), 5);
  r.fs.close(fd);

  assertEq(r.fs.link('/orig', '/hard'), 0, 'link');
  var so = r.fs.stat('/orig'), sh = r.fs.stat('/hard');
  assertEq(so.ino, sh.ino, 'same inode');
  assertEq(so.nlink, 2, 'nlink == 2 after link (orig)');
  assertEq(sh.nlink, 2, 'nlink == 2 after link (hard)');

  // Remove the original — the hard link must remain fully usable.
  assertEq(r.fs.unlink('/orig'), 0, 'unlink orig');
  assertEq(r.fs.stat('/orig'), null, 'orig gone');
  var sh2 = r.fs.stat('/hard');
  assert(sh2, 'hard still exists');
  assertEq(sh2.nlink, 1, 'nlink back to 1 after one unlink');

  var rfd = r.fs.open('/hard', 0, 0);
  var buf = new Uint8Array(5);
  assertEq(r.fs.read(rfd, buf, 5), 5, 'read hard');
  r.fs.close(rfd);
  assertEq(decode(buf), 'hello', 'content intact via hard link');

  assertEq(r.fs.unlink('/hard'), 0, 'unlink hard (last link)');
  assertEq(r.fs.stat('/hard'), null, 'hard gone');
});

test('single-link file: unlink frees the inode and reclaims space', function () {
  var r = makeFS();
  var fd = r.fs.open('/solo', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  var chunk = new Uint8Array(50 * 1024);
  r.fs.write(fd, chunk, chunk.length);
  r.fs.close(fd);
  var free0 = r.fs.statfs().freeBytes;
  assertEq(r.fs.stat('/solo').nlink, 1, 'nlink 1');
  assertEq(r.fs.unlink('/solo'), 0, 'unlink');
  assertEq(r.fs.stat('/solo'), null, 'gone');
  assert(r.fs.statfs().freeBytes > free0, 'space reclaimed');
});

test('link/unlink update ctime (link count change)', function () {
  var r = makeFS();
  var t = 1000;
  r.fs._now = function () { return t; };
  var fd = r.fs.open('/lc', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);
  assertEq(r.fs.stat('/lc').ctime, 1000, 'ctime at creation');

  t = 2000;
  assertEq(r.fs.link('/lc', '/lc2'), 0, 'link');
  assertEq(r.fs.stat('/lc').ctime, 2000, 'ctime bumped by link');

  t = 3000;
  assertEq(r.fs.unlink('/lc2'), 0, 'unlink one link');
  assertEq(r.fs.stat('/lc').ctime, 3000, 'ctime bumped by unlink of a link');
});

// ---------------------------------------------------------------
// write() updates ctime as well as mtime
// ---------------------------------------------------------------

test('write bumps both mtime and ctime, not btime', function () {
  var r = makeFS();
  var t = 1000;
  r.fs._now = function () { return t; };
  var fd = r.fs.open('/wc.txt', O_CREAT | O_TRUNC | O_WRONLY, 0o644);
  r.fs.close(fd);

  t = 2000;
  fd = r.fs.open('/wc.txt', O_WRONLY, 0o644);
  r.fs.write(fd, encode('data'), 4);
  r.fs.close(fd);
  var st = r.fs.stat('/wc.txt');
  assertEq(st.mtime, 2000, 'mtime advanced');
  assertEq(st.ctime, 2000, 'ctime advanced (write changes the inode)');
  assertEq(st.btime, 1000, 'btime unchanged');
});

// ---------------------------------------------------------------
// Symbolic links (real, followable — added 2026-06)
// ---------------------------------------------------------------

var S_IFMT_T = 0o170000, S_IFLNK_T = 0o120000, S_IFREG_T = 0o100000;
function mkfile(fs, path, text) {
  var fd = fs.open(path, 0x40 | 0x200 | 1, 0o644);  // O_CREAT|O_TRUNC|O_WRONLY
  if (text && text.length) fs.write(fd, encode(text), text.length);
  fs.close(fd);
}
function readlinkStr(fs, path) {
  var buf = new Uint8Array(512);
  var n = fs.readlink(path, buf, buf.length);
  return (typeof n === 'number' && n >= 0) ? decode(buf.subarray(0, n)) : null;
}

test('symlink: lstat reports a link, stat follows to the target', function () {
  var r = makeFS();
  mkfile(r.fs, '/target.txt', 'payload');
  assertEq(r.fs.symlink('/target.txt', '/link'), 0, 'symlink ok');
  assertEq(r.fs.lstat('/link').mode & S_IFMT_T, S_IFLNK_T, 'lstat: link type');
  var st = r.fs.stat('/link');
  assertEq(st.mode & S_IFMT_T, S_IFREG_T, 'stat: follows to a regular file');
  assertEq(st.size, 7, 'stat reports the target size');
});

test('symlink: open/read follows the link to target content', function () {
  var r = makeFS();
  mkfile(r.fs, '/t.txt', 'hello');
  r.fs.symlink('/t.txt', '/l');
  var fd = r.fs.open('/l', 0, 0);
  assert(fd >= 3, 'open through link');
  var buf = new Uint8Array(5); r.fs.read(fd, buf, 5); r.fs.close(fd);
  assertEq(decode(buf), 'hello', 'read through symlink');
});

test('readlink returns the target; EINVAL on a non-symlink', function () {
  var r = makeFS();
  r.fs.symlink('/some/where', '/lnk');
  assertEq(readlinkStr(r.fs, '/lnk'), '/some/where', 'readlink target');
  mkfile(r.fs, '/plain', 'x');
  assertEq(r.fs.readlink('/plain', new Uint8Array(16), 16), null, 'readlink non-link fails');
  assertEq(r.fs._lastError, 'EINVAL', 'EINVAL set for a non-symlink');
});

test('a symlink in an intermediate path component is followed', function () {
  var r = makeFS();
  r.fs.mkdir('/real', 0o755);
  mkfile(r.fs, '/real/f.txt', 'xy');
  r.fs.symlink('/real', '/alias');              // directory symlink
  var st = r.fs.stat('/alias/f.txt');
  assert(st && st.size === 2, 'resolved through the dir symlink');
});

test('a relative symlink target resolves against the link directory', function () {
  var r = makeFS();
  r.fs.mkdir('/d', 0o755);
  mkfile(r.fs, '/d/real.txt', 'zzz');
  r.fs.symlink('real.txt', '/d/rel');           // relative target
  var st = r.fs.stat('/d/rel');
  assert(st && st.size === 3, 'relative target resolved in /d');
});

test('a symlink loop is ELOOP, not a hang', function () {
  var r = makeFS();
  r.fs.symlink('/b', '/a');
  r.fs.symlink('/a', '/b');
  assertEq(r.fs.stat('/a'), null, 'loop returns null');
  assertEq(r.fs._lastError, 'ELOOP', 'ELOOP set');
});

test('unlink removes the symlink, not its target', function () {
  var r = makeFS();
  mkfile(r.fs, '/keep.txt', 'k');
  r.fs.symlink('/keep.txt', '/l');
  assertEq(r.fs.unlink('/l'), 0, 'unlink the link');
  assertEq(r.fs.lstat('/l'), null, 'link entry gone');
  var st = r.fs.stat('/keep.txt');
  assert(st && st.size === 1, 'target survives');
});

test('rename moves the symlink itself (not its target)', function () {
  var r = makeFS();
  mkfile(r.fs, '/tgt', 't');
  r.fs.symlink('/tgt', '/a');
  assertEq(r.fs.rename('/a', '/b'), 0, 'rename link');
  assertEq(r.fs.lstat('/a'), null, 'old name gone');
  assertEq(r.fs.lstat('/b').mode & S_IFMT_T, S_IFLNK_T, 'new name is the link');
  assertEq(readlinkStr(r.fs, '/b'), '/tgt', 'target preserved across rename');
});

// ---------------------------------------------------------------

console.log('--- BlockFS Tests ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);

if (failed > 0) process.exit(1);
