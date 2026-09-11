#!/usr/bin/env node
'use strict';
// #785: real in-memory volumes and production adapters; no workers, images,
// compiler, package prep, or OS boot. This is not the cmdalt workload.
const assert = require('assert');
const { BLOCK_FS: B } = require('../../host.js');
const K = require('../../kernel.js');
let failed = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
function fresh() { return B.createV4(new B.MemoryByteStore(1 << 20)); }
function put(fs, path) { const fd = fs.open(path, 0x42, 0o644); assert.notStrictEqual(fd, null); fs.write(fd, new Uint8Array([65]), 1); fs.close(fd); }
function pair(st) { assert(st); return [st.dev, st.ino]; }
function mounted() {
  const a = fresh(), b = fresh(); put(a, '/f'); put(b, '/f');
  return { a, b, fs: new B.MountFS({ '/': a, '/other': b }) };
}
function noWorker() { throw new Error('worker launch prohibited in this test'); }
function roFixture() {
  const store = new B.MemoryByteStore(1 << 20), scratch = B.createV4(store);
  put(scratch, '/f'); scratch.symlink('/outside', '/escape'); scratch.symlink('f', '/alias');
  const sab = B.storeToSab(store);
  const reader = () => B.createV4(new B.SabByteStore(sab), { readonly: true });
  const root = fresh(); put(root, '/outside');
  const fs = new B.MountFS({ '/': root, '/usr': reader() });
  const kernel = new K.Kernel({ fs, roImage: { prefix: '/usr', sab }, createWorker: noWorker });
  const calls = [];
  // Exercise the real kernel filesystem dispatcher/OFD table without a worker
  // or wire transport. Only response delivery is captured synchronously.
  const pcb = { pid: 1, cwd: '/', fds: new Map() }; let response;
  kernel._respond = (p, r) => { assert.strictEqual(p, pcb); response = r; };
  kernel._respondRaw = (p, raw) => { assert.strictEqual(p, pcb); response = { raw }; };
  const client = { call(op, req) {
    calls.push(op); response = undefined; kernel._fsRpc(pcb, op, req);
    assert.notStrictEqual(response, undefined, 'synchronous filesystem response'); return response;
  } };
  return { fs, kernel, sab, reader, calls, client, pcb };
}

