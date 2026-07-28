#!/usr/bin/env node
// Process-side read-only /usr (todos/0180) — RemoteFS fast-path mechanics
// against a FAKE client that records every RPC (no kernel, no wasm):
//   - reads under the prefix (open/read/lseek/fstat/close, stat/lstat/
//     access/readlink, opendir/readdir) are served locally — ZERO RPCs —
//     including through in-volume symlinks (relative and absolute targets)
//   - local errors are final (ENOENT under the sealed volume, zero RPCs)
//   - everything else falls back brokered: relative paths, '..' climbing
//     out, write-intent opens, and cross-volume symlink escapes
//     (__mountEscape via the MountFS hooks)
//   - local fds live at RO_FD_BASE+ and promote to kernel twins at the two
//     crossings: dup2 onto a low fd, and spawn DUP2 file-actions
//     (wrapSpawnHooks — the hush `cmd < /usr/...` redirect journal)
//
// Run: node tests/kernel/test_rofs.js
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- build the sealed volume: an rw scratch, then the SAB snapshot ---- */
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const scratch = BLOCK_FS.createV4(store);
function writeFile(fs, p, text) {
  const fd = fs.open(p, 0x40 | 1, 0o644);   // O_CREAT|O_WRONLY
  const bytes = new TextEncoder().encode(text);
  fs.write(fd, bytes, bytes.length);
  fs.close(fd);
}
scratch.mkdir('/share', 0o755);
scratch.mkdir('/share/sub', 0o755);
writeFile(scratch, '/share/f.txt', 'hello from usr\n');
writeFile(scratch, '/share/sub/g.txt', 'nested\n');
scratch.symlink('f.txt', '/share/rel.txt');              // relative, in-volume
scratch.symlink('/usr/share/f.txt', '/share/abs.txt');   // absolute (full namespace), in-volume
scratch.symlink('/var/local', '/local');                 // escapes the volume
scratch.symlink('/etc/target', '/share/out.txt');        // escapes the volume

const sab = BLOCK_FS.storeToSab(store);
const roFs = BLOCK_FS.createV4(new BLOCK_FS.SabByteStore(sab), { readonly: true });

/* ---- the fake client: records ops, serves canned replies ---- */
const calls = [];
const fake = {
  call: function (op, req) {
    calls.push({ op: op, req: req });
    switch (op) {
      case K.OP.FS_OPEN: return { fd: 9 };
      case K.OP.FS_LSEEK: return { offset: req.offset };
      case K.OP.FS_DUP2: return { fd: req.newfd };
      case K.OP.FS_CLOSE: return {};
      case K.OP.FS_STAT: case K.OP.FS_LSTAT: return { st: { size: 1, mode: 0o100644 } };
      case K.OP.FS_ACCESS: return {};
      case K.OP.FS_READLINK: return { target: '/brokered' };
      case K.OP.FS_OPENDIR: return { entries: [{ ino: 1, type: 8, name: 'remote-ent' }] };
      case K.OP.SPAWN: return { pid: 42 };
      default: return {};
    }
  },
  callRaw: function (op, bytes) { calls.push({ op: op }); return { n: bytes.length - 4 }; },
};
function rpcCount() { return calls.length; }

const rfs = new K.RemoteFS(fake, { roFs: roFs, roPrefix: '/usr' });
const BASE = K.RO_FD_BASE;

