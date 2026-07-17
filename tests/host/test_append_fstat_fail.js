// Host-level regression test (todos/0233 CD4 + todos/0252 R2): the
// native-fs flavor's O_APPEND position handling.
//
// CD4: the O_APPEND open must not swallow an fstat failure — a failed
// fstat fails the open (errno set, native fd closed, -1) instead of
// leaving entry.position = 0 on an fd marked append.
//
// R2 (the CD4 follow-up regression): the post-append-write EOF resync
// fstat can throw AFTER writeSync committed the bytes. Reporting that as
// -1 told the caller a COMMITTED write failed — a retry then appends the
// data twice. The write must return n; the entry's tracked position
// becomes UNKNOWN (positionUnknown) and every later consumer of it
// (SEEK_CUR, positioned read/write) lazily re-fstats — resyncing if fstat
// recovered, failing loud with its errno if not — never a stale offset.
//
// Drives createFileSystem (the host.js test export) directly with a
// NodeFS-shaped fake fs — the sanctioned seam ("fs module or compatible
// subset") — since a real fstat can't be made to fail on a live fd. The
// read import is WebAssembly.Suspending; the stub below makes it plainly
// callable (the test_pipe_read_block pattern).
//
// Run: node tests/host/test_append_fstat_fail.js
'use strict';
const path = require('path');
const realFs = require('fs');

WebAssembly.Suspending = function (f) { return f; };

const ROOT = path.resolve(__dirname, '../..');
const { createFileSystem } = require(path.join(ROOT, 'host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const memory = new WebAssembly.Memory({ initial: 1 });
let errno = null;
const ctx = {
  readString: () => '/fake/append.txt',
  createVaReader: () => () => 0,
  setErrno: (e) => { errno = e.code || String(e); },
  setErrnoName: (name) => { errno = name; },
  getMemory: () => memory,
  getIndirectFunctionTable: () => null,
  writeOut: () => { },
  writeErr: () => { },
};

const O_WRONLY = 1, O_CREAT = 0x40, O_APPEND = 0x400;
const SEEK_CUR = 1;

async function main() {
  const closed = [];
  let fstatMode = 'ok'; // 'ok' | 'throw'
  let fakeSize = 7;
  let readSyncCalls = 0;
  const fakeFs = Object.create(realFs); // inherits constants for flag translation
  fakeFs.openSync = () => 42;
  fakeFs.closeSync = (fd) => { closed.push(fd); };
  fakeFs.fstatSync = () => {
    if (fstatMode === 'throw') { const e = new Error('fake I/O error'); e.code = 'EIO'; throw e; }
    return { size: fakeSize };
  };
  fakeFs.writeSync = (fd, buf, off, count) => count;
  fakeFs.readSync = () => { readSyncCalls++; return 0; };

  const env = createFileSystem({ fs: fakeFs, ctx: ctx }).c;

  // --- Positive control: fstat OK → append open positions at EOF --------
  const okFd = env.__open_impl(0, O_WRONLY | O_CREAT | O_APPEND, 0o644);
  check('append open succeeds when fstat works', okFd >= 0, 'fd=' + okFd);
  check('position starts at EOF, not 0', env.lseek(okFd, 0n, SEEK_CUR) === 7n,
    'pos=' + env.lseek(okFd, 0n, SEEK_CUR));

  // --- CD4: fstat failure fails the open ---------------------------------
  errno = null;
  fstatMode = 'throw';
  const badFd = env.__open_impl(0, O_WRONLY | O_CREAT | O_APPEND, 0o644);
  check('append open fails when fstat fails', badFd === -1, 'fd=' + badFd);
  check('errno surfaced', errno === 'EIO', 'errno=' + errno);
  check('native fd not leaked', closed.includes(42), 'closed=' + JSON.stringify(closed));

  // --- R2: a COMMITTED write is never reported as failed -----------------
  // (okFd is still open with position 7; fstat now throws, writeSync works)
  errno = null;
  const n = env.write(okFd, 0, 3);
  check('committed append write returns n despite failed resync', n === 3, 'n=' + n);

  // Position is now unknown; fstat still failing → SEEK_CUR fails LOUD
  // (never the stale 7).
  errno = null;
  const p1 = env.lseek(okFd, 0n, SEEK_CUR);
  check('SEEK_CUR with broken position fails loud', p1 === -1n, 'pos=' + p1);
  check('errno from the failed lazy resync', errno === 'EIO', 'errno=' + errno);

  // fstat recovers → the next consumer resyncs to real EOF (self-heal).
  fstatMode = 'ok';
  fakeSize = 10;
  errno = null;
  const p2 = env.lseek(okFd, 0n, SEEK_CUR);
  check('SEEK_CUR after fstat recovery resyncs to EOF', p2 === 10n, 'pos=' + p2);

  // --- R2: the positioned READ path is gated too --------------------------
  fstatMode = 'throw';
  errno = null;
  check('re-break: committed write still returns n', env.write(okFd, 0, 2) === 2);
  errno = null;
  const rn = await env.read(okFd, 512, 4);
  check('positioned read with broken position fails loud', rn === -1, 'n=' + rn);
  check('read never issued with a stale offset', readSyncCalls === 0, 'calls=' + readSyncCalls);
  check('read errno from the failed resync', errno === 'EIO', 'errno=' + errno);
  fstatMode = 'ok';
  fakeSize = 12;
  errno = null;
  const rn2 = await env.read(okFd, 512, 4);
  check('read after fstat recovery resyncs and proceeds', rn2 === 0, 'n=' + rn2);
  check('resynced read reached readSync', readSyncCalls === 1, 'calls=' + readSyncCalls);

  console.log(failures ? failures + ' check(s) FAILED' : 'test_append_fstat_fail: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().then(() => { }, (e) => { console.error(e); process.exit(1); });
