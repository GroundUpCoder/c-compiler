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
// 10. socket-node — AF_UNIX rendezvous nodes (todos/0008): mknod with
//     S_IFSOCK creates a real socket inode (v4: mknod needs rdev), stat
//     reports the type, open() refuses it with ENXIO (POSIX), and plain
//     unlink removes it. No fsck pass: fsck guards on VERSION 3 and this
//     needs a v4 store.
// ---------------------------------------------------------------

test('socket-node', function () {
  var store = new MemoryByteStore(1024 * 1024);
  var fs = BLOCK_FS.createV4(store);
  var S_IFSOCK = 0o140000;

  assertEq(fs.mknod('/srv.sock', S_IFSOCK | 0o777, 0), 0, 'mknod S_IFSOCK');
  var st = fs.stat('/srv.sock');
  assert(st && (st.mode & 0o170000) === S_IFSOCK, 'stat reports S_IFSOCK');

  assertEq(fs.open('/srv.sock', O_RDWR, 0), null, 'open() on a socket node fails');
  assertEq(fs._lastError, 'ENXIO', 'and the errno is ENXIO');
  assertEq(fs.open('/srv.sock', O_CREAT | O_RDWR, 0o644), null, 'O_CREAT does not bypass it');
  assertEq(fs._lastError, 'ENXIO', 'ENXIO again');

  assertEq(fs.mknod('/srv.sock', S_IFSOCK | 0o777, 0), null, 'mknod on a taken path fails');
  assertEq(fs._lastError, 'EEXIST', 'with EEXIST (the kernel maps it to EADDRINUSE)');

  assertEq(fs.unlink('/srv.sock'), 0, 'unlink removes the socket node');
  assertEq(fs.stat('/srv.sock'), null, 'gone');
});

// ---------------------------------------------------------------
// 11. create-through-symlink (todos/0375) — open(O_CREAT) whose final
//     component is a dangling symlink must create the TARGET (POSIX; the
//     final symlink is followed even when creating). The pre-fix create
//     branch inserted a SECOND dirent under the link's own lexical name —
//     a duplicate directory entry, i.e. on-disk corruption. The same
//     lexical-insert class lived in mkdir/mknod/link's EEXIST checks
//     (full-follow walk: a dangling link answered "doesn't exist").
// ---------------------------------------------------------------

function listNames(fs, path) {
  var h = fs.opendir(path);
  if (h === null) throw new Error('opendir ' + path + ': ' + fs._lastError);
  var names = [], e;
  while ((e = fs.readdir(h)) !== null) {
    if (e.name !== '.' && e.name !== '..') names.push(e.name);
  }
  fs.closedir(h);
  return names;
}
function countName(fs, dir, name) {
  return listNames(fs, dir).filter(function (n) { return n === name; }).length;
}

