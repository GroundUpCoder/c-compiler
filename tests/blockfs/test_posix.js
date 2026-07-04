#!/usr/bin/env node
'use strict';
// POSIX-semantics regression tests for BlockFS (host.js).
//
// Each case pins down a confirmed defect against the behavior POSIX requires.
// These tests are EXPECTED TO FAIL until host.js is fixed — they assert the
// correct behavior, not the current one. Each case runs in its own fresh
// MemoryByteStore so one failure can't cascade into another, and each case
// finishes by running the independent fsck checker over the raw store.

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var { fsck } = require('./fsck.js');

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL ' + name + ': ' + (e.message || e));
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

var O_CREAT = 0x40, O_TRUNC = 0x200, O_RDWR = 0x2, O_WRONLY = 1;

// Fresh v3 filesystem per test (matches test_blockfs.js / fsck.js, which
// guards on superblock VERSION 3).
function makeFS() {
  var store = new MemoryByteStore(1024 * 1024);
  return { fs: BLOCK_FS.create(store), store: store };
}

function mkfile(fs, path, text) {
  var fd = fs.open(path, O_CREAT | O_TRUNC | O_RDWR, 0o644);
  if (fd === null || fd < 0) throw new Error('create ' + path + ' failed: ' + fs._lastError);
  if (text && text.length) {
    var b = encode(text);
    if (fs.write(fd, b, b.length) !== b.length)
      throw new Error('write ' + path + ' failed: ' + fs._lastError);
  }
  fs.close(fd);
}

// Read up to `max` bytes from the fd's current position, as a string.
function readStr(fs, fd, max) {
  var buf = new Uint8Array(max);
  var n = fs.read(fd, buf, max);
  if (n === null || n < 0) throw new Error('read failed: ' + fs._lastError);
  return decode(buf.subarray(0, n));
}

// Read a whole file by path, as a string.
function readFile(fs, path, max) {
  var fd = fs.open(path, 0, 0); // O_RDONLY
  if (fd === null || fd < 0) throw new Error('open ' + path + ' failed: ' + fs._lastError);
  var s = readStr(fs, fd, max || 4096);
  fs.close(fd);
  return s;
}

function fsckClean(store, label) {
  var p = fsck(store);
  assert(p.length === 0, (label || 'image') + ' fsck should be clean, got:\n  ' + p.join('\n  '));
}

function isErr(ret) { return ret === null || ret < 0; }

// ---------------------------------------------------------------
// 1. unlink-while-open — POSIX: unlinking the last name of an open file
//    removes the name but the file (data + inode) lives on until the last
//    fd is closed. TODAY host.js frees the inode + extent at unlink time,
//    so the fd reads empty and post-close writes leak blocks.
// ---------------------------------------------------------------

test('unlink-while-open', function () {
  var r = makeFS();
  var fd = r.fs.open('/f.txt', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3, 'open');
  var b = encode('hello');
  assertEq(r.fs.write(fd, b, b.length), 5, 'write hello');

  assertEq(r.fs.unlink('/f.txt'), 0, 'unlink');
  assertEq(r.fs.stat('/f.txt'), null, 'name gone after unlink');

  // Data must remain readable through the still-open fd.
  r.fs.lseek(fd, 0, 0);
  assertEq(readStr(r.fs, fd, 32), 'hello', 'read via open fd after unlink');

  // fstat must show a live-but-unlinked file: nlink 0, real size.
  var st = r.fs.fstat(fd);
  assert(st, 'fstat after unlink');
  assertEq(st.nlink, 0, 'fstat nlink after unlink');
  assertEq(st.size, 5, 'fstat size after unlink');

  // Further writes via the fd must work and read back.
  r.fs.lseek(fd, 0, 2); // SEEK_END
  var more = encode(' more');
  assertEq(r.fs.write(fd, more, more.length), 5, 'write via fd after unlink');
  r.fs.lseek(fd, 0, 0);
  assertEq(readStr(r.fs, fd, 32), 'hello more', 'read back appended data');

  // Once the last fd closes, everything must be reclaimed — no leaks.
  assertEq(r.fs.close(fd), 0, 'close');
  fsckClean(r.store, 'after close');
});

// ---------------------------------------------------------------
// 2. rename-over-open — POSIX: rename(/a, /b) while /b is open must leave
//    the open fd attached to /b's ORIGINAL file. TODAY the target inode is
//    freed out from under the fd.
// ---------------------------------------------------------------

