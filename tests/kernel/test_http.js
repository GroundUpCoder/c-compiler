#!/usr/bin/env node
// HTTP transport semantics (todos/0172; fd-shaped since todos/0417) without
// wasm: a fake worker drives the real SAB protocol against a real brokered
// Kernel with a FAKE fetch injected (opts.fetch), so every path is
// deterministic — no network. The fake fetch hands back a controllable
// Response whose reader resolves from a queue, letting us observe the OFD
// readiness rule (statusConsumed and all four consumable legs), FS_WAIT
// multiplexing (two transfers; transfer + pipe), the never-parking FS_READ
// drain, backpressure (read-call plateau), both kernel deadlines
// (ETIMEDOUT), EOF-vs-error, close-aborts, and teardown reclaim. Same
// fake-worker plumbing as test_pipes.js.
//
// RED CONTROL (todos/0417): on the pre-0417 kernel HTTP_OPEN answers {id},
// not {fd} — the very first check of leg A fails loudly and the run stays
// bounded (no leg parks on an unowned fd).
//
// Run: node tests/kernel/test_http.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const { BLOCK_FS } = require(path.resolve(__dirname, '../../host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 20); i++) await tick(); }
// Deliberate real-time sleep: the deadline legs TEST kernel timers, so the
// clock is the subject here, not a sync crutch.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake fetch: a controllable Response with an observable reader ----
function makeFetch() {
  let script = null;
  const fn = (url, init) => { fn.calls.push({ url, init }); return script(url, init); };
  fn.calls = [];
  fn.setScript = (s) => { script = s; };
  return fn;
}
// Build a Response-like whose reader yields `chunks` in order. opts.errorAt:
// reject the read() at that chunk index (mid-stream failure).
function streamResponse(status, headersObj, chunks, opts) {
  opts = opts || {};
  let i = 0, readCount = 0, cancelled = false;
  const reader = {
    read() {
      readCount++;
      if (cancelled) return new Promise(() => {});          // never resolves post-cancel
      if (opts.errorAt !== undefined && i === opts.errorAt) return Promise.reject(new Error('stream broke'));
      if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: false, value: chunks[i++] });
    },
    cancel() { cancelled = true; return Promise.resolve(); },
  };
  const resp = {
    status,
    headers: { forEach(cb) { for (const k in headersObj) cb(headersObj[k], k); } },
    body: { getReader: () => reader },
  };
  Object.defineProperty(resp, 'readCount', { get: () => readCount });
  Object.defineProperty(resp, 'cancelled', { get: () => cancelled });
  return resp;
}
// A Response whose body is GATED: chunks arrive only when the test pushes
// them ({done:false, value} / {done:true}) — the deterministic driver for
// the statusConsumed/park/idle-deadline legs.
function gatedBody(status, headersObj) {
  const queue = [];
  let pending = null, cancelled = false;
  const reader = {
    read() {
      if (cancelled) return new Promise(() => {});
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => { pending = res; });
    },
    cancel() { cancelled = true; return Promise.resolve(); },
  };
  const resp = {
    status,
    headers: { forEach(cb) { for (const k in headersObj) cb(headersObj[k], k); } },
    body: { getReader: () => reader },
  };
  resp.push = (item) => {
    if (pending) { const p = pending; pending = null; p(item); }
    else queue.push(item);
  };
  Object.defineProperty(resp, 'cancelled', { get: () => cancelled });
  return resp;
}
const bytes = (s) => Buffer.from(s);
const chunkOf = (n, fill) => { const b = new Uint8Array(n); b.fill(fill); return b; };