test('distinct mounted volumes with equal inode numbers; aliases and opened handles', () => {
  const { fs, a, b } = mounted();
  assert.strictEqual(a.stat('/f').ino, b.stat('/f').ino);
  assert.notStrictEqual(fs.stat('/f').dev, fs.stat('/other/f').dev);
  const p = pair(fs.stat('/f')), q = pair(fs.stat('/other/f'));
  assert(p[0] > 0 && q[0] > 0);
  fs.link('/f', '/hard'); fs.symlink('/other/f', '/across'); fs.symlink('/f', '/other/back');
  assert.deepStrictEqual(pair(fs.stat('/hard')), p);
  assert.deepStrictEqual(pair(fs.stat('/across')), q);
  assert.deepStrictEqual(pair(fs.stat('/other/back')), p);
  assert.strictEqual(fs.lstat('/across').dev, p[0]);
  assert.strictEqual(fs.lstat('/other/back').dev, q[0]);
  const fd = fs.open('/across', 0, 0), dup = fs.dup(fd);
  fs.rename('/other/f', '/other/moved'); fs.unlink('/other/moved');
  assert.deepStrictEqual(pair(fs.fstat(fd)), q); assert.deepStrictEqual(pair(fs.fstat(dup)), q);
  fs.close(fd); fs.close(dup);
  assert.strictEqual(a.stat('/f').dev, 0, 'raw metadata is not mutated by owner qualification');
});
test('owner tokens bind readers of one live namespace, not byte-identical copies', () => {
  const store = new B.MemoryByteStore(1 << 20); B.createV4(store);
  const sab = B.storeToSab(store), key = {};
  const reader = () => B.createV4(new B.SabByteStore(sab), { readonly: true });
  const copy = new SharedArrayBuffer(sab.byteLength); new Uint8Array(copy).set(new Uint8Array(sab));
  const fs = new B.MountFS([{ prefix: '/', fs: fresh() },
    { prefix: '/a', fs: reader(), volumeKey: key }, { prefix: '/b', fs: reader(), volumeKey: key },
    { prefix: '/copy', fs: B.createV4(new B.SabByteStore(copy), { readonly: true }) }]);
  assert.deepStrictEqual(pair(fs.stat('/a/dev/null')), pair(fs.stat('/b/dev/null')));
  assert.notStrictEqual(fs.stat('/a').dev, fs.stat('/copy').dev);
  const identity = fs.getVolumeIdentity('/a'); assert.strictEqual(identity.readonly, true);
  assert(Object.isFrozen(identity)); assert.throws(() => fs.getVolumeIdentity('/a/dev'), TypeError);
});
test('invalid mount configuration fails before installing any hooks', () => {
  const cases = [
    a => [{ prefix: '/', fs: a }, { prefix: '/x', fs: a }],
    a => [{ prefix: '/', fs: a }, { prefix: '/', fs: fresh() }],
    a => [{ prefix: '/', fs: a }, { prefix: '/x', fs: fresh(), volumeKey: 'hash' }],
    a => [{ prefix: '/', fs: a }, { prefix: '/x', fs: fresh(), volumeKey: [] }],
    a => [{ prefix: '/', fs: a }, { prefix: '/x', fs: fresh(), volumeKey: null }],
    a => [{ prefix: '/', fs: a }, { prefix: 'relative', fs: fresh() }],
  ];
  for (const make of cases) { const a = fresh(); assert.throws(() => new B.MountFS(make(a)), TypeError); assert.strictEqual(a._mountOwns, null); }
});
test('checked allocation boundary refuses before hooks (fault-injected registry size)', () => {
  // Execute the production constructor with a Map size fault, rather than
  // allocating four billion images or exposing a product test-only counter.
  const source = require('fs').readFileSync(require.resolve('../../host.js'), 'utf8');
  const start = source.indexOf('  function MountFS(mounts) {');
  const end = source.indexOf('  MountFS.prototype._setErr =', start);
  function ctor(size) {
    return new Function('Map', source.slice(start, end) + '\nreturn MountFS;')(
      class extends Map { get size() { return size; } });
  }
  const a = fresh(), Last = ctor(0xfffffffe), full = new Last({ '/': a });
  assert.strictEqual(full.getVolumeIdentity('/').dev, 0xffffffff);
  const b = fresh(), Overflow = ctor(0xffffffff);
  assert.throws(() => new Overflow({ '/': b }), RangeError); assert.strictEqual(b._mountOwns, null);
});
test('filesystem device paths retain identity and rdev I/O through dup/rename/unlink', () => {
  const { fs } = mounted();
  for (const name of ['null', 'zero']) {
    const path = '/other/dev/' + name, st = fs.stat(path), p = pair(st);
    assert(st.dev > 0); assert.notStrictEqual(st.dev, st.rdev);
    fs.link(path, '/other/hard-' + name); fs.symlink(path, '/link-' + name);
    const fd = fs.open('/link-' + name, 2, 0), d = fs.dup(fd);
    assert.deepStrictEqual(pair(fs.fstat(fd)), p);
    fs.rename(path, path + '-moved'); fs.unlink(path + '-moved'); fs.unlink('/other/hard-' + name);
    assert.deepStrictEqual(pair(fs.fstat(d)), p); assert.strictEqual(fs.fstat(d).rdev, st.rdev);
    const buf = new Uint8Array(4).fill(7); assert.strictEqual(fs.read(d, buf, 4), name === 'null' ? 0 : 4);
    if (name === 'zero') assert.deepStrictEqual([...buf], [0, 0, 0, 0]);
    assert.strictEqual(fs.write(fd, buf, 4), 4); fs.close(fd); fs.close(d);
  }
});
test('owner RO descriptor, zero-RPC local pair, broker escape and fd promotion', () => {
  const f = roFixture(), descriptor = f.kernel._roImage;
  assert.strictEqual(descriptor.dev, f.fs.stat('/usr/f').dev); assert(Object.isFrozen(descriptor));
  const r = new K.RemoteFS(f.client, { roFs: f.reader(), roPrefix: '/usr', roDev: descriptor.dev, roLeaf: true });
  const expected = pair(f.fs.stat('/usr/f'));
  const fd = r.open('/usr/alias', 0, 0), dup = r.dup(fd);
  assert.deepStrictEqual(pair(r.stat('/usr/f')), expected);
  assert.deepStrictEqual(pair(r.lstat('/usr/alias')), pair(f.fs.lstat('/usr/alias')));
  assert.deepStrictEqual(pair(r.fstat(dup)), expected); assert.strictEqual(f.calls.length, 0);
  assert.deepStrictEqual(pair(r.stat('/usr/escape')), pair(f.fs.stat('/outside')));
  assert.strictEqual(r.dup2(fd, 20), 20); assert.deepStrictEqual(pair(r.fstat(20)), expected);
  const hooks = r.wrapSpawnHooks({ spawn(spec) {
    assert.deepStrictEqual(pair(f.client.call(K.OP.FS_FSTAT, { fd: spec.actions[0].arg }).st), expected); return { pid: 7 };
  } });
  assert.strictEqual(hooks.spawn({ actions: [{ op: 0, fd: 0, arg: fd }] }).pid, 7);
  r.close(20); r.close(dup); r.close(fd);
});
test('missing optional RO identity uses broker for actual opens/stats/fds', () => {
  const f = roFixture(), raw = f.reader();
  const r = new K.RemoteFS(f.client, { roFs: raw, roPrefix: '/usr' });
  const fd = r.open('/usr/f', 0, 0);
  assert(fd < K.RO_FD_BASE); assert.deepStrictEqual(pair(r.stat('/usr/f')), pair(f.fs.stat('/usr/f')));
  assert.deepStrictEqual(pair(r.lstat('/usr/alias')), pair(f.fs.lstat('/usr/alias')));
  assert.deepStrictEqual(pair(r.fstat(fd)), pair(f.fs.stat('/usr/f'))); const buf = new Uint8Array(1); assert.strictEqual(r.read(fd, buf, 1), 1); assert.strictEqual(buf[0], 65); r.close(fd);
  assert.strictEqual(raw._mountOwns, null); assert.strictEqual(f.calls.length, 6);
  const custom = fresh();
  const k = new K.Kernel({ fs: custom, roImage: { prefix: '/usr', sab: f.sab }, createWorker: noWorker });
  assert.strictEqual(k._roImage, null);
  custom.getVolumeIdentity = () => ({ readonly: true });
  assert.strictEqual(new K.Kernel({ fs: custom, roImage: { prefix: '/usr', sab: f.sab }, createWorker: noWorker })._roImage, null);
});
test('readonly root mount and a fresh descriptor retain the current owner identity', () => {
  const f = roFixture(), root = new B.MountFS({ '/': f.reader() });
  const kernel = new K.Kernel({ fs: root, roImage: { prefix: '/', sab: f.sab }, createWorker: noWorker });
  const local = new K.RemoteFS({ call() { throw new Error('unexpected root RO RPC'); } }, {
    roFs: f.reader(), roPrefix: '/', roDev: kernel._roImage.dev, roLeaf: true,
  });
  assert.deepStrictEqual(pair(local.stat('/f')), pair(root.stat('/f')));
  const fd = local.open('/f', 0, 0); assert.deepStrictEqual(pair(local.fstat(fd)), pair(root.stat('/f'))); local.close(fd);
  // New reader/descriptor, not a claim of actual warm-worker execution.
  const next = new K.RemoteFS(f.client, { roFs: f.reader(), roPrefix: '/usr', roDev: f.kernel._roImage.dev, roLeaf: true });
  assert.deepStrictEqual(pair(next.stat('/usr/f')), pair(f.fs.stat('/usr/f')));
});
test('explicit invalid RO metadata is a configuration error', () => {
  const f = roFixture();
  for (const dev of [undefined, null, '1', NaN, 1.5]) {
    assert.throws(() => new K.RemoteFS(f.client, { roFs: f.reader(), roPrefix: '/usr', roDev: dev, roLeaf: true }), TypeError);
  }
  for (const opts of [{ roDev: 1, roLeaf: true }, { roFs: fresh(), roPrefix: '/usr', roDev: 1, roLeaf: true }, { roFs: f.reader(), roPrefix: '/usr/../usr', roDev: 1, roLeaf: true }])
    assert.throws(() => new K.RemoteFS(f.client, opts), TypeError);
  for (const dev of [0, -1, 0x100000000]) {
    assert.throws(() => new K.RemoteFS(f.client, { roFs: f.reader(), roPrefix: '/usr', roDev: dev, roLeaf: true }), RangeError);
  }
  assert.throws(() => new K.Kernel({ fs: f.fs, roImage: { prefix: '/usr', sab: f.sab, dev: 42 }, createWorker: noWorker }), TypeError);
  assert.throws(() => new K.Kernel({ fs: f.fs, roImage: { prefix: '/', sab: f.sab }, createWorker: noWorker }), TypeError);
});
test('kernel filesystem devices, spawn OPEN/inheritance, and anonymous compatibility', () => {
  const f = roFixture(), k = f.kernel;
  const fd = f.client.call(K.OP.FS_OPEN, { path: '/dev/null', flags: 2 }).fd;
  const expected = pair(f.fs.stat('/dev/null'));
  assert.deepStrictEqual(pair(f.client.call(K.OP.FS_FSTAT, { fd }).st), expected);
  const deviceOfd = k._ofds.get(f.pcb.fds.get(fd)); assert.strictEqual(deviceOfd.kind, 'file');
  const descriptions = [];
  // Deliberately inert worker capability: exercise spawn's real descriptor
  // construction and fd actions, without launching any worker or program.
  k._createWorker = spec => { descriptions.push(spec); return { onMessage() {}, onExit() {} }; };
  Object.assign(f.pcb, { children: new Set(), pgid: 1, sid: 1 }); k._nextPid = 2;
  const result = k._spawnImage(f.pcb, { path: '/not-executed', actions: [
    { op: 0, arg: fd, fd: 21 }, { op: 1, path: '/dev/zero', arg: 0, fd: 22, mode: 0 },
  ] }, null, null);
  assert(result.pid); const child = k._procs.get(result.pid);
  assert.strictEqual(child.fds.get(21), f.pcb.fds.get(fd));
  assert.strictEqual(descriptions[0].ro.dev, f.fs.stat('/usr').dev);
  const zeroOfd = k._ofds.get(child.fds.get(22)); assert.strictEqual(zeroOfd.kind, 'file');
  assert.deepStrictEqual(pair(f.fs.fstat(zeroOfd.bfsFd)), pair(f.fs.stat('/dev/zero')));
  const p = pair(f.fs.stat('/dev/null')); f.fs.rename('/dev/null', '/dev/null-moved'); f.fs.unlink('/dev/null-moved');
  assert.deepStrictEqual(pair(f.fs.fstat(deviceOfd.bfsFd)), p);
  const std = k._stdOfds();
  for (const ofd of [std.in_, std.out, std.err, k._makeOfd('socket', { st: 'listen' }), k._makeOfd('pipe', { pipe: { buf: [] } })]) {
    f.pcb.fds.set(30, ofd.id); assert.deepStrictEqual(pair(f.client.call(K.OP.FS_FSTAT, { fd: 30 }).st), [0, 0]);
  }
  // Release the file handles owned by the inert child and parent explicitly.
  child.fds.forEach(id => k._ofdUnref(id, child.pid)); child.fds.clear();
  f.client.call(K.OP.FS_CLOSE, { fd });
});
test('actual mounted pairs survive both production ABI adapters', () => {
  const f = roFixture(), r = new K.RemoteFS(f.client, {
    roFs: f.reader(), roPrefix: '/usr', roDev: f.kernel._roImage.dev, roLeaf: true,
  });
  for (const fs of [f.fs, r]) {
    const memory = new WebAssembly.Memory({ initial: 1 }), view = new DataView(memory.buffer);
    const ctx = { getMemory: () => memory, readString: () => '/usr/f', setErrnoName: e => { throw new Error(e); } };
    const c = B.BlockFS.prototype.toWasmEnv.call(fs, ctx);
    const w = B.BlockFS.prototype.toWasiPreview1.call(fs, ctx);
    const fd = fs.open('/usr/f', 0, 0), expected = pair(f.fs.stat('/usr/f'));
    assert.strictEqual(c.stat(0, 128), 0);
    assert.deepStrictEqual([view.getUint32(128, true), view.getUint32(132, true)], expected);
    assert.strictEqual(w.fd_filestat_get(fd, 128), 0);
    assert.deepStrictEqual([Number(view.getBigUint64(128, true)), Number(view.getBigUint64(136, true))], expected);
    fs.close(fd);
  }
});
for (const prefix of ['/usr', '/']) test('nested mount excludes whole local RO path: ' + prefix, () => {
  const store = new B.MemoryByteStore(1 << 20), scratch = B.createV4(store);
  scratch.mkdir('/nested', 0o755); put(scratch, '/nested/f');
  scratch.symlink((prefix === '/' ? '' : prefix) + '/nested/f', '/into-nested');
  const sab = B.storeToSab(store);
  const reader = () => B.createV4(new B.SabByteStore(sab), { readonly: true });
  const nested = fresh(); put(nested, '/f'); put(nested, '/only');
  const fd = nested.open('/f', 1, 0); nested.write(fd, new Uint8Array([90]), 1); nested.close(fd);
  const childPrefix = (prefix === '/' ? '' : prefix) + '/nested';
  const mounts = [{ prefix, fs: reader() }, { prefix: childPrefix, fs: nested }];
  if (prefix !== '/') mounts.push({ prefix: '/', fs: fresh() });
  const fs = new B.MountFS(mounts);
  const kernel = new K.Kernel({ fs, roImage: { prefix, sab }, createWorker: noWorker });
  const pcb = { pid: 1, cwd: '/', fds: new Map() }; let response, calls = 0;
  kernel._respond = (p, r) => { response = r; };
  kernel._respondRaw = (p, raw) => { response = { raw }; };
  const client = { call(op, req) { calls++; response = undefined; kernel._fsRpc(pcb, op, req); assert(response); return response; } };
  const desc = kernel._roImage;
  const remote = new K.RemoteFS(client, desc ? { roFs: reader(), roPrefix: desc.prefix, roDev: desc.dev, roLeaf: desc.leaf } : null);
  for (const path of [childPrefix + '/f', childPrefix + '/only', (prefix === '/' ? '' : prefix) + '/into-nested']) {
    const before = calls;
    assert.deepStrictEqual(pair(remote.stat(path)), pair(fs.stat(path)), path + ' stat');
    assert.deepStrictEqual(pair(remote.lstat(path)), pair(fs.lstat(path)), path + ' lstat');
    const fd = remote.open(path, 0, 0); assert.notStrictEqual(fd, null);
    assert.deepStrictEqual(pair(remote.fstat(fd)), pair(fs.stat(path)), path + ' fstat');
    const buf = new Uint8Array(1); assert.strictEqual(remote.read(fd, buf, 1), 1);
    assert.strictEqual(buf[0], path.endsWith('/only') ? 65 : 90, path + ' nested data');
    remote.close(fd); assert.strictEqual(calls - before, 6, 'whole broker path');
  }
  assert.strictEqual(kernel._roImage, null);
  assert.strictEqual(fs.getVolumeIdentity(prefix).leaf, false);
});
test('manual RO coverage and custom owner metadata fail closed', () => {
  const f = roFixture();
  for (const coverage of [{}, { roLeaf: false }]) {
    const raw = f.reader(), before = f.calls.length;
    const r = new K.RemoteFS(f.client, Object.assign({ roFs: raw, roPrefix: '/usr', roDev: f.kernel._roImage.dev }, coverage));
    const fd = r.open('/usr/f', 0, 0); assert(fd < K.RO_FD_BASE);
    assert.deepStrictEqual(pair(r.stat('/usr/f')), pair(f.fs.stat('/usr/f')));
    assert.deepStrictEqual(pair(r.fstat(fd)), pair(f.fs.stat('/usr/f')));
    const buf = new Uint8Array(1); assert.strictEqual(r.read(fd, buf, 1), 1); assert.strictEqual(buf[0], 65);
    r.close(fd); assert.strictEqual(f.calls.length - before, 5); assert.strictEqual(raw._mountOwns, null);
  }
  for (const leaf of [undefined, null, 1, 'true']) {
    assert.throws(() => new K.RemoteFS(f.client, { roFs: f.reader(), roPrefix: '/usr', roDev: 1, roLeaf: leaf }), TypeError);
  }
  const custom = fresh();
  for (const coverage of [{}, { leaf: false }]) {
    custom.getVolumeIdentity = () => Object.assign({ dev: 1, readonly: true }, coverage);
    assert.strictEqual(new K.Kernel({ fs: custom, roImage: { prefix: '/usr', sab: f.sab }, createWorker: noWorker })._roImage, null);
  }
  custom.getVolumeIdentity = () => ({ dev: 1, readonly: true, leaf: 'yes' });
  assert.throws(() => new K.Kernel({ fs: custom, roImage: { prefix: '/usr', sab: f.sab }, createWorker: noWorker }), TypeError);
});
function adapters() {
  const fs = fresh(), memory = new WebAssembly.Memory({ initial: 1 }); let errno;
  const ctx = { getMemory: () => memory, readString: () => '/f', setErrnoName: e => { errno = e; } };
  const c = fs.toWasmEnv(ctx), w = fs.toWasiPreview1(ctx);
  const st = { dev: 0xffffffff, ino: 0x80000001, mode: 0o100644, size: 17, nlink: 1, atime: 1, mtime: 2, ctime: 3 };
  fs.stat = fs.lstat = fs.fstat = () => st;
  new Uint8Array(memory.buffer).set([102], 16);
  return { fs, memory, c, w, st, errno: () => errno };
}
test('C and WASI preserve unsigned identity and unchanged field offsets', () => {
  const a = adapters(), v = new DataView(a.memory.buffer);
  for (const fn of [() => a.c.stat(16, 128), () => a.c.lstat(16, 128), () => a.c.fstat(5, 128)]) {
    assert.strictEqual(fn(), 0); assert.strictEqual(v.getUint32(128, true), a.st.dev);
    assert.strictEqual(v.getUint32(132, true), a.st.ino); assert.strictEqual(v.getBigInt64(160, true), 17n);
  }
  for (const fn of [() => a.w.fd_filestat_get(5, 128), () => a.w.path_filestat_get(3, 1, 16, 1, 128), () => a.w.path_filestat_get(3, 0, 16, 1, 128)]) {
    assert.strictEqual(fn(), 0); assert.strictEqual(v.getBigUint64(128, true), BigInt(a.st.dev));
    assert.strictEqual(v.getBigUint64(136, true), BigInt(a.st.ino)); assert.strictEqual(v.getBigUint64(160, true), 17n);
  }
});
test('invalid identity pair returns EIO without writing either ABI output', () => {
  for (const field of ['dev', 'ino']) for (const value of [undefined, null, -1, 0x100000000, 0.5, NaN, '1']) {
    const a = adapters(); a.st[field] = value;
    const bytes = new Uint8Array(a.memory.buffer, 128, 120); bytes.fill(0xa5);
    for (const fn of [() => a.c.stat(16, 128), () => a.c.lstat(16, 128), () => a.c.fstat(5, 128)]) {
      assert.strictEqual(fn(), -1, field + '=' + value); assert.strictEqual(a.errno(), 'EIO'); assert(bytes.every(x => x === 0xa5));
    }
    for (const fn of [() => a.w.fd_filestat_get(5, 128), () => a.w.path_filestat_get(3, 1, 16, 1, 128), () => a.w.path_filestat_get(3, 0, 16, 1, 128)]) {
      assert.strictEqual(fn(), 29); assert(bytes.every(x => x === 0xa5));
    }
  }
});
test('backend failures retain ENOENT/EBADF; explicit legacy dev zero remains valid', () => {
  const a = adapters(); a.st.dev = a.st.ino = 0;
  assert.strictEqual(a.c.stat(16, 128), 0); assert.strictEqual(a.w.fd_filestat_get(0, 128), 0);
  a.fs.stat = () => { a.fs._lastError = 'ENOENT'; return null; };
  a.fs.fstat = () => { a.fs._lastError = 'EBADF'; return null; };
  assert.strictEqual(a.c.stat(16, 128), -1); assert.strictEqual(a.errno(), 'ENOENT');
  assert.strictEqual(a.w.path_filestat_get(3, 1, 16, 1, 128), 44);
  assert.strictEqual(a.c.fstat(999, 128), -1); assert.strictEqual(a.errno(), 'EBADF');
  assert.strictEqual(a.w.fd_filestat_get(999, 128), 8);
});
console.log(`stat identity: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