test('rename-over-open', function () {
  var r = makeFS();
  mkfile(r.fs, '/a', 'AAAA');
  mkfile(r.fs, '/b', 'BBBB');

  var fd = r.fs.open('/b', 0, 0); // O_RDONLY on the victim
  assert(fd >= 3, 'open /b');

  assertEq(r.fs.rename('/a', '/b'), 0, 'rename /a over /b');

  // The fd must still see /b's original contents.
  assertEq(readStr(r.fs, fd, 32), 'BBBB', 'fd reads original /b contents');

  // The name /b now refers to what was /a.
  assertEq(readFile(r.fs, '/b', 32), 'AAAA', '/b path has /a contents');

  assertEq(r.fs.close(fd), 0, 'close');
  fsckClean(r.store, 'after close');
});

// ---------------------------------------------------------------
// 3. rename-same-inode — POSIX: if oldpath and newpath are hard links to
//    the same file, rename() "shall do nothing and return successfully" —
//    neither directory entry is removed. TODAY host.js frees the shared
//    inode (it is the rename target) and leaves /b pointing at a dead slot.
// ---------------------------------------------------------------

test('rename-same-inode', function () {
  var r = makeFS();
  mkfile(r.fs, '/a', 'content');
  assertEq(r.fs.link('/a', '/b'), 0, 'hard link /a -> /b');

  assertEq(r.fs.rename('/a', '/b'), 0, 'rename over same inode succeeds (no-op)');

  var sa = r.fs.stat('/a');
  var sb = r.fs.stat('/b');
  assert(sa, '/a still resolves (POSIX: neither entry removed)');
  assert(sb, '/b still resolves');
  assertEq(sa.ino, sb.ino, 'still the same inode');
  assertEq(readFile(r.fs, '/b', 32), 'content', 'contents intact');

  fsckClean(r.store, 'after same-inode rename');
});

// ---------------------------------------------------------------
// 4. rename-rollback-enotdir — a failing rename must leave the source
//    intact. TODAY the ENOTDIR exit path (new parent is a regular file)
//    forgets to restore the already-removed source dirent, orphaning the
//    source file.
// ---------------------------------------------------------------

test('rename-rollback-enotdir', function () {
  var r = makeFS();
  mkfile(r.fs, '/src', 'precious');
  mkfile(r.fs, '/notadir', 'x');

  var ret = r.fs.rename('/src', '/notadir/dst');
  assert(isErr(ret), 'rename into a file "directory" must fail, got ' + ret);

  var st = r.fs.stat('/src');
  assert(st, '/src must still exist after the failed rename');
  assertEq(readFile(r.fs, '/src', 32), 'precious', '/src contents intact');

  fsckClean(r.store, 'after failed rename');
});

// ---------------------------------------------------------------
// 5. hole-zero-fill — POSIX: bytes in the gap created by writing past EOF
//    (after lseek beyond the end) read back as 0. TODAY the gap exposes
//    whatever garbage was in the recycled extent.
// ---------------------------------------------------------------

