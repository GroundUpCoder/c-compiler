#!/usr/bin/env node
'use strict';
// Read-only volumes + sealed blobs (todos/0040): createV4({readonly}) must
// refuse every mutating op with EROFS (and never write through the store —
// ReadOnlyStore is the backstop), while reads stay fully functional. The
// seal (sealVolume/verifySeal + the fsck_v4 hash check) is the offline
// tamper detector for baked system images. The MountFS legs prove the
// 0040 layout mechanics: a RO volume at /usr, /bin -> /usr/bin, and
// /usr/local -> /var/local escaping back into writable territory.

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

var O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0x40, O_TRUNC = 0x200, O_APPEND = 0x400;

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

// A populated image to mount readonly: /bin/tool, /share/os-release, a
// symlink, a subdir — baked with a normal rw mount over the same store.
function bakedStore() {
  var store = new MemoryByteStore(1 << 20);
  var fs = BLOCK_FS.createV4(store, { noDevNodes: true });
  fs.mkdir('/bin', 0o755);
  fs.mkdir('/share', 0o755);
  writeFile(fs, '/bin/tool', 'TOOL', 0o755);
  writeFile(fs, '/share/os-release', 'VERSION_ID=1\n');
  fs.symlink('/bin/tool', '/bin/alias');
  return store;
}

function erofs(fs, name, ret) {
  assert(ret === null, name + ' must fail (returned ' + ret + ')');
  assertEq(fs._lastError, 'EROFS', name + ' errno');
}

// ---- the readonly mount itself ----

test('readonly mount of an unformatted store throws (never formats)', function () {
  var threw = false;
  try { BLOCK_FS.createV4(new MemoryByteStore(1 << 20), { readonly: true }); }
  catch (e) { threw = true; }
  assert(threw, 'must throw instead of formatting');
});

test('reads work: open/read/stat/lstat/access/readdir/readlink', function () {
  var ro = BLOCK_FS.createV4(bakedStore(), { readonly: true });
  assertEq(readFile(ro, '/bin/tool'), 'TOOL', 'file content');
  assertEq(readFile(ro, '/bin/alias'), 'TOOL', 'through the symlink');
  assert(ro.stat('/bin/tool') !== null, 'stat');
  assert(ro.lstat('/bin/alias') !== null, 'lstat');
  assertEq(ro.access('/bin/tool', 0), 0, 'access');
  var h = ro.opendir('/bin');
  var names = [];
  var ent;
  while ((ent = ro.readdir(h)) !== null) names.push(ent.name);
  ro.closedir(h);
  assert(names.indexOf('tool') >= 0 && names.indexOf('alias') >= 0, 'readdir: ' + names.join(','));
  var buf = new Uint8Array(64);
  var n = ro.readlink('/bin/alias', buf, 64);
  assertEq(decode(buf.subarray(0, n)), '/bin/tool', 'readlink');
});

test('every mutating op returns EROFS', function () {
  var ro = BLOCK_FS.createV4(bakedStore(), { readonly: true });
  erofs(ro, 'open O_WRONLY', ro.open('/bin/tool', O_WRONLY, 0));
  erofs(ro, 'open O_RDWR', ro.open('/bin/tool', O_RDWR, 0));
  erofs(ro, 'open O_CREAT', ro.open('/new', O_WRONLY | O_CREAT, 0o644));
  erofs(ro, 'open O_TRUNC', ro.open('/bin/tool', O_TRUNC, 0));
  erofs(ro, 'open O_APPEND', ro.open('/bin/tool', O_APPEND, 0));
  erofs(ro, 'mkdir', ro.mkdir('/newdir', 0o755));
  erofs(ro, 'mknod', ro.mknod('/dev0', 0o020666, 1));
  erofs(ro, 'rmdir', ro.rmdir('/share'));
  erofs(ro, 'unlink', ro.unlink('/bin/tool'));
  erofs(ro, 'rename', ro.rename('/bin/tool', '/bin/tool2'));
  erofs(ro, 'link', ro.link('/bin/tool', '/bin/hard'));
  erofs(ro, 'symlink', ro.symlink('/bin/tool', '/lnk2'));
  erofs(ro, 'chmod', ro.chmod('/bin/tool', 0o600));
  erofs(ro, 'utime', ro.utime('/bin/tool', 1, 2));
  var fd = ro.open('/bin/tool', O_RDONLY, 0);
  assert(fd !== null, 'O_RDONLY open still works');
  // EBADF, not EROFS (todos/0376): the fd carries its access mode now, and
  // the only fd a readonly volume can hand out is O_RDONLY — POSIX puts the
  // fd-mode check before the mount flag (Linux agrees: write(2) on an
  // O_RDONLY fd is EBADF on any mount). EROFS stays the answer for
  // write-INTENT opens and path mutations above.
  assert(ro.write(fd, encode('X'), 1) === null, 'write on a read fd must fail');
  assertEq(ro._lastError, 'EBADF', 'write on a read fd errno');
  erofs(ro, 'ftruncate', ro.ftruncate(fd, 0));
  erofs(ro, 'fchmod', ro.fchmod(fd, 0o600));
  erofs(ro, 'futime', ro.futime(fd, 1, 2));
  assertEq(ro.close(fd), 0, 'close is fine');
  assert(ro.stat('/bin/tool') !== null, 'nothing was mutated');
});

