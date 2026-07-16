// Host-level regression test (todos/0233, code-debt scan CD4): the
// native-fs flavor's O_APPEND open must not swallow an fstat failure.
// Before the fix, an uncommented empty catch left entry.position = 0 on
// an fd marked append — "append" reads/seeks then operated from offset 0,
// silently corrupting data. Now a failed fstat fails the open (errno set,
// native fd closed, -1), and the post-append-write position resync
// surfaces its failure through write's error path instead of leaving a
// silently stale offset.
//
// Drives createFileSystem (the host.js test export) directly with a
// NodeFS-shaped fake fs — the sanctioned seam ("fs module or compatible
// subset") — since a real fstat can't be made to fail on a live fd.
//
// Run: node tests/host/test_append_fstat_fail.js
'use strict';
const path = require('path');
const realFs = require('fs');

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

function main() {
  const closed = [];
  let fstatMode = 'ok'; // 'ok' | 'throw'
  const fakeFs = Object.create(realFs); // inherits constants for flag translation
  fakeFs.openSync = () => 42;
  fakeFs.closeSync = (fd) => { closed.push(fd); };
  fakeFs.fstatSync = () => {
    if (fstatMode === 'throw') { const e = new Error('fake I/O error'); e.code = 'EIO'; throw e; }
    return { size: 7 };
  };
  fakeFs.writeSync = (fd, buf, off, count) => count;

  const env = createFileSystem({ fs: fakeFs, ctx: ctx }).c;

  // --- Positive control: fstat OK → append open positions at EOF --------
  const okFd = env.__open_impl(0, O_WRONLY | O_CREAT | O_APPEND, 0o644);
  check('append open succeeds when fstat works', okFd >= 0, 'fd=' + okFd);
  check('position starts at EOF, not 0', env.lseek(okFd, 0n, SEEK_CUR) === 7n,
    'pos=' + env.lseek(okFd, 0n, SEEK_CUR));

  // --- CD4 leg 1: fstat failure fails the open --------------------------
  errno = null;
  fstatMode = 'throw';
  const badFd = env.__open_impl(0, O_WRONLY | O_CREAT | O_APPEND, 0o644);
  check('append open fails when fstat fails', badFd === -1, 'fd=' + badFd);
  check('errno surfaced', errno === 'EIO', 'errno=' + errno);
  check('native fd not leaked', closed.includes(42), 'closed=' + JSON.stringify(closed));

  // --- CD4 leg 2: post-append-write resync failure surfaces -------------
  // (okFd is still open with position 7; fstat now throws)
  errno = null;
  const n = env.write(okFd, 0, 3);
  check('append write with failed resync reports the error', n === -1, 'n=' + n);
  check('errno surfaced on resync failure', errno === 'EIO', 'errno=' + errno);

  console.log(failures ? failures + ' check(s) FAILED' : 'test_append_fstat_fail: all checks passed');
  process.exit(failures ? 1 : 0);
}

main();