/* ---- zero-RPC reads under the prefix ---- */
{
  const before = rpcCount();
  const fd = rfs.open('/usr/share/f.txt', 0, 0);
  check('open under /usr is local (fd >= RO_FD_BASE)', fd !== null && fd >= BASE, String(fd));
  const buf = new Uint8Array(64);
  const n = rfs.read(fd, buf, 64);
  check('local read returns the content', n === 15 &&
    new TextDecoder().decode(buf.subarray(0, n)) === 'hello from usr\n', String(n));
  const st = rfs.fstat(fd);
  check('local fstat sizes the file', st && st.size === 15, JSON.stringify(st));
  check('local lseek rewinds', rfs.lseek(fd, 5, 0) === 5);
  const n2 = rfs.read(fd, buf, 64);
  check('read after lseek', n2 === 10 &&
    new TextDecoder().decode(buf.subarray(0, n2)) === ' from usr\n');
  check('isatty on a local fd is 0', rfs.isatty(fd) === 0);
  check('local close', rfs.close(fd) === 0);

  check('stat under /usr is local', rfs.stat('/usr/share/f.txt').size === 15);
  check('lstat sees the symlink itself', (rfs.lstat('/usr/share/rel.txt').mode & 0xF000) === 0xA000);
  check('access under /usr is local', rfs.access('/usr/share/f.txt', 4) === 0);
  const lbuf = new Uint8Array(64);
  const ln = rfs.readlink('/usr/share/rel.txt', lbuf, 64);
  check('readlink under /usr is local', ln === 5 &&
    new TextDecoder().decode(lbuf.subarray(0, ln)) === 'f.txt');

  // In-volume symlinks (relative + full-namespace absolute) stay local.
  const fdRel = rfs.open('/usr/share/rel.txt', 0, 0);
  const fdAbs = rfs.open('/usr/share/abs.txt', 0, 0);
  check('in-volume relative symlink opens locally', fdRel >= BASE);
  check('in-volume absolute symlink opens locally', fdAbs >= BASE);
  rfs.close(fdRel); rfs.close(fdAbs);

  // Directory enumeration.
  const dh = rfs.opendir('/usr/share');
  check('opendir under /usr is local', dh >= BASE);
  const names = [];
  for (let e; (e = rfs.readdir(dh)) !== null;) names.push(e.name);
  check('local readdir lists the tree', names.includes('f.txt') && names.includes('sub') &&
    names.includes('.') && names.includes('..'), names.join(','));
  check('local closedir', rfs.closedir(dh) === 0);

  // Local errors are final — the sealed volume is complete.
  check('ENOENT under /usr is local and final',
    rfs.open('/usr/share/nope', 0, 0) === null && rfs._lastError === 'ENOENT');

  check('ALL of the above made ZERO RPCs', rpcCount() === before,
    JSON.stringify(calls.slice(before)));
}

/* ---- write intent on a local fd: the same refusal the kernel would give
   (todos/0376: EBADF/EINVAL — the O_RDONLY fd's access mode, checked before
   the readonly volume flag; brokered fds answer identically) ---- */
{
  const fd = rfs.open('/usr/share/f.txt', 0, 0);
  const before = rpcCount();
  check('write on a local fd is EBADF (O_RDONLY fd)',
    rfs.write(fd, new Uint8Array([65]), 1) === null && rfs._lastError === 'EBADF');
  check('ftruncate on a local fd is EINVAL (fd not open for writing)',
    rfs.ftruncate(fd, 0) === null && rfs._lastError === 'EINVAL');
  check('fsync on a local fd is a no-op success', rfs.fsync(fd) === 0);
  check('EROFS legs made zero RPCs', rpcCount() === before);
  rfs.close(fd);
}

/* ---- brokered fallbacks ---- */
{
  function lastOp() { return calls.length ? calls[calls.length - 1].op : null; }
  let before = rpcCount();
  rfs.open('share/f.txt', 0, 0);
  check('relative path opens brokered', rpcCount() === before + 1 && lastOp() === K.OP.FS_OPEN);
  before = rpcCount();
  rfs.open('/usr/../etc/passwd', 0, 0);
  check("'..' climbing out goes brokered", rpcCount() === before + 1 && lastOp() === K.OP.FS_OPEN);
  before = rpcCount();
  rfs.open('/usr/share/f.txt', 1, 0);   // O_WRONLY
  check('write-intent open goes brokered (kernel owns EROFS-after-walk)',
    rpcCount() === before + 1 && lastOp() === K.OP.FS_OPEN);
  before = rpcCount();
  rfs.open('/usr/share/f.txt', 0x40, 0o644);   // O_CREAT
  check('O_CREAT open goes brokered', rpcCount() === before + 1 && lastOp() === K.OP.FS_OPEN);

  // Cross-volume symlink escapes retry brokered with the ORIGINAL path.
  before = rpcCount();
  const efd = rfs.open('/usr/local/bin/tool', 0, 0);
  check('escape through /usr/local retries brokered', efd === 9 &&
    rpcCount() === before + 1 && calls[calls.length - 1].req.path === '/usr/local/bin/tool');
  before = rpcCount();
  rfs.stat('/usr/share/out.txt');
  check('escaping symlink stat retries brokered', rpcCount() === before + 1 && lastOp() === K.OP.FS_STAT);
  before = rpcCount();
  rfs.opendir('/usr/local');
  check('escaping opendir retries brokered', rpcCount() === before + 1 && lastOp() === K.OP.FS_OPENDIR);
  rfs.close(9);   // drop the fake brokered fd marker
}

