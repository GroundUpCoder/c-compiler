// Host-level regression test for the console fast path's POSITIVE capability
// (code-debt CD27): stdout/stderr/stdin console routing must key on
// `entry.console === true` — a marker carried ONLY by BlockFS's three default
// fd 0/1/2 entries — never on the ABSENCE of fields (the old
// `type === undefined && inoId === undefined` duck-type).
//
// The corruption mode the old check allowed: toWasmEnv is reused over other
// fd backends (kernel.js RemoteFS), whose fd-table entries merely LACK
// type/inoId unless the backend plants a decoy ({type:'remote'} on 0/1/2).
// A new backend (or new fd-creating path) that forgets the decoy has its
// redirected fd 1/2 silently routed to the console — data corruption, no
// error. With the positive marker, absence means "not console", the safe
// default, and the decoys are deleted.
//
// Cases:
//  1. RED pre-fix: a backend with an EMPTY fd table (no decoys) must have
//     env.write(1) dispatched to backend.write, not the console.
//  2. Default fd 1/2 still hit the console fast path.
//  3. A dup2-redirected fd 1 lands byte-exact in the file, console untouched.
//  4. The hush fd-save dance: the console marker survives dup + dup2 restore.
//  5. close(1) on the default entry is a no-op that keeps the console slot.
//  6. Read side: default fd 0 serves the console stdin buffer; a redirected
//     fd 0 reads the file.
//
// Run: node tests/host/test_console_capability.js
'use strict';

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;

var failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

var encoder = new TextEncoder();
var decoder = new TextDecoder();

// A minimal toWasmEnv ctx over a plain ArrayBuffer "memory", with console
// output captured. putBytes stages data for a write(ptr) call.
function makeCtx() {
  var memory = { buffer: new ArrayBuffer(65536) };
  var out = [], err = [];
  return {
    ctx: {
      readString: function (ptr) {
        var b = new Uint8Array(memory.buffer);
        var end = ptr;
        while (b[end] !== 0) end++;
        return decoder.decode(b.subarray(ptr, end));
      },
      setErrno: function () {},
      setErrnoName: function () {},
      getMemory: function () { return memory; },
      writeOut: function (buf) { out.push(new Uint8Array(buf)); },
      writeErr: function (buf) { err.push(new Uint8Array(buf)); },
    },
    out: out,
    err: err,
    putBytes: function (ptr, bytes) {
      new Uint8Array(memory.buffer).set(bytes, ptr);
    },
    getBytes: function (ptr, n) {
      return new Uint8Array(memory.buffer).slice(ptr, ptr + n);
    },
  };
}

function concat(chunks) {
  var n = 0;
  for (var i = 0; i < chunks.length; i++) n += chunks[i].length;
  var all = new Uint8Array(n), o = 0;
  for (var j = 0; j < chunks.length; j++) { all.set(chunks[j], o); o += chunks[j].length; }
  return decoder.decode(all);
}

// ---- 1. The CD27 corruption mode: a RemoteFS-shaped backend WITHOUT decoys.
// toWasmEnv dispatches via `this.`, so any object with the method surface
// works. Its fd table has NO entries on 0/1/2 — exactly the forgotten-decoy
// backend. env.write(1) must reach backend.write (the RPC seam), never the
// console.
(function () {
  var c = makeCtx();
  var calls = [];
  var backend = {
    _fdTable: [],                 // no decoys — the hazard under test
    _lastError: null,
    setStdinSab: function () {},
    write: function (fd, buf, count) {
      calls.push({ fd: fd, data: decoder.decode(buf.slice(0, count)) });
      return count;
    },
  };
  var env = BLOCK_FS.BlockFS.prototype.toWasmEnv.call(backend, c.ctx);
  var msg = encoder.encode('to-the-backend');
  c.putBytes(1024, msg);
  var n = env.write(1, 1024, msg.length);
  check('decoy-less backend: write(1) returns count', n === msg.length, 'n=' + n);
  check('decoy-less backend: bytes reached backend.write, fd preserved',
    calls.length === 1 && calls[0].fd === 1 && calls[0].data === 'to-the-backend',
    JSON.stringify(calls));
  check('decoy-less backend: nothing leaked to the console',
    c.out.length === 0 && c.err.length === 0,
    'out=' + JSON.stringify(concat(c.out)) + ' err=' + JSON.stringify(concat(c.err)));
})();

