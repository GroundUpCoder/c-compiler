#!/usr/bin/env node
'use strict';
// MountFS semantics (todos/0026): the mount layer the OS embedders hand to
// Kernel({fs}) — longest-prefix routing across two BlockFS volumes
// ('/' system, '/root' user), the mount-namespace fd/dir-handle tables,
// POSIX edges (EXDEV on cross-volume rename/link, EBUSY on mount points),
// absolute-symlink escape in BOTH directions, and _lastError propagation.
// No kernel object needed: the kernel funnels every fs access through this
// exact method surface (_fsRpc), so driving MountFS directly IS the
// contract test. Walk internals + fsck live in tests/blockfs/test_mounts.js;
// in-OS acceptance (seed split, reseed survival) in test_os_boot.js.

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok ' + name);
  } catch (e) {
    failed++;
    console.error('FAIL ' + name + ': ' + (e.message || e) + (e.stack ? '\n' + e.stack : ''));
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

var O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0x40, O_TRUNC = 0x200;
var S_IFMT = 0xF000, S_IFDIR = 0x4000, S_IFLNK = 0xA000;

function writeFile(fs, path, text, mode) {
  var fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode || 0o644);
  if (fd === null) throw new Error('open ' + path + ': ' + fs._lastError);
  var b = encode(text);
  fs.write(fd, b, b.length);
  fs.close(fd);
}
function readFile(fs, path) {
  var fd = fs.open(path, 0, 0);
  if (fd === null) return null;
  var st = fs.fstat(fd);
  var buf = new Uint8Array(st.size);
  var n = fs.read(fd, buf, st.size);
  fs.close(fd);
  return decode(buf.subarray(0, n === null ? 0 : n));
}

function fresh() {
  var sys = BLOCK_FS.createV4(new MemoryByteStore(4 << 20));
  var usr = BLOCK_FS.createV4(new MemoryByteStore(4 << 20));
  var m = new BLOCK_FS.MountFS({ '/': sys, '/root': usr });
  m.mkdir('/bin', 0o755);
  m.mkdir('/etc', 0o755);
  m.mkdir('/tmp', 0o777);
  return { m: m, sys: sys, usr: usr };
}

// ---- prefix routing ----

test('routing: writes land on the owning volume, prefix stripped', function () {
  var f = fresh();
  writeFile(f.m, '/bin/cc', 'CC', 0o755);
  writeFile(f.m, '/root/todo.txt', 'TODO');
  assert(f.sys.stat('/bin/cc') !== null, 'system file on system volume');
  assert(f.usr.stat('/todo.txt') !== null, 'user file on user volume, prefix stripped');
  assert(f.sys.stat('/todo.txt') === null && f.usr.stat('/bin') === null, 'no cross-pollution');
  // similar names must not match the prefix: /rootx is NOT under /root
  writeFile(f.m, '/rootx', 'NOT-USER');
  assert(f.sys.stat('/rootx') !== null && f.usr.stat('/x') === null, '/rootx routes to /');
});

test('routing: mount-point dir exists in the outer volume; readdir needs no synthesis', function () {
  var f = fresh();
  var st = f.sys.stat('/root');
  assert(st !== null && (st.mode & S_IFMT) === S_IFDIR, '/root dir materialized in the system volume');
  var h = f.m.opendir('/'), names = [];
  for (var e; (e = f.m.readdir(h)) !== null;) names.push(e.name);
  f.m.closedir(h);
  assert(names.indexOf('root') >= 0 && names.indexOf('bin') >= 0, 'ls / lists both');
});

test('routing: stat/readdir across the mount point', function () {
  var f = fresh();
  writeFile(f.m, '/root/a', 'A');
  writeFile(f.m, '/root/b', 'B');
  var st = f.m.stat('/root');
  assert(st !== null && (st.mode & S_IFMT) === S_IFDIR, 'stat of the mount point is the inner root');
  var h = f.m.opendir('/root'), names = [];
  for (var e; (e = f.m.readdir(h)) !== null;) if (e.name[0] !== '.') names.push(e.name);
  f.m.closedir(h);
  // (the user volume also carries its own /dev — createV4 self-heals it)
  assert(names.indexOf('a') >= 0 && names.indexOf('b') >= 0,
    'readdir of the mount point lists the user volume: ' + names.join(','));
});

// ---- fd namespace ----