/* ---- dup family in the local space ---- */
{
  const fd = rfs.open('/usr/share/f.txt', 0, 0);
  const before = rpcCount();
  const d = rfs.dup(fd);
  check('dup of a local fd stays local', d !== null && d >= BASE && d !== fd, String(d));
  const buf = new Uint8Array(8);
  // dup shares the offset (one OFD — BlockFS _dupEntry reuses the entry),
  // exactly like a kernel-side dup.
  check('the dup reads through the shared offset', rfs.read(d, buf, 5) === 5);
  const f = rfs.fcntl_dupfd(fd, 10);
  check('fcntl_dupfd stays local (result >= min trivially)', f !== null && f >= BASE);
  check('dup family made zero RPCs', rpcCount() === before);
  rfs.close(d); rfs.close(f);

  // dup2 onto a low fd crosses into the kernel space: promote (open the
  // recorded path, seek to the local offset), dup2 the twin, drop it.
  // The offset is 10 here: the dup + the fcntl_dupfd shared fd's OFD, and
  // two 5-byte reads went through it.
  rfs.read(fd, buf, 5);
  const b2 = rpcCount();
  const r = rfs.dup2(fd, 0);
  const ops = calls.slice(b2).map(function (c) { return c.op; });
  check('dup2 local->0 returns the low fd', r === 0, String(r));
  check('promotion = FS_OPEN, FS_LSEEK, FS_DUP2, FS_CLOSE',
    JSON.stringify(ops) === JSON.stringify([K.OP.FS_OPEN, K.OP.FS_LSEEK, K.OP.FS_DUP2, K.OP.FS_CLOSE]),
    JSON.stringify(ops));
  check('promotion re-opened the recorded full-namespace path',
    calls[b2].req.path === '/usr/share/f.txt', calls[b2].req.path);
  check('promotion seeked to the shared local offset', calls[b2 + 1].req.offset === 10,
    JSON.stringify(calls[b2 + 1].req));
  rfs.close(fd);
}

/* ---- wrapSpawnHooks: DUP2 actions naming local fds promote ---- */
{
  const fd = rfs.open('/usr/share/f.txt', 0, 0);
  let seen = null;
  const hooks = rfs.wrapSpawnHooks({ spawn: function (spec) { seen = spec; return { pid: 7 }; } });
  const b = rpcCount();
  const r = hooks.spawn({ path: '/bin/cat', argv: ['cat'], actions: [
    { op: 0, fd: 0, arg: fd, path: null, mode: 0 },     // dup2 local -> child stdin
    { op: 2, fd: fd, arg: 0, path: null, mode: 0 },     // journaled close of the local number (child no-op)
  ] });
  check('wrapped spawn returns the inner result', r && r.pid === 7);
  check('DUP2 action arg rewritten to the kernel twin', seen.actions[0].arg === 9,
    JSON.stringify(seen.actions));
  check('a CLOSE action for the twin was appended',
    seen.actions.some(function (a) { return a.op === 2 && a.fd === 9; }),
    JSON.stringify(seen.actions));
  // The RPC trace is exactly open-twin + close-twin (the spawn itself is
  // the direct spy, not an RPC; a fresh fd at offset 0 needs no seek).
  const ops = calls.slice(b).map(function (c) { return c.op; });
  check('promotion opened then closed the twin parent-side',
    JSON.stringify(ops) === JSON.stringify([K.OP.FS_OPEN, K.OP.FS_CLOSE]), JSON.stringify(ops));

  // When an action already targets the twin's fd number, the appended
  // close would destroy the caller's redirect — it must be suppressed.
  seen = null;
  hooks.spawn({ path: '/bin/cat', argv: ['cat'], actions: [
    { op: 0, fd: 0, arg: fd, path: null, mode: 0 },
    { op: 0, fd: 9, arg: 1, path: null, mode: 0 },      // caller installs at 9
  ] });
  check('no appended close when an action targets the twin fd',
    !seen.actions.some(function (a) { return a.op === 2 && a.fd === 9; }),
    JSON.stringify(seen.actions));

  // No local fds referenced -> the spec passes through untouched.
  seen = null;
  hooks.spawn({ path: '/bin/ls', argv: ['ls'], actions: [{ op: 2, fd: 5, arg: 0, path: null, mode: 0 }] });
  check('spec without local fds passes through', seen.actions.length === 1);
  rfs.close(fd);
}

/* ---- a RemoteFS without the RO volume is byte-identical old behavior ---- */
{
  const calls2 = [];
  const fake2 = { call: function (op) { calls2.push(op); return { fd: 3 }; } };
  const plain = new K.RemoteFS(fake2);
  plain.open('/usr/share/f.txt', 0, 0);
  check('no-RO RemoteFS brokeres everything', calls2.length === 1 && calls2[0] === K.OP.FS_OPEN);
  const h = { spawn: function () { return { pid: 1 }; } };
  check('no-RO wrapSpawnHooks is identity', plain.wrapSpawnHooks(h) === h);
}

console.log(failures === 0 ? '\nrofs: PASS' : `\nrofs: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