// ---- fake worker plumbing (test_pipes.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = { procSpec, terminated: false, postMessage() {},
    onMessage(fn) { h.msg = fn; }, onExit(fn) { h.exitCb = fn; }, terminate() { h.terminated = true; } };
  workers.set(procSpec.pid, h);
  return h;
}
const images = new Map([['/bin/init', new Uint8Array([1])], ['/bin/a', new Uint8Array([2])]]);
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const fakeFetch = makeFetch();
const kernel = new K.Kernel({
  fs: kfs, createWorker, fetch: fakeFetch,
  loadImage: (p) => images.get(p) || null, onHalt: () => {}, log: () => {},
});
function page(pid) { const pcb = kernel.process(pid); return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) }; }
function submit(pid, op, req, raw) {
  const h = workers.get(pid); const { i32, u8 } = page(pid);
  if (raw) K.writeRawPayload(i32, u8, req); else K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  return {
    pending: () => Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE,
    async finish() {
      while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
      const resp = K.readPayload(i32, u8);
      Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
      return resp;
    },
  };
}
const rpc = (pid, op, req) => submit(pid, op, req).finish();
const rpcRaw = (pid, op, req) => submit(pid, op, req, true).finish();
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);
// stage a request-body chunk: RAW [u32 off][bytes]
function bodyReq(off, b) {
  const p = new Uint8Array(4 + b.length);
  new DataView(p.buffer).setUint32(0, off, true);
  p.set(b, 4);
  return p;
}
// FS_WRITE raw request: [u32 fd][bytes]
function writeReq(fd, b) {
  const p = new Uint8Array(4 + b.length);
  new DataView(p.buffer).setUint32(0, fd, true);
  p.set(b, 4);
  return p;
}
// The transfer object behind an http fd (test-only introspection).
function xferOf(pid, fd) {
  const id = kernel.process(pid).fds.get(fd);
  const o = id === undefined ? undefined : kernel._ofds.get(id);
  return o && o.kind === 'http' ? o.xfer : undefined;
}
function countHttpOfds() {
  let n = 0;
  kernel._ofds.forEach((o) => { if (o.kind === 'http') n++; });
  return n;
}
// One FS_WAIT over read fds (no ring, no timeout unless given).
const wait = (pid, r, timeoutMs) =>
  rpc(pid, K.OP.FS_WAIT, { r, ring: 0, timeoutMs: timeoutMs === undefined ? null : timeoutMs });
// Drain an http fd via FS_READ until EOF or error, WAITing through EAGAIN.
async function drain(pid, fd, count) {
  const parts = [];
  for (;;) {
    const r = await rpc(pid, K.OP.FS_READ, { fd, count: count || 65536 });
    if (r.errno === 'EAGAIN') { await wait(pid, [fd]); continue; }
    if (r.errno) return { buf: Buffer.concat(parts), eof: false, err: r };
    if (!r.raw || r.raw.length === 0) return { buf: Buffer.concat(parts), eof: true, err: null };
    parts.push(Buffer.from(r.raw));
  }
}