test('fd ops: one namespace over both volumes; lseek/fstat/ftruncate/futime/fchmod', function () {
  var f = fresh();
  var fdS = f.m.open('/etc/motd', O_WRONLY | O_CREAT, 0o644);
  var fdU = f.m.open('/root/notes', O_WRONLY | O_CREAT, 0o644);
  assert(fdS !== null && fdU !== null && fdS !== fdU, 'distinct fds across volumes');
  f.m.write(fdS, encode('hello system'), 12);
  f.m.write(fdU, encode('hello user'), 10);
  assertEq(f.m.fstat(fdS).size, 12);
  assertEq(f.m.fstat(fdU).size, 10);
  f.m.ftruncate(fdU, 5);
  f.m.fchmod(fdU, 0o600);
  f.m.futime(fdU, 111, 222);
  f.m.close(fdS);
  f.m.close(fdU);
  assertEq(readFile(f.m, '/root/notes'), 'hello');
  var st = f.m.stat('/root/notes');
  assertEq(st.mode & 0o777, 0o600, 'fchmod through the map');
  assertEq(st.mtime, 222, 'futime through the map');
  var fd = f.m.open('/etc/motd', O_RDWR, 0);
  assertEq(f.m.lseek(fd, 6, 0), 6, 'lseek');
  var buf = new Uint8Array(6);
  assertEq(f.m.read(fd, buf, 6), 6);
  assertEq(decode(buf), 'system');
  f.m.close(fd);
  assert(f.m.read(fd, buf, 1) === null && f.m._lastError === 'EBADF', 'closed fd is EBADF');
});

test('fd ops: dup / fcntl_dupfd stay on the owning volume', function () {
  var f = fresh();
  writeFile(f.m, '/root/d', 'dupdata');
  var fd = f.m.open('/root/d', 0, 0);
  var d1 = f.m.dup(fd);
  var d2 = f.m.fcntl_dupfd(fd, 10);
  assert(d1 !== null && d2 >= 10, 'dup + F_DUPFD(min)');
  var buf = new Uint8Array(7);
  assertEq(f.m.read(d1, buf, 7), 7);
  assertEq(decode(buf), 'dupdata');
  f.m.close(fd); f.m.close(d1); f.m.close(d2);
});

// ---- POSIX edges ----

test('EXDEV: cross-volume rename and link refuse; in-volume ones work', function () {
  var f = fresh();
  writeFile(f.m, '/etc/x', 'X');
  writeFile(f.m, '/root/y', 'Y');
  assert(f.m.rename('/etc/x', '/root/x') === null && f.m._lastError === 'EXDEV', 'rename sys->user');
  assert(f.m.rename('/root/y', '/etc/y') === null && f.m._lastError === 'EXDEV', 'rename user->sys');
  assert(f.m.link('/etc/x', '/root/xl') === null && f.m._lastError === 'EXDEV', 'link sys->user');
  assert(f.m.rename('/etc/x', '/etc/x2') === 0 && readFile(f.m, '/etc/x2') === 'X', 'in-volume rename');
  assert(f.m.link('/root/y', '/root/y2') === 0 && f.m.stat('/root/y2').nlink === 2, 'in-volume link');
});

test('EBUSY: unlink/rmdir/rename on the mount point refuse', function () {
  var f = fresh();
  assert(f.m.unlink('/root') === null && f.m._lastError === 'EBUSY', 'unlink');
  assert(f.m.rmdir('/root') === null && f.m._lastError === 'EBUSY', 'rmdir');
  assert(f.m.rename('/root', '/home') === null && f.m._lastError === 'EBUSY', 'rename away');
  assert(f.m.rename('/tmp', '/root') === null && f.m._lastError === 'EBUSY', 'rename onto');
  assert(f.m.rmdir('/root/.') === null && f.m._lastError === 'EBUSY', 'normalized alias');
});

// ---- symlink escape, both directions ----

test('escape: user-volume link -> /bin/... resolves on the system volume', function () {
  var f = fresh();
  writeFile(f.m, '/bin/sh', 'SHELL', 0o755);
  f.m.symlink('/bin/sh', '/root/sh');
  assertEq(readFile(f.m, '/root/sh'), 'SHELL', 'open follows the escape');
  assertEq(f.m.stat('/root/sh').size, 5, 'stat follows the escape');
  assert((f.m.lstat('/root/sh').mode & S_IFMT) === S_IFLNK, 'lstat sees the link itself');
  var buf = new Uint8Array(64);
  var n = f.m.readlink('/root/sh', buf, 64);
  assertEq(decode(buf.subarray(0, n)), '/bin/sh', 'readlink returns the full-namespace text');
  assertEq(f.m.unlink('/root/sh'), 0);
  assert(f.usr.lstat('/sh') === null && f.m.stat('/bin/sh') !== null,
    'unlink removed the link on the user volume, not the target');
});

test('escape: system-volume link -> /root/... resolves on the user volume', function () {
  var f = fresh();
  writeFile(f.m, '/root/data', 'USERDATA');
  f.m.symlink('/root/data', '/etc/data');
  assertEq(readFile(f.m, '/etc/data'), 'USERDATA');
  // and writes through it land on the user volume
  var fd = f.m.open('/etc/data', O_WRONLY | O_TRUNC, 0);
  f.m.write(fd, encode('REWRITTEN'), 9);
  f.m.close(fd);
  assertEq(readFile(f.usr, '/data'), 'REWRITTEN');
});