test('hole-zero-fill', function () {
  var r = makeFS();

  // Poison the free pool: a big 0xEE file, then free its extent.
  var junk = new Uint8Array(8192).fill(0xEE);
  var jfd = r.fs.open('/junk', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assertEq(r.fs.write(jfd, junk, junk.length), junk.length, 'write junk');
  r.fs.close(jfd);
  assertEq(r.fs.unlink('/junk'), 0, 'unlink junk');

  // Fresh file, seek past EOF, write one byte — bytes 0..99 form a hole.
  var fd = r.fs.open('/hole', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3, 'open /hole');
  assertEq(r.fs.lseek(fd, 100, 0), 100, 'lseek past EOF');
  var one = new Uint8Array([0x5A]);
  assertEq(r.fs.write(fd, one, 1), 1, 'write 1 byte at offset 100');

  r.fs.lseek(fd, 0, 0);
  var buf = new Uint8Array(101);
  assertEq(r.fs.read(fd, buf, 101), 101, 'read whole file');
  for (var i = 0; i < 100; i++) {
    assertEq(buf[i], 0, 'hole byte ' + i + ' must read as zero');
  }
  assertEq(buf[100], 0x5A, 'written byte intact');

  r.fs.close(fd);
  fsckClean(r.store, 'after hole write');
});

// ---------------------------------------------------------------
// 6. tlsf-v3-mapping-wrap — a near-4GiB allocation request on a v3 fs must
//    either fail cleanly (ENOSPC) or genuinely allocate. TODAY the 32-bit
//    TLSF size mapping wraps, so the request "succeeds" while massively
//    under-allocating (or blows up mid-write).
// ---------------------------------------------------------------

test('tlsf-v3-mapping-wrap', function () {
  var r = makeFS();
  var fd = r.fs.open('/big', O_CREAT | O_TRUNC | O_RDWR, 0o644);
  assert(fd >= 3, 'open /big');

  var FAR = 0xF9000000; // ~3.9 GiB
  assertEq(r.fs.lseek(fd, FAR, 0), FAR, 'lseek to far offset');

  var data = encode('WXYZ');
  var ret;
  try {
    ret = r.fs.write(fd, data, 4);
  } catch (e) {
    throw new Error('write threw instead of failing cleanly: ' + (e.message || e));
  }

  if (ret === 4) {
    // Claims success — it must be genuine: data readable at the far offset.
    assertEq(r.fs.lseek(fd, FAR, 0), FAR, 'lseek back');
    var buf = new Uint8Array(4);
    assertEq(r.fs.read(fd, buf, 4), 4, 'read back at far offset');
    assertEq(decode(buf), 'WXYZ', 'far data intact');
  } else {
    assert(isErr(ret), 'write must fail cleanly or succeed, got ' + ret);
  }

  r.fs.close(fd);
  fsckClean(r.store, 'after huge-allocation attempt');
});

// ---------------------------------------------------------------
// 7. symlink-nlink-symmetry — every other dirent-creating op (open-create,
//    mkdir, mknod, link) bumps the parent directory's nlink, and unlink
//    decrements it. symlink() forgets the bump, so each create+unlink cycle
//    drives the parent's nlink down (eventually underflowing).
// ---------------------------------------------------------------

test('symlink-nlink-symmetry', function () {
  var r = makeFS();
  mkfile(r.fs, '/target', 't');
  var base = r.fs.stat('/').nlink;

  for (var i = 1; i <= 3; i++) {
    assertEq(r.fs.symlink('/target', '/s'), 0, 'symlink cycle ' + i);
    assertEq(r.fs.unlink('/s'), 0, 'unlink cycle ' + i);
    assertEq(r.fs.stat('/').nlink, base,
      'parent nlink restored after create+unlink cycle ' + i);
  }
  fsckClean(r.store, 'after symlink cycles');
});

// ---------------------------------------------------------------
// 8. pipe-dup-end-refcount — dup'ing a pipe end must reference-count it:
//    closing ONE of two read fds leaves the read side open, so writes still
//    succeed and the surviving fd reads the data. TODAY close() marks the
//    shared pipe's read side closed outright -> EPIPE.
// ---------------------------------------------------------------

test('pipe-dup-end-refcount', function () {
  var r = makeFS();
  var fds = r.fs.pipe();
  var rfd = fds[0], wfd = fds[1];
  assert(rfd >= 3 && wfd >= 3, 'pipe fds');

  var rfd2 = r.fs.dup(rfd);
  assert(rfd2 >= 3 && rfd2 !== rfd, 'dup read end');

  assertEq(r.fs.close(rfd), 0, 'close one read fd');

  var data = encode('ping');
  var nw = r.fs.write(wfd, data, 4);
  assertEq(nw, 4, 'write must succeed while a read fd survives (err=' + r.fs._lastError + ')');

  var buf = new Uint8Array(4);
  assertEq(r.fs.read(rfd2, buf, 4), 4, 'surviving read fd gets the data');
  assertEq(decode(buf), 'ping', 'pipe payload');

  r.fs.close(rfd2);
  r.fs.close(wfd);
});

// ---------------------------------------------------------------
// 9. fcntl-dupfd-pipe — F_DUPFD IS reachable without a broker: BlockFS
//    exposes fcntl_dupfd(oldfd, minfd) directly on the instance (no broker
//    needed for in-process pipes), so no skip. Same refcount requirement as
//    case 8, via the F_DUPFD duplication path.
// ---------------------------------------------------------------

test('fcntl-dupfd-pipe', function () {
  var r = makeFS();
  var fds = r.fs.pipe();
  var rfd = fds[0], wfd = fds[1];

  var rfd2 = r.fs.fcntl_dupfd(rfd, 10);
  assert(rfd2 !== null && rfd2 >= 10, 'F_DUPFD allocates fd >= minfd, got ' + rfd2);

  assertEq(r.fs.close(rfd), 0, 'close original read fd');

  var data = encode('pong');
  var nw = r.fs.write(wfd, data, 4);
  assertEq(nw, 4, 'write must succeed while F_DUPFD read fd survives (err=' + r.fs._lastError + ')');

  var buf = new Uint8Array(4);
  assertEq(r.fs.read(rfd2, buf, 4), 4, 'F_DUPFD read fd gets the data');
  assertEq(decode(buf), 'pong', 'pipe payload');

  r.fs.close(rfd2);
  r.fs.close(wfd);
});

// ---------------------------------------------------------------

console.log('--- POSIX-semantics Tests ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);

if (failed > 0) process.exit(1);