test('open(O_CREAT) through a dangling symlink creates the target, not a dup dirent', function () {
  var r = makeFS();
  assertEq(r.fs.symlink('/t', '/l'), 0, 'symlink /l -> /t');
  var fd = r.fs.open('/l', O_CREAT | O_RDWR, 0o644);
  assert(fd !== null && fd >= 0, 'open(/l, O_CREAT) succeeds (err=' + r.fs._lastError + ')');
  var b = encode('via-link');
  assertEq(r.fs.write(fd, b, b.length), b.length, 'write through the fd');
  r.fs.close(fd);

  assertEq(countName(r.fs, '/', 'l'), 1, 'exactly ONE dirent named l (the symlink)');
  assertEq(countName(r.fs, '/', 't'), 1, 'exactly ONE dirent named t (the created target)');
  var st = r.fs.stat('/t');
  assert(st !== null, 'stat(/t): the TARGET was created');
  assertEq(st.size, b.length, 'target holds the written bytes');
  var lst = r.fs.lstat('/l');
  assert(lst !== null && (lst.mode & 0o170000) === 0o120000, '/l is still a symlink');

  // unlink of the link removes the LINK, and only it — pre-fix this removed
  // the first duplicate (the new file) and resurrected the symlink.
  assertEq(r.fs.unlink('/l'), 0, 'unlink /l');
  assertEq(r.fs.lstat('/l'), null, '/l is gone');
  assert(r.fs.stat('/t') !== null, '/t survives');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('open(O_CREAT) through a CHAIN of dangling symlinks creates the final target', function () {
  var r = makeFS();
  assertEq(r.fs.symlink('/b', '/a'), 0, 'a -> b');
  assertEq(r.fs.symlink('/c', '/b'), 0, 'b -> c');
  var fd = r.fs.open('/a', O_CREAT | O_RDWR, 0o644);
  assert(fd !== null && fd >= 0, 'open(/a, O_CREAT) follows the chain (err=' + r.fs._lastError + ')');
  r.fs.close(fd);
  assert(r.fs.stat('/c') !== null, '/c (the chain end) was created');
  assertEq(countName(r.fs, '/', 'a'), 1, 'one dirent a');
  assertEq(countName(r.fs, '/', 'b'), 1, 'one dirent b');
  assertEq(countName(r.fs, '/', 'c'), 1, 'one dirent c');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('open(O_CREAT) through a dangling symlink with a RELATIVE target', function () {
  var r = makeFS();
  assertEq(r.fs.mkdir('/d', 0o755), 0, 'mkdir /d');
  assertEq(r.fs.symlink('t2', '/d/l2'), 0, 'symlink /d/l2 -> t2 (relative)');
  var fd = r.fs.open('/d/l2', O_CREAT | O_RDWR, 0o644);
  assert(fd !== null && fd >= 0, 'open(/d/l2, O_CREAT) (err=' + r.fs._lastError + ')');
  r.fs.close(fd);
  assert(r.fs.stat('/d/t2') !== null, 'relative target resolved against the LINK\'s directory');
  assertEq(countName(r.fs, '/d', 'l2'), 1, 'one dirent l2');
  assertEq(countName(r.fs, '/d', 't2'), 1, 'one dirent t2');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('open(O_CREAT|O_EXCL) on a dangling symlink is EEXIST (POSIX), never a dup', function () {
  var r = makeFS();
  var O_EXCL = 0x80;
  assertEq(r.fs.symlink('/t', '/l'), 0, 'symlink /l -> /t');
  assertEq(r.fs.open('/l', O_CREAT | O_EXCL | O_RDWR, 0o644), null, 'O_EXCL refuses');
  assertEq(r.fs._lastError, 'EEXIST', 'errno EEXIST');
  assertEq(r.fs.stat('/t'), null, 'target NOT created');
  assertEq(countName(r.fs, '/', 'l'), 1, 'still exactly one dirent l');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('open(O_CREAT) on a symlink loop is ELOOP; directory unchanged', function () {
  var r = makeFS();
  assertEq(r.fs.symlink('/self', '/self'), 0, 'self -> self');
  assertEq(r.fs.open('/self', O_CREAT | O_RDWR, 0o644), null, 'open fails');
  assertEq(r.fs._lastError, 'ELOOP', 'errno ELOOP');
  assertEq(countName(r.fs, '/', 'self'), 1, 'exactly one dirent self');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('open(O_CREAT) through a symlink whose target parent is missing is ENOENT', function () {
  var r = makeFS();
  assertEq(r.fs.symlink('/nodir/t', '/l'), 0, 'symlink /l -> /nodir/t');
  assertEq(r.fs.open('/l', O_CREAT | O_RDWR, 0o644), null, 'open fails');
  assertEq(r.fs._lastError, 'ENOENT', 'errno ENOENT');
  assertEq(countName(r.fs, '/', 'l'), 1, 'exactly one dirent l — nothing inserted');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('mkdir over a dangling symlink is EEXIST, never a dup dirent', function () {
  var r = makeFS();
  assertEq(r.fs.symlink('/t', '/l'), 0, 'symlink /l -> /t');
  assertEq(r.fs.mkdir('/l', 0o755), null, 'mkdir(/l) refuses');
  assertEq(r.fs._lastError, 'EEXIST', 'errno EEXIST (POSIX: mkdir never follows the final symlink)');
  assertEq(countName(r.fs, '/', 'l'), 1, 'exactly one dirent l');
  assertEq(r.fs.stat('/t'), null, 'no target dir created');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('link() with newpath a dangling symlink is EEXIST, never a dup dirent', function () {
  var r = makeFS();
  mkfile(r.fs, '/src', 'data');
  assertEq(r.fs.symlink('/t', '/l'), 0, 'symlink /l -> /t');
  assertEq(r.fs.link('/src', '/l'), null, 'link(/src, /l) refuses');
  assertEq(r.fs._lastError, 'EEXIST', 'errno EEXIST');
  assertEq(countName(r.fs, '/', 'l'), 1, 'exactly one dirent l');
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('mknod over a dangling symlink is EEXIST, never a dup dirent (v4)', function () {
  // v4 store: mknod needs the rdev inode field; no v3-fsck pass (VERSION guard).
  var store = new MemoryByteStore(1024 * 1024);
  var fs = BLOCK_FS.createV4(store);
  assertEq(fs.symlink('/t', '/l'), 0, 'symlink /l -> /t');
  assertEq(fs.mknod('/l', 0o020666, 0x0103), null, 'mknod(/l) refuses');
  assertEq(fs._lastError, 'EEXIST', 'errno EEXIST');
  assertEq(countName(fs, '/', 'l'), 1, 'exactly one dirent l');
  var p4 = require('./fsck_v4.js').fsck(store);
  assert(p4.length === 0, 'fsck_v4 clean, got:\n  ' + p4.join('\n  '));
});

// ---------------------------------------------------------------
// todos/0376 — fds carry their access mode (open()'s flags & O_ACCMODE).
// The defect: no mode was stored on the fd entry at all, so write() on an
// O_RDONLY fd silently mutated the file (the corruption half — defensive
// read-only opens protected nothing) and read() on an O_WRONLY fd disclosed
// it (the lesser half). POSIX: both are EBADF.
// ---------------------------------------------------------------

test('write() on an O_RDONLY fd is EBADF and the file is untouched', function () {
  var r = makeFS();
  mkfile(r.fs, '/f', 'SAFE');
  var fd = r.fs.open('/f', 0, 0);              // O_RDONLY
  assert(fd !== null && fd >= 0, 'open O_RDONLY');
  assertEq(r.fs.write(fd, encode('EVIL'), 4), null, 'write refused');
  assertEq(r.fs._lastError, 'EBADF', 'errno EBADF');
  var buf = new Uint8Array(4);
  assertEq(r.fs.read(fd, buf, 4), 4, 'read on the same fd still works');
  assertEq(decode(buf), 'SAFE', 'file untouched by the refused write');
  r.fs.close(fd);
  var p = fsck(r.store);
  assert(p.length === 0, 'fsck clean, got:\n  ' + p.join('\n  '));
});

test('read() on an O_WRONLY fd is EBADF; write on it still works', function () {
  var r = makeFS();
  mkfile(r.fs, '/f', 'SAFE');
  var fd = r.fs.open('/f', O_WRONLY, 0);
  assert(fd !== null && fd >= 0, 'open O_WRONLY');
  var buf = new Uint8Array(4);
  assertEq(r.fs.read(fd, buf, 4), null, 'read refused');
  assertEq(r.fs._lastError, 'EBADF', 'errno EBADF');
  assertEq(r.fs.write(fd, encode('GOOD'), 4), 4, 'write on the same fd works');
  r.fs.close(fd);
});

test('O_RDWR reads and writes (positive control)', function () {
  var r = makeFS();
  mkfile(r.fs, '/f', 'SAFE');
  var fd = r.fs.open('/f', O_RDWR, 0);
  var buf = new Uint8Array(4);
  assertEq(r.fs.read(fd, buf, 4), 4, 'read works');
  assertEq(r.fs.write(fd, encode('MORE'), 4), 4, 'write works');
  r.fs.close(fd);
});

test('the access mode rides dup()/dup2()/F_DUPFD (shared description)', function () {
  var r = makeFS();
  mkfile(r.fs, '/f', 'SAFE');
  var fd = r.fs.open('/f', 0, 0);              // O_RDONLY
  var d1 = r.fs.dup(fd);
  assertEq(r.fs.write(d1, encode('EVIL'), 4), null, 'write on dup() refused');
  assertEq(r.fs._lastError, 'EBADF', 'errno EBADF');
  assertEq(r.fs.dup2(fd, 20), 20, 'dup2 to 20');
  assertEq(r.fs.write(20, encode('EVIL'), 4), null, 'write on dup2() refused');
  var d2 = r.fs.fcntl_dupfd(fd, 10);
  assertEq(r.fs.write(d2, encode('EVIL'), 4), null, 'write on F_DUPFD refused');
  r.fs.close(fd); r.fs.close(d1); r.fs.close(20); r.fs.close(d2);
});

test('ftruncate() on an O_RDONLY fd is EINVAL (POSIX); file intact', function () {
  var r = makeFS();
  mkfile(r.fs, '/f', 'SAFE');
  var fd = r.fs.open('/f', 0, 0);              // O_RDONLY
  assertEq(r.fs.ftruncate(fd, 0), null, 'ftruncate refused');
  assertEq(r.fs._lastError, 'EINVAL', 'errno EINVAL');
  var buf = new Uint8Array(4);
  assertEq(r.fs.read(fd, buf, 4), 4, 'still 4 bytes');
  assertEq(decode(buf), 'SAFE', 'file untouched');
  r.fs.close(fd);
});

test('pipe ends refuse the wrong direction (same class, fixed ends)', function () {
  var r = makeFS();
  var fds = r.fs.pipe();
  var rfd = fds[0], wfd = fds[1];
  assertEq(r.fs.write(rfd, encode('x'), 1), null, 'write on the read end refused');
  assertEq(r.fs._lastError, 'EBADF', 'errno EBADF');
  var buf = new Uint8Array(1);
  assertEq(r.fs.read(wfd, buf, 1), null, 'read on the write end refused');
  assertEq(r.fs._lastError, 'EBADF', 'errno EBADF');
  assertEq(r.fs.write(wfd, encode('p'), 1), 1, 'right-direction write flows');
  assertEq(r.fs.read(rfd, buf, 1), 1, 'right-direction read flows');
  assertEq(decode(buf), 'p', 'payload');
  r.fs.close(rfd); r.fs.close(wfd);
});

// ---------------------------------------------------------------

console.log('--- POSIX-semantics Tests ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);

if (failed > 0) process.exitCode = 1;