test('escape: mid-path symlink + O_CREAT creates on the target volume', function () {
  var f = fresh();
  f.m.symlink('/etc', '/root/e');
  var fd = f.m.open('/root/e/made-here', O_WRONLY | O_CREAT, 0o644);
  assert(fd !== null, 'creat through the escaping component');
  f.m.write(fd, encode('sys'), 3);
  f.m.close(fd);
  assert(f.sys.stat('/etc/made-here') !== null, 'file landed on the system volume');
  // raw-volume lstat (never follows): the user volume holds only the link
  assert((f.usr.lstat('/e').mode & S_IFMT) === S_IFLNK,
    'nothing created beside the link on the user volume');
  assert(f.usr.lstat('/made-here') === null, 'no stray file on the user volume');
});

test("escape: relative '..' target climbs over the mount root", function () {
  var f = fresh();
  writeFile(f.m, '/etc/passwd', 'root:0');
  f.m.symlink('../etc/passwd', '/root/rel');
  assertEq(readFile(f.m, '/root/rel'), 'root:0');
});

test('escape: cross-volume symlink loop is ELOOP, not a hang', function () {
  var f = fresh();
  f.m.symlink('/etc/l2', '/root/l1');
  f.m.symlink('/root/l1', '/etc/l2');
  assert(f.m.stat('/root/l1') === null && f.m._lastError === 'ELOOP');
});

test('escape: mkdir/unlink through an escaping directory symlink', function () {
  var f = fresh();
  f.m.symlink('/root', '/etc/home');           // system link to the whole user volume
  assertEq(f.m.mkdir('/etc/home/newdir', 0o755), 0);
  assert(f.usr.stat('/newdir') !== null, 'mkdir landed on the user volume');
  writeFile(f.m, '/etc/home/tmp.txt', 'T');
  assertEq(f.m.unlink('/etc/home/tmp.txt'), 0);
  assert(f.usr.stat('/tmp.txt') === null, 'unlink through the link');
});

// ---- read-only volume under the mount (todos/0040) ----
// The flipped reference layout: writable root at '/', a READONLY system
// volume at /usr, /bin -> /usr/bin, /usr/local -> /var/local. The kernel
// funnels fs RPCs through this exact surface, so EROFS/_lastError here IS
// what a process sees.

function fresh0040() {
  var sysStore = new MemoryByteStore(4 << 20);
  var rw = BLOCK_FS.createV4(sysStore, { noDevNodes: true });   // bake stand-in
  rw.mkdir('/bin', 0o755);
  rw.mkdir('/share', 0o755);
  var fd = rw.open('/bin/sh', O_WRONLY | O_CREAT, 0o755);
  rw.write(fd, encode('SH'), 2);
  rw.close(fd);
  rw.symlink('/var/local', '/local');
  var sys = BLOCK_FS.createV4(sysStore, { readonly: true });
  var root = BLOCK_FS.createV4(new MemoryByteStore(4 << 20));
  var m = new BLOCK_FS.MountFS({ '/': root, '/usr': sys });
  m.mkdir('/var', 0o755);
  m.mkdir('/var/local', 0o755);
  m.mkdir('/var/local/bin', 0o755);
  m.symlink('/usr/bin', '/bin');
  return { m: m, root: root };
}

test('readonly /usr: every mutator on the RPC surface is EROFS', function () {
  var f = fresh0040();
  assert(f.m.open('/usr/bin/evil', O_WRONLY | O_CREAT, 0o755) === null &&
    f.m._lastError === 'EROFS', 'creat');
  assert(f.m.open('/bin/evil', O_WRONLY | O_CREAT, 0o755) === null &&
    f.m._lastError === 'EROFS', 'creat via the /bin symlink');
  assert(f.m.open('/usr/bin/sh', O_WRONLY, 0) === null && f.m._lastError === 'EROFS', 'open for write');
  assert(f.m.unlink('/usr/bin/sh') === null && f.m._lastError === 'EROFS', 'unlink');
  assert(f.m.mkdir('/usr/newdir', 0o755) === null && f.m._lastError === 'EROFS', 'mkdir');
  assert(f.m.rmdir('/usr/share') === null && f.m._lastError === 'EROFS', 'rmdir');
  assert(f.m.rename('/usr/bin/sh', '/usr/bin/sh2') === null && f.m._lastError === 'EROFS', 'rename');
  assert(f.m.link('/usr/bin/sh', '/usr/bin/sh2') === null && f.m._lastError === 'EROFS', 'link');
  assert(f.m.symlink('/x', '/usr/lnk') === null && f.m._lastError === 'EROFS', 'symlink');
  assert(f.m.chmod('/usr/bin/sh', 0o600) === null && f.m._lastError === 'EROFS', 'chmod');
  assert(f.m.utime('/usr/bin/sh', 1, 2) === null && f.m._lastError === 'EROFS', 'utime');
  var fd = f.m.open('/usr/bin/sh', 0, 0);
  assert(fd !== null, 'O_RDONLY still opens');
  assert(f.m.write(fd, encode('X'), 1) === null && f.m._lastError === 'EROFS', 'write on a read fd');
  assert(f.m.ftruncate(fd, 0) === null && f.m._lastError === 'EROFS', 'ftruncate');
  f.m.close(fd);
});

