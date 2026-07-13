#!/usr/bin/env node
// libcurl veneer end-to-end (todos/0173): the 0173 differential smoke.
// ONE C program (os/curl/test/smoke.c) dumps status/headers/body through the
// three easy-interface callbacks. It builds TWO ways:
//   - gucOS: os/curl/test/smoke.json (the veneer over __http_* -> kernel
//     0x06xx -> Node fetch), run in a worker_thread kernel — system under test
//   - native: clang smoke.c -lcurl (real libcurl) — the reference oracle,
//     skipped when clang isn't available
// Both run against the same local Node server; outputs must match after
// normalizing the DOCUMENTED divergences (header order/casing + which
// transport headers exist: the harness filters "H <name>" lines to an
// allowlist and sorts them; everything else diffs byte-identical).
// Cases: streamed 200 GET, POST (POSTFIELDS + buffered READFUNCTION), 404
// (perform OK + RESPONSE_CODE 404), connection refused (CURLE_COULDNT_
// CONNECT), total-timeout abort on a stalled body (CURLE_OPERATION_TIMEDOUT),
// escape/unescape.
//
// Run: node tests/kernel/test_curl_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const util = require('util');
const http = require('http');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// ---- local HTTP server (shared by both legs) ----
const sockets = new Set();
const server = http.createServer((req, res) => {
  const u = req.url;
  if (u === '/hello') {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-smoke-resp': '1' });
    res.write('Hello, ');
    setTimeout(() => res.end('world!'), 10);        // two chunks
    return;
  }
  if (u === '/echo' && req.method === 'POST') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { res.writeHead(200); res.end(Buffer.concat(parts)); });
    return;
  }
  if (u === '/missing') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return; }
  if (u === '/stall') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial-');                          // then never finish
    return;
  }
  res.writeHead(500); res.end();
});
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

/* Normalize the documented divergences before diffing:
   - "H <name>" runs: keep only allowlisted names, sorted (fetch vs raw wire
     disagree on transport headers, order, and casing)
   - everything else passes through verbatim */
const HDR_ALLOW = new Set(['content-type', 'x-smoke-resp', 'content-length']);
function normalize(out) {
  const lines = out.split('\n');
  const res = [];
  let run = [];
  const flush = () => { if (run.length) { res.push(...run.sort()); run = []; } };
  for (const l of lines) {
    if (l.startsWith('H ')) {
      const name = l.slice(2).trim();
      if (HDR_ALLOW.has(name)) run.push('H ' + name);
    } else { flush(); res.push(l); }
  }
  flush();
  return res.join('\n');
}

(async () => {
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const base = `http://127.0.0.1:${port}`;
  // A port that just closed = deterministic connection-refused target.
  const refusedPort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const refused = `http://127.0.0.1:${refusedPort}`;

  const watchdog = setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 120000);

  // ---- gucOS leg: build the smoke via the veneer lib.json, boot it ----
  const readHostFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const wasm = OS_COMMON.buildProject(require(COMPILER), 'os/curl/test/smoke.json', readHostFile);
  const images = new Map([['/bin/smoke', wasm]]);

  const store = new BLOCK_FS.MemoryByteStore(8 << 20);
  const kfs = BLOCK_FS.createV4(store);
  let out = '', errOut = '';
  let haltResolve;
  const haltPromise = new Promise((res) => { haltResolve = res; });
  const kernel = new K.Kernel({
    fs: kfs,
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => images.get(p) || null,
    onOutput: (pid, fd, bytes) => {
      if (fd === 1) out += Buffer.from(bytes).toString();
      else errOut += Buffer.from(bytes).toString();
    },
    onHalt: (status) => haltResolve(status),
    log: () => {},
  });
  kernel.createTty({ output: () => {} });
  await kernel.boot({ path: '/bin/smoke', argv: ['smoke', base, refused], envp: [], cwd: '/' });
  const status = await haltPromise;

  check('gucOS smoke exited 0', status === 0, `status=${status} stderr=${errOut.slice(0, 400)}`);
  check('no dangling HTTP transfers after halt', kernel._httpXfers.size === 0, String(kernel._httpXfers.size));

  // Standalone assertions on the gucOS output (hold even without clang).
  const lines = out.split('\n');
  const section = (name) => {
    const i = lines.indexOf(`== ${name} ==`);
    if (i < 0) return [];
    const j = lines.findIndex((l, k) => k > i && l.startsWith('== '));
    return lines.slice(i + 1, j < 0 ? lines.length : j);
  };
  const has = (name, want) => {
    const sec = section(name);
    check(`[${name}] has ${JSON.stringify(want)}`, sec.includes(want),
      JSON.stringify(sec.slice(0, 12)));
  };
  has('get', 'rc=0');
  has('get', 'status=200');
  has('get', 'ctype=text/plain');
  has('get', 'size=13 clen=-1');
  has('get', 'body[13]=Hello, world!');
  has('post', 'rc=0');
  has('post', 'body[12]=ping-echo-42');
  has('readcb', 'rc=0');
  has('readcb', 'body[18]=read-callback-body');
  has('404', 'rc=0');
  has('404', 'status=404');
  has('404', 'body[4]=nope');
  has('refused', 'rc=7');            // CURLE_COULDNT_CONNECT
  has('refused', 'errbuf_set=1');
  has('timeout', 'rc=28');           // CURLE_OPERATION_TIMEDOUT
  has('escape', 'esc=a%20b%26c%2Fd~e_f');
  has('escape', 'unesc=a b&c/d len=7');
  check('reached done', lines.includes('done'), JSON.stringify(lines.slice(-3)));

  // ---- native leg: real libcurl as the oracle (skip without clang) ----
  let haveClang = true;
  try { cp.execFileSync('clang', ['--version'], { stdio: 'pipe' }); }
  catch (e) { haveClang = false; }
  if (haveClang) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'curl-smoke-'));
    const nat = path.join(tmp, 'smoke-native');
    cp.execFileSync('clang', [path.join(ROOT, 'os/curl/test/smoke.c'), '-o', nat, '-lcurl'],
      { stdio: 'pipe' });
    // async exec — the fake server shares this event loop (the smoke.mjs rule)
    const { stdout: natOut } = await util.promisify(cp.execFile)(nat, [base, refused],
      { encoding: 'utf8', timeout: 60000 });
    const a = normalize(natOut), b = normalize(out);
    check('differential: native (real libcurl) output matches gucOS after normalization',
      a === b,
      a === b ? undefined : '\n--- native ---\n' + a + '\n--- gucOS ---\n' + b);
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log('  skip native differential leg (clang not found)');
  }

  clearTimeout(watchdog);
  for (const s of sockets) s.destroy();            // the /stall connections
  server.close();
  console.log(failures === 0 ? '\ncurl e2e: PASS' : `\ncurl e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