test('reads never touch the store (atime suppressed; backstop holds)', function () {
  var store = bakedStore();
  var before = Buffer.from(store.getBytes(0, store.size())).toString('hex');
  var ro = BLOCK_FS.createV4(store, { readonly: true });
  readFile(ro, '/bin/tool');
  ro.stat('/bin/alias');
  var h = ro.opendir('/');
  while (ro.readdir(h) !== null) {}
  ro.closedir(h);
  var after = Buffer.from(store.getBytes(0, store.size())).toString('hex');
  assertEq(after, before, 'store bytes byte-identical after a read workload');
});

// ---- the 0040 mount layout: RO system volume at /usr ----

function layout() {
  var sysStore = bakedStore();
  var rootStore = new MemoryByteStore(1 << 20);
  var sys = BLOCK_FS.createV4(sysStore, { readonly: true });
  var root = BLOCK_FS.createV4(rootStore);
  var m = new BLOCK_FS.MountFS({ '/': root, '/usr': sys });
  m.mkdir('/var', 0o755);
  m.mkdir('/var/local', 0o755);
  m.mkdir('/var/local/bin', 0o755);
  m.symlink('/usr/bin', '/bin');
  return { m: m, sysStore: sysStore, rootStore: rootStore };
}

test('MountFS: /bin -> /usr/bin resolves binaries off the RO volume', function () {
  var l = layout();
  assertEq(readFile(l.m, '/bin/tool'), 'TOOL', 'through the merged-usr symlink');
  assertEq(readFile(l.m, '/usr/bin/tool'), 'TOOL', 'direct');
});

test('MountFS: writes under /usr are EROFS (propagated _lastError)', function () {
  var l = layout();
  assert(l.m.open('/usr/bin/evil', O_WRONLY | O_CREAT, 0o755) === null, 'create refused');
  assertEq(l.m._lastError, 'EROFS', 'errno through MountFS');
  assert(l.m.open('/bin/evil', O_WRONLY | O_CREAT, 0o755) === null, 'via the /bin symlink too');
  assertEq(l.m._lastError, 'EROFS', 'errno via symlink escape');
  assert(l.m.unlink('/usr/bin/tool') === null && l.m._lastError === 'EROFS', 'unlink');
  assert(l.m.mkdir('/usr/newdir', 0o755) === null && l.m._lastError === 'EROFS', 'mkdir');
});

test('MountFS: baked /usr/local -> /var/local escapes to writable territory', function () {
  // The admin's contract: /usr is RO but /usr/local lands on the rw root
  // volume. The baked blob carries the symlink; simulate it here (the blob
  // in this test was baked standalone, so plant it via a rw remount).
  var l = layout();
  var rw = BLOCK_FS.createV4(l.sysStore);         // deliberate rw remount
  rw.symlink('/var/local', '/local');
  var l2 = (function () {                          // fresh RO mount over it
    var sys = BLOCK_FS.createV4(l.sysStore, { readonly: true });
    var root = BLOCK_FS.createV4(l.rootStore);
    return new BLOCK_FS.MountFS({ '/': root, '/usr': sys });
  })();
  writeFile(l2, '/usr/local/bin/mytool', 'MINE', 0o755);
  assertEq(readFile(l2, '/var/local/bin/mytool'), 'MINE', 'landed on the root volume');
  assertEq(readFile(l2, '/usr/local/bin/mytool'), 'MINE', 'readable back through /usr/local');
});

