#!/usr/bin/env node
'use strict';
// MountFS walk mechanics (todos/0026) at the BlockFS level: the
// _mountPrefix/_mountOwns hooks in _walkHops (full-namespace symlink
// resolution — in-volume prefix strip vs the __mountEscape throw), the
// single-volume regression guard (no hooks -> unchanged behavior), and a
// mixed workload across two volumes after which BOTH stores must pass the
// independent v4 fsck. Semantic coverage (EXDEV/EBUSY/fd namespaces/
// _lastError) lives in tests/kernel/test_mounts.js.

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var { fsck } = require('./fsck_v4.js');

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

var O_WRONLY = 1, O_CREAT = 0x40, O_TRUNC = 0x200;

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

function freshPair() {
  var sysStore = new MemoryByteStore(4 << 20);
  var usrStore = new MemoryByteStore(4 << 20);
  var sys = BLOCK_FS.createV4(sysStore);
  var usr = BLOCK_FS.createV4(usrStore);
  var m = new BLOCK_FS.MountFS({ '/': sys, '/root': usr });
  return { m: m, sys: sys, usr: usr, sysStore: sysStore, usrStore: usrStore };
}

// ---- single-volume regression: no hooks -> absolute targets stay in-volume ----

test('standalone volume: absolute symlink target resolves in-volume (unchanged)', function () {
  var fs = BLOCK_FS.createV4(new MemoryByteStore(1 << 20));
  assert(fs._mountOwns === null, 'no mount hook on a standalone volume');
  fs.mkdir('/a', 0o755);
  writeFile(fs, '/a/x', 'IN-VOLUME');
  fs.symlink('/a/x', '/lnk');
  assertEq(readFile(fs, '/lnk'), 'IN-VOLUME', 'absolute target walks this volume');
});

// ---- the escape throw itself ----

test('_walkHops throws __mountEscape with the full-namespace continuation', function () {
  var p = freshPair();
  p.m.mkdir('/etc', 0o755);
  p.m.symlink('/etc/target', '/root/lnk');   // user-volume link -> system path
  var threw = null;
  try { p.usr.stat('/lnk'); } catch (e) { threw = e; }
  assert(threw && threw.__mountEscape, 'escape thrown from the raw volume walk');
  assertEq(threw.__mountEscape, '/etc/target', 'full-namespace continuation');
  assertEq(threw.__mountFrom, '/lnk', 'tagged with the walked path');
});

test('escape splices the rest of the path after the symlink component', function () {
  var p = freshPair();
  p.m.symlink('/etc', '/root/e');
  var threw = null;
  try { p.usr.stat('/e/sub/file'); } catch (e) { threw = e; }
  assert(threw && threw.__mountEscape, 'escape thrown');
  assertEq(threw.__mountEscape, '/etc/sub/file', 'rest spliced onto the target');
  assertEq(threw.__mountFrom, '/e/sub/file');
});

test('in-volume absolute target strips the mount prefix (no escape)', function () {
  var p = freshPair();
  writeFile(p.m, '/root/data', 'D');
  p.m.symlink('/root/data', '/root/self');   // absolute, but stays in the user volume
  assertEq(readFile(p.usr, '/self'), 'D', 'raw volume walk resolves without escaping');
});

test("relative target with '..' climbs over the mount root and escapes", function () {
  var p = freshPair();
  p.m.mkdir('/etc', 0o755);
  writeFile(p.m, '/etc/passwd', 'root:0');
  p.m.symlink('../etc/passwd', '/root/rel');
  assertEq(readFile(p.m, '/root/rel'), 'root:0', 'climb resolved through MountFS');
  var threw = null;
  try { p.usr.stat('/rel'); } catch (e) { threw = e; }
  assert(threw && threw.__mountEscape === '/etc/passwd', 'raw walk escapes to /etc/passwd');
});

// ---- mixed workload, then both volumes fsck clean ----

test('mixed workload across both volumes; both stores pass fsck independently', function () {
  var p = freshPair();
  var m = p.m;
  m.mkdir('/bin', 0o755);
  m.mkdir('/etc', 0o755);
  m.mkdir('/root/proj', 0o755);

  // files + rewrite + truncate on both volumes
  for (var i = 0; i < 20; i++) {
    writeFile(m, '/bin/tool' + i, 'system tool #' + i, 0o755);
    writeFile(m, '/root/proj/f' + i + '.txt', 'user file #' + i);
  }
  var fd = m.open('/root/proj/f3.txt', 0x2, 0);        // O_RDWR
  m.lseek(fd, 0, 2);
  m.write(fd, encode(' appended'), 9);
  m.ftruncate(fd, 4);
  m.close(fd);

  // symlinks both directions + a hard link in-volume
  m.symlink('/bin/tool1', '/root/t1');
  m.symlink('/root/proj/f1.txt', '/etc/uf1');
  m.link('/bin/tool2', '/bin/tool2-hard');
  assertEq(readFile(m, '/root/t1'), 'system tool #1');
  assertEq(readFile(m, '/etc/uf1'), 'user file #1');

  // creation THROUGH an escaping symlink; rename/unlink churn
  m.symlink('/etc', '/root/etclink');
  writeFile(m, '/root/etclink/via-link', 'landed on system');
  assertEq(readFile(m, '/etc/via-link'), 'landed on system');
  m.rename('/root/proj/f5.txt', '/root/proj/f5-renamed.txt');
  assert(m.rename('/root/proj/f6.txt', '/etc/f6') === null && m._lastError === 'EXDEV',
    'cross-volume rename refused');
  m.unlink('/bin/tool7');
  m.unlink('/root/proj/f7.txt');
  m.rmdir('/root/proj') === null;                       // ENOTEMPTY, ignored
  m.unlink('/root/t1');                                 // link itself, not tool1
  assert(m.stat('/bin/tool1') !== null, 'symlink unlink left the target');

  // deep dirs + chmod/utime through the mount
  m.mkdir('/root/proj/deep', 0o755);
  writeFile(m, '/root/proj/deep/x', 'deep');
  m.chmod('/root/proj/deep/x', 0o600);
  m.utime('/root/proj/deep/x', 1000, 2000);

  var sysProblems = fsck(p.sysStore);
  var usrProblems = fsck(p.usrStore);
  assert(sysProblems.length === 0, 'system volume fsck: ' + sysProblems.join('; '));
  assert(usrProblems.length === 0, 'user volume fsck: ' + usrProblems.join('; '));
});

console.log('\ntest_mounts (blockfs): ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
