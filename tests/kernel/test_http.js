#!/usr/bin/env node
// HTTP transport semantics (todos/0172) without wasm: a fake worker drives
// the real SAB protocol against a real brokered Kernel with a FAKE fetch
// injected (opts.fetch), so every path is deterministic — no network. The
// fake fetch hands back a controllable Response whose reader resolves from a
// queue, letting us observe backpressure (read-call plateau), the EOF-vs-
// error split, connect errors, and teardown reclaim. Same fake-worker
// plumbing as test_pipes.js.
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
// a manually-resolved fetch promise, to test deferral deterministically
function gate() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);
// stage a request-body chunk: RAW [u32 off][bytes]
function bodyReq(off, b) {
  const p = new Uint8Array(4 + b.length);
  new DataView(p.buffer).setUint32(0, off, true);
  p.set(b, 4);
  return p;
}
// read the full response body via HTTP_READ until EOF/error; returns {buf, eof, err}
async function drain(pid, id, count) {
  const parts = [];
  for (;;) {
    const r = await rpc(pid, K.OP.HTTP_READ, { id, count: count || 65536 });
    if (r.errno) return { buf: Buffer.concat(parts), eof: false, err: r };
    if (!r.raw || r.raw.length === 0) return { buf: Buffer.concat(parts), eof: true, err: null };
    parts.push(Buffer.from(r.raw));
  }
}

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- A: GET, deferred status, streamed body, clean EOF ----
  // A gated fetch: headers don't land until we resolve, so HTTP_STATUS
  // provably parks (the fetch can't have resolved during HTTP_OPEN's await).
  const gA = gate();
  fakeFetch.setScript(() => gA.p);
  let r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/', headers: [] });
  const idA = r.id;
  check('HTTP_OPEN returns a transfer id', idA > 0, JSON.stringify(r));
  const st = submit(1, K.OP.HTTP_STATUS, { id: idA });
  await settle(3);
  check('HTTP_STATUS defers until headers arrive', st.pending());
  gA.resolve(streamResponse(200, { 'content-type': 'text/plain' }, [bytes('Hello '), bytes('world')]));
  r = await st.finish();
  check('status is 200', r.status === 200, JSON.stringify(r));
  check('headers carry content-type', /content-type: text\/plain/.test(r.headers || ''), JSON.stringify(r));
  let d = await drain(1, idA);
  check('streamed body reassembles in order', d.buf.toString() === 'Hello world', JSON.stringify(d.buf.toString()));
  check('clean EOF (empty read, not an error)', d.eof === true);
  await rpc(1, K.OP.HTTP_CLOSE, { id: idA });

  // ---- B: POST with a staged request body ----
  fakeFetch.calls.length = 0;
  fakeFetch.setScript(() => streamResponse(201, {}, [bytes('ok')]));
  const bodyBytes = bytes('{"q":1}');
  r = await rpcRaw(1, K.OP.HTTP_BODY, bodyReq(0, bodyBytes));
  check('HTTP_BODY stages a chunk', !r.errno, JSON.stringify(r));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'POST', url: 'http://x/v1', headers: ['content-type: application/json'] });
  const idB = r.id;
  await settle(3);
  const call = fakeFetch.calls[0];
  check('fetch got POST method', call && call.init.method === 'POST', JSON.stringify(call && call.init.method));
  check('fetch got the staged body verbatim', call && Buffer.from(call.init.body).toString() === '{"q":1}', JSON.stringify(call && call.init.body && Buffer.from(call.init.body).toString()));
  check('fetch got parsed header pairs', call && call.init.headers.some((p) => p[0] === 'content-type' && p[1] === 'application/json'), JSON.stringify(call && call.init.headers));
  r = await rpc(1, K.OP.HTTP_STATUS, { id: idB });
  check('POST status is 201', r.status === 201, JSON.stringify(r));
  await rpc(1, K.OP.HTTP_CLOSE, { id: idB });

  // ---- C: backpressure — the kernel stops pulling past the cap ----
  // 40 chunks x 64KB = 2.5MB available; cap is 256KB. Without draining, the
  // reader should be pulled only ~cap/chunk (+1 in-flight) times, then pause.
  const N = 40, CH = 64 * 1024;
  const chunks = [];
  for (let i = 0; i < N; i++) chunks.push(chunkOf(CH, i & 0xff));
  const respC = streamResponse(200, {}, chunks);
  fakeFetch.setScript(() => respC);
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/big', headers: [] });
  const idC = r.id;
  await rpc(1, K.OP.HTTP_STATUS, { id: idC });     // resolves headers, starts the pump
  await settle(30);                                 // let the pump run to a stall
  check('backpressure: reader plateaus near cap (not draining whole stream)',
    respC.readCount <= (256 * 1024 / CH) + 2, 'readCount=' + respC.readCount);
  const xferC = kernel._httpXfers.get(idC);
  check('backpressure: kernel buffer stays bounded (<= cap + one chunk)',
    xferC && xferC.bytes <= 256 * 1024 + CH, xferC && xferC.bytes);
  // Now drain everything and verify integrity + total.
  d = await drain(1, idC, 128 * 1024);
  check('backpressure: full body drains after resume', d.buf.length === N * CH, 'got ' + d.buf.length);
  check('backpressure: content integrity preserved',
    d.buf[0] === 0 && d.buf[CH] === 1 && d.buf[d.buf.length - 1] === ((N - 1) & 0xff));
  check('backpressure: reader read the whole stream once drained', respC.readCount >= N);
  await rpc(1, K.OP.HTTP_CLOSE, { id: idC });

  // ---- D: mid-stream error is distinct from EOF ----
  fakeFetch.setScript(() => streamResponse(200, {}, [bytes('partial')], { errorAt: 1 }));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/drop', headers: [] });
  const idD = r.id;
  await rpc(1, K.OP.HTTP_STATUS, { id: idD });
  d = await drain(1, idD);
  check('mid-stream: got the partial bytes first', d.buf.toString() === 'partial', JSON.stringify(d.buf.toString()));
  check('mid-stream: failure surfaces as EIO, not EOF', d.err && d.err.errno === 'EIO', JSON.stringify(d.err));
  check('mid-stream: error string carried through', d.err && /stream broke/.test(d.err.error || ''), JSON.stringify(d.err));
  await rpc(1, K.OP.HTTP_CLOSE, { id: idD });

  // ---- E: connect error (fetch rejects) -> HTTP_STATUS EIO ----
  fakeFetch.setScript(() => Promise.reject(new Error('ECONNREFUSED')));
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://nope/', headers: [] });
  const idE = r.id;
  const se = submit(1, K.OP.HTTP_STATUS, { id: idE });
  await settle(3);
  r = await se.finish();
  check('connect error: HTTP_STATUS returns EIO', r.errno === 'EIO', JSON.stringify(r));
  check('connect error: message carried', /ECONNREFUSED/.test(r.error || ''), JSON.stringify(r));
  await rpc(1, K.OP.HTTP_CLOSE, { id: idE });

  // ---- F: synchronous throw in fetch (bad URL) -> EIO, no crash ----
  fakeFetch.setScript(() => { throw new TypeError('Invalid URL'); });
  r = await rpc(1, K.OP.HTTP_OPEN, { method: 'GET', url: ':::bad', headers: [] });
  r = await rpc(1, K.OP.HTTP_STATUS, { id: r.id });
  check('bad URL (sync throw): surfaces EIO', r.errno === 'EIO', JSON.stringify(r));

  // ---- G: teardown reclaim — kill mid-transfer aborts the fetch ----
  const respG = streamResponse(200, {}, [chunkOf(CH, 7), chunkOf(CH, 7), chunkOf(CH, 7)]);
  fakeFetch.setScript(() => respG);
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const gpid = r.pid;
  r = await rpc(gpid, K.OP.HTTP_OPEN, { method: 'GET', url: 'http://x/g', headers: [] });
  const idG = r.id;
  await rpc(gpid, K.OP.HTTP_STATUS, { id: idG });
  await settle(5);
  check('teardown: transfer exists before kill', kernel._httpXfers.has(idG));
  // A parked read, then the process dies (SIGKILL) while the fetch is live.
  const pr = submit(gpid, K.OP.HTTP_READ, { id: idG, count: 65536 });
  await tick();
  kernel.kill(gpid, 9);
  await settle(5);
  check('teardown: fetch reader was cancelled', respG.cancelled === true);
  check('teardown: transfer freed (no dangling fetch)', !kernel._httpXfers.has(idG));
  workers.get(gpid).msg({ type: 'exited', code: 137 });
  await rpc(1, K.OP.WAIT, { pid: gpid, options: 0 });

  // ---- H: bad id -> EBADF ----
  r = await rpc(1, K.OP.HTTP_STATUS, { id: 99999 });
  check('unknown id -> EBADF', r.errno === 'EBADF', JSON.stringify(r));

  // ---- I: no-fetch kernel answers ENOSYS ----
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

  console.log(failures === 0 ? '\nPASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