test('mutating ops through an escaping symlink reach the writable volume', function () {
  // Guard placement matters: EROFS must be decided AFTER the walk, so every
  // op on /usr/local/... escapes to the rw root volume instead of failing.
  var l = layout();
  var rw = BLOCK_FS.createV4(l.sysStore);          // plant the baked symlink
  rw.symlink('/var/local', '/local');
  var sys = BLOCK_FS.createV4(l.sysStore, { readonly: true });
  var root = BLOCK_FS.createV4(l.rootStore);
  var m = new BLOCK_FS.MountFS({ '/': root, '/usr': sys });

  assertEq(m.mkdir('/usr/local/share', 0o755), 0, 'mkdir escapes');
  writeFile(m, '/usr/local/bin/t', 'T', 0o755);
  assertEq(m.symlink('/usr/local/bin/t', '/usr/local/bin/l'), 0, 'symlink escapes');
  assertEq(m.chmod('/usr/local/bin/t', 0o700), 0, 'chmod escapes');
  assertEq(m.utime('/usr/local/bin/t', 5, 6), 0, 'utime escapes');
  assertEq(m.unlink('/usr/local/bin/l'), 0, 'unlink escapes');
  assertEq(m.rmdir('/usr/local/share'), 0, 'rmdir escapes');
  assertEq(readFile(m, '/var/local/bin/t'), 'T', 'all of it landed on the root volume');
  // Two-path ops through the alias: MountFS rewrites only the ESCAPED
  // argument, so after the rewrite the two paths route to different volumes
  // -> EXDEV (pre-existing lazy-resolution rule, NOT a readonly regression;
  // busybox mv falls back to copy+unlink). Direct /var/local paths work.
  assert(m.rename('/usr/local/bin/t', '/usr/local/bin/t2') === null &&
    m._lastError === 'EXDEV', 'aliased rename is EXDEV by the mount rule');
  assertEq(m.rename('/var/local/bin/t', '/var/local/bin/t2'), 0, 'direct rename works');
  assertEq(readFile(m, '/usr/local/bin/t2'), 'T', 'visible back through the alias');
});

// ---- the seal (async: WebCrypto) ----

async function sealTests() {
  await (async function () {
    var name = 'sealVolume + verifySeal: intact blob verifies true';
    try {
      var store = bakedStore();
      await BLOCK_FS.sealVolume(store);
      assertEq(await BLOCK_FS.verifySeal(store), true, 'intact');
      var problems = fsck(store);
      assert(problems.length === 0, 'sealed blob fscks clean: ' + problems.join('; '));
      passed++; console.log('ok ' + name);
    } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.message || e)); }
  })();

  await (async function () {
    var name = 'a mutated sealed blob fails verifySeal AND fsck_v4';
    try {
      var store = bakedStore();
      await BLOCK_FS.sealVolume(store);
      // Flip one byte of file content (the TOOL payload) — a rw remount
      // would do exactly this kind of damage.
      var rw = BLOCK_FS.createV4(store);
      writeFile(rw, '/bin/tool', 'EVIL', 0o755);
      assertEq(await BLOCK_FS.verifySeal(store), false, 'seal broken');
      var problems = fsck(store);
      assert(problems.some(function (p) { return p.indexOf('seal') >= 0; }),
        'fsck reports the seal: ' + problems.join('; '));
      passed++; console.log('ok ' + name);
    } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.message || e)); }
  })();

  await (async function () {
    var name = 'unsealed images verify null and fsck without a seal check';
    try {
      var store = bakedStore();
      assertEq(await BLOCK_FS.verifySeal(store), null, 'not sealed');
      var problems = fsck(store);
      assert(problems.length === 0, 'clean: ' + problems.join('; '));
      passed++; console.log('ok ' + name);
    } catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e.message || e)); }
  })();
}

sealTests().then(function () {
  console.log('\ntest_readonly: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}, function (e) {
  console.error('FAIL (seal tests): ' + (e && e.stack || e));
  process.exit(1);
});