(async () => {
  // A wait that can't be satisfied must FAIL LOUD, never hang the suite.
  setTimeout(() => { console.error('TIMEOUT (a wait leg hung)'); process.exit(1); }, 60000);
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  // a manually-resolved fetch promise, to test deferral deterministically
  const gate = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

  // ---- A: GET — fd-shaped open, non-blocking status, WAIT-first drain ----
  const gA = gate();
  fakeFetch.setScript(() => gA.p);
  let r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/', headers: [] });
  const fdA = r.fd;
  check('HTTP_OPEN returns an fd past stdio (RED CONTROL: {id} pre-0417)',
    Number.isInteger(fdA) && fdA >= 3, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdA });
  check('HTTP_STATUS before headers is EAGAIN, not a park', r.errno === 'EAGAIN', JSON.stringify(r));
  const wA = submit(1, K.OP.FS_WAIT, { r: [fdA], ring: 0, timeoutMs: null });
  await settle(5);
  check('FS_WAIT on a fresh transfer parks (nothing consumable)', wA.pending());
  gA.resolve(streamResponse(200, { 'content-type': 'text/plain' }, [bytes('Hello '), bytes('world')]));
  r = await wA.finish();
  check('headers arriving wake the FS_WAIT with the fd', r.why === 1 && r.r && r.r.indexOf(fdA) >= 0, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdA });
  check('status is 200', r.status === 200, JSON.stringify(r));
  check('headers carry content-type', /content-type: text\/plain/.test(r.headers || ''), JSON.stringify(r));
  let d = await drain(1, fdA);
  check('streamed body reassembles in order', d.buf.toString() === 'Hello world', JSON.stringify(d.buf.toString()));
  check('clean EOF (empty read, not an error)', d.eof === true);
  r = await rpc(1, K.OP.FS_READ, { fd: fdA, count: 16 });
  check('EOF is permanent and honest (0 bytes again)', !r.errno && (!r.raw || r.raw.length === 0), JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdA });

  // ---- B: statusConsumed — the 0417 correction. A caller that consumed
  // the status and now waits for the first body byte BLOCKS; it does not
  // spin on a permanently-readable fd. ----
  const respB = gatedBody(200, {});
  fakeFetch.setScript(() => respB);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/sse', headers: [] });
  const fdB = r.fd;
  await settle(5);
  r = await wait(1, [fdB], 0);
  check('unconsumed status makes the fd readable', r.why === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdB });
  check('status consumed', r.status === 200, JSON.stringify(r));
  const wB = submit(1, K.OP.FS_WAIT, { r: [fdB], ring: 0, timeoutMs: null });
  await settle(10);
  check('post-status wait PARKS until body bytes (no spin — statusConsumed)', wB.pending());
  respB.push({ done: false, value: bytes('data: hi\n') });
  r = await wB.finish();
  check('first body byte wakes the parked wait', r.why === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: fdB, count: 64 });
  check('read gets the bytes', r.raw && Buffer.from(r.raw).toString() === 'data: hi\n', JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: fdB, count: 64 });
  check('dry read is EAGAIN, never a park', r.errno === 'EAGAIN', JSON.stringify(r));
  const wB2 = submit(1, K.OP.FS_WAIT, { r: [fdB], ring: 0, timeoutMs: null });
  await settle(10);
  check('re-wait parks again (EAGAIN spent nothing)', wB2.pending());
  respB.push({ done: true });
  r = await wB2.finish();
  check('clean EOF wakes the wait', r.why === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: fdB, count: 64 });
  check('EOF read is 0 bytes', !r.errno && (!r.raw || r.raw.length === 0), JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdB });

  // ---- C: POST with a staged request body ----
  fakeFetch.calls.length = 0;
  fakeFetch.setScript(() => streamResponse(201, {}, [bytes('ok')]));
  const bodyBytes = bytes('{"q":1}');
  r = await rpcRaw(1, K.OP.HTTP_BODY, bodyReq(0, bodyBytes));
  check('HTTP_BODY stages a chunk', !r.errno, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'POST', url: 'http://x/v1', headers: ['content-type: application/json'] });
  const fdC = r.fd;
  await settle(3);
  const call = fakeFetch.calls[0];
  check('fetch got POST method', call && call.init.method === 'POST', JSON.stringify(call && call.init.method));
  check('fetch got the staged body verbatim', call && Buffer.from(call.init.body).toString() === '{"q":1}', JSON.stringify(call && call.init.body && Buffer.from(call.init.body).toString()));
  check('fetch got parsed header pairs', call && call.init.headers.some((p) => p[0] === 'content-type' && p[1] === 'application/json'), JSON.stringify(call && call.init.headers));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdC });
  check('POST status is 201', r.status === 201, JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdC });

  // ---- D: backpressure — the kernel stops pulling past the cap ----
  // 40 chunks x 64KB = 2.5MB available; cap is 256KB. Without draining, the
  // reader should be pulled only ~cap/chunk (+1 in-flight) times, then pause.
  const N = 40, CH = 64 * 1024;
  const chunks = [];
  for (let i = 0; i < N; i++) chunks.push(chunkOf(CH, i & 0xff));
  const respD = streamResponse(200, {}, chunks);
  fakeFetch.setScript(() => respD);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/big', headers: [] });
  const fdD = r.fd;
  await settle(30);                                 // let the pump run to a stall
  check('backpressure: reader plateaus near cap (not draining whole stream)',
    respD.readCount <= (256 * 1024 / CH) + 2, 'readCount=' + respD.readCount);
  const xferD = xferOf(1, fdD);
  check('backpressure: kernel buffer stays bounded (<= cap + one chunk)',
    xferD && xferD.bytes <= 256 * 1024 + CH, xferD && xferD.bytes);
  await rpc(1, K.OP.HTTP_STATUS, { fd: fdD });
  // Now drain everything and verify integrity + total.
  d = await drain(1, fdD, 128 * 1024);
  check('backpressure: full body drains after resume', d.buf.length === N * CH, 'got ' + d.buf.length);
  check('backpressure: content integrity preserved',
    d.buf[0] === 0 && d.buf[CH] === 1 && d.buf[d.buf.length - 1] === ((N - 1) & 0xff));
  check('backpressure: reader read the whole stream once drained', respD.readCount >= N);
  await rpc(1, K.OP.FS_CLOSE, { fd: fdD });

  // ---- E: mid-stream error is distinct from EOF ----
  fakeFetch.setScript(() => streamResponse(200, {}, [bytes('partial')], { errorAt: 1 }));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/drop', headers: [] });
  const fdE = r.fd;
  await settle(5);
  await rpc(1, K.OP.HTTP_STATUS, { fd: fdE });
  d = await drain(1, fdE);
  check('mid-stream: got the partial bytes first', d.buf.toString() === 'partial', JSON.stringify(d.buf.toString()));
  check('mid-stream: failure surfaces as EIO, not EOF', d.err && d.err.errno === 'EIO', JSON.stringify(d.err));
  check('mid-stream: error string carried through', d.err && /stream broke/.test(d.err.error || ''), JSON.stringify(d.err));
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: fdE });
  check('HTTP_ERROR after a mid-stream drop hands the text (#392)',
    !r.errno && /stream broke/.test(r.error || ''), JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdE });

  // ---- F0: #392 healthy peek — a still-pending transfer reports ''.
  // (A rejected fetch settles on the microtask queue before any RPC can
  // round-trip, so the healthy state needs a never-settling fetch.) ----
  fakeFetch.setScript(() => new Promise(() => {}));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://pending/', headers: [] });
  const fdF0 = r.fd;
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: fdF0 });
  check('HTTP_ERROR on a healthy transfer is the empty string (#392)',
    !r.errno && r.error === '', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdF0 });

  // ---- F: connect error (fetch rejects) -> readable, HTTP_STATUS EIO ----
  fakeFetch.setScript(() => Promise.reject(new Error('ECONNREFUSED')));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://nope/', headers: [] });
  const fdF = r.fd;
  const wF = submit(1, K.OP.FS_WAIT, { r: [fdF], ring: 0, timeoutMs: null });
  r = await wF.finish();
  check('connect error wakes the wait (error is a consumable)', r.why === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdF });
  check('connect error: HTTP_STATUS returns EIO', r.errno === 'EIO', JSON.stringify(r));
  check('connect error: message carried', /ECONNREFUSED/.test(r.error || ''), JSON.stringify(r));
  // #392: the error-TEXT peek — the C surface's channel to the diagnostic.
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: fdF });
  check('HTTP_ERROR hands the transport text (#392)',
    !r.errno && /ECONNREFUSED/.test(r.error || ''), JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: fdF });
  check('HTTP_ERROR is non-consuming (second peek identical)',
    !r.errno && /ECONNREFUSED/.test(r.error || ''), JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: 0 });
  check('HTTP_ERROR on a non-http fd -> EBADF', r.errno === 'EBADF', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdF });
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: fdF });
  check('HTTP_ERROR after close -> EBADF (the text died with the transfer)',
    r.errno === 'EBADF', JSON.stringify(r));

  // ---- F2: Node buries the real reason in err.cause — the kernel digs it
  // out (#392: a bare "fetch failed" told the user nothing). ----
  fakeFetch.setScript(() => Promise.reject(new Error('fetch failed',
    { cause: new Error('connect ECONNREFUSED 127.0.0.1:9') })));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://nope2/', headers: [] });
  const fdF2 = r.fd;
  await settle(5);
  r = await rpc(1, K.OP.HTTP_ERROR, { fd: fdF2 });
  check('the fetch cause chain surfaces in the text (#392)',
    !r.errno && /fetch failed \(connect ECONNREFUSED 127\.0\.0\.1:9\)/.test(r.error || ''),
    JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdF2 });

  // ---- G: synchronous throw in fetch (bad URL) -> EIO, no crash ----
  fakeFetch.setScript(() => { throw new TypeError('Invalid URL'); });
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: ':::bad', headers: [] });
  const fdG = r.fd;
  await settle(5);
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdG });
  check('bad URL (sync throw): surfaces EIO', r.errno === 'EIO', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdG });

  // ---- H: headers deadline -> ETIMEDOUT (distinguishable) ----
  fakeFetch.setScript(() => new Promise(() => {}));   // server never answers
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/never', headers: [], headersMs: 120 });
  const fdH = r.fd;
  const wH = submit(1, K.OP.FS_WAIT, { r: [fdH], ring: 0, timeoutMs: null });
  await settle(5);
  check('deadline leg: wait parks first', wH.pending());
  r = await wH.finish();                              // the 120ms deadline wakes it
  check('headers deadline wakes the wait', r.why === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdH });
  check('headers deadline is ETIMEDOUT, not EIO', r.errno === 'ETIMEDOUT', JSON.stringify(r));
  check('headers deadline names itself', /headers deadline/.test(r.error || ''), JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdH });

  // ---- I: idle deadline — a stalled body times out; a slow-but-live
  // stream does not ----
  const respI = gatedBody(200, {});
  fakeFetch.setScript(() => respI);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/stall', headers: [], idleMs: 150 });
  const fdI = r.fd;
  await settle(5);
  await rpc(1, K.OP.HTTP_STATUS, { fd: fdI });
  const wI = submit(1, K.OP.FS_WAIT, { r: [fdI], ring: 0, timeoutMs: null });
  await settle(5);
  check('idle leg: wait parks while the body stalls', wI.pending());
  r = await wI.finish();                              // the 150ms idle deadline
  check('idle deadline wakes the wait', r.why === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: fdI, count: 64 });
  check('idle deadline is ETIMEDOUT on read', r.errno === 'ETIMEDOUT', JSON.stringify(r));
  check('idle deadline names itself', /idle deadline/.test(r.error || ''), JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdI });

  const respI2 = gatedBody(200, {});
  fakeFetch.setScript(() => respI2);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/slowlive', headers: [], idleMs: 400 });
  const fdI2 = r.fd;
  await settle(5);
  await rpc(1, K.OP.HTTP_STATUS, { fd: fdI2 });
  // Three bytes at ~100ms gaps — each inside the 400ms idle window.
  const slowDrain = drain(1, fdI2, 64);
  for (let i = 0; i < 3; i++) { await sleep(100); respI2.push({ done: false, value: bytes('x') }); }
  respI2.push({ done: true });
  d = await slowDrain;
  check('slow-but-live stream survives the idle deadline', d.eof === true && d.buf.toString() === 'xxx', JSON.stringify(d));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdI2 });

  // ---- J: idle deadline explicitly disabled (idleMs < 0) ----
  const respJ = gatedBody(200, {});
  fakeFetch.setScript(() => respJ);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/silent', headers: [], idleMs: -1 });
  const fdJ = r.fd;
  await settle(5);
  await rpc(1, K.OP.HTTP_STATUS, { fd: fdJ });
  const xferJ = xferOf(1, fdJ);
  check('idleMs < 0 disables the idle clock (no timer armed)',
    xferJ && xferJ.idleMs === 0 && xferJ.idleTimer === null, xferJ && JSON.stringify({ idleMs: xferJ.idleMs, timer: !!xferJ.idleTimer }));
  r = await wait(1, [fdJ], 200);                      // sit silent past any small deadline
  check('silent disabled-idle stream: wait times out cleanly (why 0)', r.why === 0, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: fdJ, count: 64 });
  check('still just EAGAIN (no manufactured error)', r.errno === 'EAGAIN', JSON.stringify(r));
  respJ.push({ done: false, value: bytes('late') });
  await settle(5);
  r = await rpc(1, K.OP.FS_READ, { fd: fdJ, count: 64 });
  check('late byte still arrives', r.raw && Buffer.from(r.raw).toString() === 'late', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdJ });

  // ---- K: TWO transfers through ONE FS_WAIT (the ticket's flagship) ----
  const g1 = gate(), g2 = gate();
  let flip = false;
  fakeFetch.setScript(() => { flip = !flip; return flip ? g1.p : g2.p; });
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/one', headers: [] });
  const fdK1 = r.fd;
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/two', headers: [] });
  const fdK2 = r.fd;
  check('two transfers, two distinct fds', fdK1 !== fdK2 && fdK1 >= 3 && fdK2 >= 3, fdK1 + ',' + fdK2);
  const wK = submit(1, K.OP.FS_WAIT, { r: [fdK1, fdK2], ring: 0, timeoutMs: null });
  await settle(5);
  check('one wait over both transfers parks', wK.pending());
  g2.resolve(streamResponse(200, {}, [bytes('second')]));
  r = await wK.finish();
  check('the SECOND transfer wakes the shared wait, and only it is ready',
    r.why === 1 && r.r && r.r.length === 1 && r.r[0] === fdK2, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdK2 });
  check('ready transfer serves its status', r.status === 200, JSON.stringify(r));
  d = await drain(1, fdK2);
  check('ready transfer drains fully', d.eof && d.buf.toString() === 'second', JSON.stringify(d));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdK2 });
  const wK2 = submit(1, K.OP.FS_WAIT, { r: [fdK1], ring: 0, timeoutMs: null });
  await settle(5);
  check('re-wait on the still-pending transfer parks', wK2.pending());
  g1.resolve(streamResponse(200, {}, [bytes('first')]));
  r = await wK2.finish();
  check('the first transfer wakes it in turn', r.why === 1 && r.r[0] === fdK1, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: fdK1 });
  d = await drain(1, fdK1);
  check('late transfer drains fully', d.eof && d.buf.toString() === 'first', JSON.stringify(d));
  await rpc(1, K.OP.FS_CLOSE, { fd: fdK1 });

  // ---- L: one transfer + one PIPE through one FS_WAIT. Both directions:
  // pipe data answers the mixed wait while the transfer pends, and the
  // transfer wakes a parked mixed wait while the pipe is dry. (The fake
  // worker owns ONE RPC slot, so the pipe byte is written before the wait
  // — a parked pid can't issue a second RPC; cross-process pipe wakes are
  // test_pipes.js territory.) ----
  const gL = gate();
  fakeFetch.setScript(() => gL.p);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/slow', headers: [] });
  const fdL = r.fd;
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const prfd = r.rfd, pwfd = r.wfd;
  await rpcRaw(1, K.OP.FS_WRITE, writeReq(pwfd, bytes('ping')));
  r = await wait(1, [fdL, prfd]);
  check('pipe data answers the mixed wait (transfer still pending)',
    r.why === 1 && r.r.length === 1 && r.r[0] === prfd, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: prfd, count: 16 });
  check('pipe read gets the bytes', r.raw && Buffer.from(r.raw).toString() === 'ping', JSON.stringify(r));
  const wL = submit(1, K.OP.FS_WAIT, { r: [fdL, prfd], ring: 0, timeoutMs: null });
  await settle(5);
  check('drained mixed wait parks (transfer pending, pipe dry)', wL.pending());
  gL.resolve(streamResponse(200, {}, [bytes('done')]));
  r = await wL.finish();
  check('the transfer wakes the mixed wait, and only it is ready',
    r.why === 1 && r.r.length === 1 && r.r[0] === fdL, JSON.stringify(r));
  await rpc(1, K.OP.HTTP_STATUS, { fd: fdL });
  await rpc(1, K.OP.FS_CLOSE, { fd: fdL });
  await rpc(1, K.OP.FS_CLOSE, { fd: prfd });
  await rpc(1, K.OP.FS_CLOSE, { fd: pwfd });

  // ---- M: close(2) aborts the fetch ----
  const respM = streamResponse(200, {}, [chunkOf(CH, 5), chunkOf(CH, 5), chunkOf(CH, 5)]);
  fakeFetch.setScript(() => respM);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/m', headers: [] });
  const fdM = r.fd;
  await settle(5);
  const httpBefore = countHttpOfds();
  check('close leg: transfer OFD live before close', httpBefore >= 1, httpBefore);
  r = await rpc(1, K.OP.FS_CLOSE, { fd: fdM });
  check('close succeeds', !r.errno, JSON.stringify(r));
  await settle(5);
  check('close aborted the fetch reader', respM.cancelled === true);
  check('close freed the transfer OFD', countHttpOfds() === httpBefore - 1, countHttpOfds());

  // ---- N: teardown reclaim — kill mid-transfer aborts the fetch ----
  const respN = streamResponse(200, {}, [chunkOf(CH, 7), chunkOf(CH, 7), chunkOf(CH, 7)]);
  fakeFetch.setScript(() => respN);
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const gpid = r.pid;
  r = await rpc(gpid, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/g', headers: [] });
  const fdN = r.fd;
  await settle(5);
  await rpc(gpid, K.OP.HTTP_STATUS, { fd: fdN });
  check('teardown: transfer OFD exists before kill', xferOf(gpid, fdN) !== undefined);
  // A parked WAIT, then the process dies (SIGKILL) while the fetch is live.
  const wN = submit(gpid, K.OP.FS_WAIT, { r: [fdN], ring: 0, timeoutMs: null });
  await tick();
  kernel.kill(gpid, 9);
  await settle(5);
  check('teardown: fetch reader was cancelled by the fd sweep', respN.cancelled === true);
  check('teardown: transfer freed (no dangling fetch)', countHttpOfds() === 0, countHttpOfds());
  workers.get(gpid).msg({ type: 'exited', code: 137 });
  await rpc(1, K.OP.WAIT, { pid: gpid, options: 0 });
  void wN;

  // ---- O: bad fd -> EBADF (unknown, and a non-http kind) ----
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: 99999 });
  check('unknown fd -> EBADF', r.errno === 'EBADF', JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_STATUS, { fd: 1 });
  check('non-http fd (stdout) -> EBADF', r.errno === 'EBADF', JSON.stringify(r));

  // ---- P: no-fetch kernel answers ENOSYS ----
  const store2 = new BLOCK_FS.MemoryByteStore(1 << 20);
  const kernel2 = new K.Kernel({
    fs: BLOCK_FS.createV4(store2), createWorker: (s) => { const h = { procSpec: s, postMessage(){}, onMessage(f){h.msg=f;}, onExit(){}, terminate(){} }; workers.set('k2:' + s.pid, h); return h; },
    fetch: null, loadImage: (p) => images.get(p) || null, onHalt: () => {}, log: () => {},
  });
  await kernel2.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const h2 = workers.get('k2:1');
  const pcb2 = kernel2.process(1);
  const i2 = new Int32Array(pcb2.page), u2 = new Uint8Array(pcb2.page);
  K.writePayload(i2, u2, { method: 'GET', url: 'http://x/', headers: [] });
  Atomics.store(i2, K.KP_RPC_OP, K.OP.HTTP_OPEN);
  Atomics.store(i2, K.KP_RPC_STATE, K.RPC_REQUEST);
  h2.msg({ type: 'krpc' });
  while (Atomics.load(i2, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const r2 = K.readPayload(i2, u2);
  check('fetch:null kernel -> HTTP_OPEN ENOSYS', r2.errno === 'ENOSYS', JSON.stringify(r2));

  // ---- Q: no-fs kernel answers ENOSYS (the transfer IS an fd; no fd
  // layer, no transfers) ----
  const kernel3 = new K.Kernel({
    createWorker: (s) => { const h = { procSpec: s, postMessage(){}, onMessage(f){h.msg=f;}, onExit(){}, terminate(){} }; workers.set('k3:' + s.pid, h); return h; },
    fetch: fakeFetch, loadImage: (p) => images.get(p) || null, onHalt: () => {}, log: () => {},
  });
  await kernel3.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const h3 = workers.get('k3:1');
  const pcb3 = kernel3.process(1);
  const i3 = new Int32Array(pcb3.page), u3 = new Uint8Array(pcb3.page);
  K.writePayload(i3, u3, { method: 'GET', url: 'http://x/', headers: [] });
  Atomics.store(i3, K.KP_RPC_OP, K.OP.HTTP_OPEN);
  Atomics.store(i3, K.KP_RPC_STATE, K.RPC_REQUEST);
  h3.msg({ type: 'krpc' });
  while (Atomics.load(i3, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const r3 = K.readPayload(i3, u3);
  check('no-fs kernel -> HTTP_OPEN ENOSYS', r3.errno === 'ENOSYS', JSON.stringify(r3));

  console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