test('readonly /usr: reads, the /bin symlink, and the /usr/local escape work', function () {
  var f = fresh0040();
  assertEq(readFile(f.m, '/bin/sh'), 'SH', 'binary loads via /bin -> /usr/bin');
  assertEq(readFile(f.m, '/usr/bin/sh'), 'SH', 'and directly');
  writeFile(f.m, '/usr/local/bin/mytool', 'MINE', 0o755);
  assertEq(readFile(f.m, '/var/local/bin/mytool'), 'MINE', '/usr/local escaped to /var/local');
  assert(f.root.stat('/var/local/bin/mytool') !== null, 'on the writable volume');
  var h = f.m.opendir('/usr/bin'), names = [];
  for (var e; (e = f.m.readdir(h)) !== null;) if (e.name[0] !== '.') names.push(e.name);
  f.m.closedir(h);
  assert(names.indexOf('sh') >= 0, 'readdir of the RO volume: ' + names.join(','));
});

test('immutableKey (todos/0037): non-null only for RO-volume regular files', function () {
  var f = fresh0040();
  var k = f.m.immutableKey('/usr/bin/sh');
  assert(typeof k === 'string' && k.length > 0, 'RO regular file keys');
  assertEq(f.m.immutableKey('/bin/sh'), k, 'alias via the /bin symlink shares the key');
  assertEq(f.m.immutableKey('/usr/bin/sh'), k, 'key is stable across calls');
  f.m.mkdir('/root', 0o755);
  writeFile(f.m, '/root/a.out', 'AOUT', 0o755);
  assert(f.m.immutableKey('/root/a.out') === null, 'rw-volume binary keys null');
  assert(f.m.immutableKey('/usr/bin') === null, 'directories key null');
  assert(f.m.immutableKey('/usr/bin/nope') === null, 'ENOENT keys null');
  // /usr/local escapes to the WRITABLE /var/local — must key null even
  // though the path spells /usr.
  writeFile(f.m, '/usr/local/bin/mytool', 'MINE', 0o755);
  assert(f.m.immutableKey('/usr/local/bin/mytool') === null,
    'the /usr/local -> /var/local escape keys null');
  // Single-volume BlockFS: rw keys null; readonly keys the same shape.
  var rwSolo = BLOCK_FS.createV4(new MemoryByteStore(1 << 20));
  writeFile(rwSolo, '/x', 'X', 0o755);
  assert(rwSolo.immutableKey('/x') === null, 'standalone rw BlockFS keys null');
});

// ---- error propagation + resolve ----

test('_lastError propagates from the routed volume', function () {
  var f = fresh();
  assert(f.m.stat('/nope') === null && f.m._lastError === 'ENOENT', 'ENOENT from /');
  assert(f.m.stat('/root/nope') === null && f.m._lastError === 'ENOENT', 'ENOENT from /root');
  assert(f.m.mkdir('/bin', 0o755) === null && f.m._lastError === 'EEXIST', 'EEXIST from /');
  writeFile(f.m, '/root/f', 'F');
  assert(f.m.open('/root/f', O_CREAT | 0x80, 0o644) === null && f.m._lastError === 'EEXIST',
    'O_EXCL EEXIST from /root');
  assert(f.m.rmdir('/root/f') === null && f.m._lastError === 'ENOTDIR', 'ENOTDIR from /root');
});

test('_resolvePath + chdir/getcwd (the FS_REALPATH/FS_CHDIR surface)', function () {
  var f = fresh();
  assertEq(f.m._resolvePath('/root/../etc//./x'), '/etc/x', 'lexical collapse');
  f.m.mkdir('/root/proj', 0o755);
  assertEq(f.m.chdir('/root/proj'), 0);
  assertEq(f.m.getcwd(), '/root/proj');
  writeFile(f.m, 'rel.txt', 'REL');           // relative to the MountFS cwd
  assertEq(readFile(f.m, '/root/proj/rel.txt'), 'REL');
  assert(f.m.chdir('/root/proj/rel.txt') === null && f.m._lastError === 'ENOTDIR');
  f.m.chdir('/');
});

console.log('\ntest_mounts (kernel): ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
