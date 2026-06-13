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

console.log('--- BlockFS Tests ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);

if (failed > 0) process.exit(1);