// ---- The remaining cases run over a real BlockFS.
function freshFs() {
  return BLOCK_FS.createV4(new MemoryByteStore(4 * 1024 * 1024));
}

// ---- 2. Default fd 1/2 hit the console fast path.
(function () {
  var c = makeCtx();
  var fs = freshFs();
  var env = fs.toWasmEnv(c.ctx);
  c.putBytes(1024, encoder.encode('hello-out'));
  c.putBytes(2048, encoder.encode('hello-err'));
  env.write(1, 1024, 9);
  env.write(2, 2048, 9);
  check('default fd1 goes to console out', concat(c.out) === 'hello-out', concat(c.out));
  check('default fd2 goes to console err', concat(c.err) === 'hello-err', concat(c.err));
})();

// ---- 3 + 4. Redirect fd 1 to a file, write, restore (the hush dance).
(function () {
  var c = makeCtx();
  var fs = freshFs();
  var env = fs.toWasmEnv(c.ctx);

  var saved = fs.dup(1);                       // save the console entry
  check('console entry dups to a high fd', saved >= 3, 'saved=' + saved);

  var O_CREAT = 0x40, O_WRONLY = 1;
  var ffd = fs.open('/cap.txt', O_CREAT | O_WRONLY, 0o644);
  check('file opened', ffd >= 3, 'ffd=' + ffd);
  fs.dup2(ffd, 1);                             // redirect

  var msg = encoder.encode('redirected-bytes');
  c.putBytes(1024, msg);
  var n = env.write(1, 1024, msg.length);
  check('redirected fd1 write returns count', n === msg.length, 'n=' + n);
  check('redirected fd1: console untouched', c.out.length === 0, concat(c.out));

  fs.dup2(saved, 1);                           // restore
  fs.close(saved);
  fs.close(ffd);
  c.putBytes(1024, encoder.encode('back-home'));
  env.write(1, 1024, 9);
  check('restored fd1 goes to console again (marker survived dup/dup2)',
    concat(c.out) === 'back-home', concat(c.out));

  var rfd = fs.open('/cap.txt', 0, 0);
  var buf = new Uint8Array(64);
  var got = fs.read(rfd, buf, 64);
  fs.close(rfd);
  check('redirected bytes landed byte-exact in the file',
    got === msg.length && decoder.decode(buf.subarray(0, got)) === 'redirected-bytes',
    decoder.decode(buf.subarray(0, Math.max(got, 0))));
})();

// ---- 5. close(1) on the default entry keeps the console slot.
(function () {
  var c = makeCtx();
  var fs = freshFs();
  var env = fs.toWasmEnv(c.ctx);
  var r = fs.close(1);
  check('close(1) on the default entry succeeds as a no-op', r === 0, 'r=' + r);
  c.putBytes(1024, encoder.encode('still-console'));
  env.write(1, 1024, 13);
  check('fd1 still routes to the console after the no-op close',
    concat(c.out) === 'still-console', concat(c.out));
})();

// ---- 6. Read side: default fd 0 = console stdin; redirected fd 0 = file.
(function () {
  var fs = freshFs();
  fs.setStdin(encoder.encode('typed\n'));
  var buf = new Uint8Array(64);
  var n = fs.read(0, buf, 64);
  check('default fd0 reads the console stdin buffer',
    n === 6 && decoder.decode(buf.subarray(0, n)) === 'typed\n',
    'n=' + n);

  var O_CREAT = 0x40, O_WRONLY = 1;
  var wfd = fs.open('/stdin.txt', O_CREAT | O_WRONLY, 0o644);
  fs.write(wfd, encoder.encode('from-file'), 9);
  fs.close(wfd);
  var rfd = fs.open('/stdin.txt', 0, 0);
  fs.dup2(rfd, 0);
  fs.close(rfd);
  var n2 = fs.read(0, buf, 64);
  check('redirected fd0 reads the file, not the stdin buffer',
    n2 === 9 && decoder.decode(buf.subarray(0, n2)) === 'from-file',
    'n2=' + n2);
})();

console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
