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
// CLI leg (todos/0182): /bin/curl (os/curl/curl-cli.c, seeded via
// os/curl/cli.json) driven through a real OS boot — os/boot.js + hush —
// against the SAME local server: body to stdout, status line to stderr,
// -s/-o/-X/-H/-d/-f/-L, bundled + attached flag forms, curl-idiom exit
// codes (refused = 7, -f on HTTP >= 400 = 22, usage = 2).
// Browser CORS asymmetry is inherited from 0172 — documented there, NOT
// re-tested here (this leg is headless Node fetch; no CORS applies).
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
  if (u === '/method') { res.writeHead(200); res.end(req.method); return; }   // 0182: -X proof
  if (u === '/hdr') {                                                         // 0182: -H proof
    res.writeHead(200); res.end(String(req.headers['x-cli-test'] || 'MISSING')); return;
  }
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

  // 480s: the 0182 CLI leg boots the real OS — a cold (no-fixture) image
  // bake alone can run ~100s+.
  const watchdog = setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 480000);

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

  // ---- CLI leg (todos/0182): /bin/curl through a real OS boot ----
  // NB an ASYNC spawn, not lib/drive.js's spawnSync driveBoot: the fake
  // server shares this event loop (the same rule as the native leg above) —
  // a sync spawn would deadlock the in-OS curl against an unresponsive
  // server.
  {
    const { freshImage, section } = require('./lib/drive.js');
    const { image } = freshImage('os-curl-cli-');
    const bootAsync = (script) => new Promise((resolve, reject) => {
      const child = cp.spawn('node',
        [path.join(ROOT, 'os/boot.js'), '--image=' + image, '--quiet'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      let so = '', se = '';
      child.stdout.on('data', (d) => { so += d; });
      child.stderr.on('data', (d) => { se += d; });
      const t = setTimeout(() => child.kill('SIGKILL'), 420000);
      child.on('close', () => { clearTimeout(t); resolve({ stdout: so, stderr: se }); });
      child.on('error', reject);
      child.stdin.write(script.endsWith('\n') ? script : script + '\n');
      child.stdin.end();
    });

    const script = [
      'echo ==get',
      `curl -s ${base}/hello`,
      'echo "|RC=$?"',
      'echo ==status',
      `curl ${base}/hello >/root/o.txt 2>/root/e.txt`,
      'echo RC=$?',
      'cat /root/e.txt',
      'cat /root/o.txt',
      'echo "|"',
      'echo ==post',
      `curl -s -d ping-cli-77 ${base}/echo`,
      'echo "|RC=$?"',
      'echo ==postjoin',
      `curl -s -d a=1 -d b=2 ${base}/echo`,
      'echo "|RC=$?"',
      'echo ==method',
      `curl -s -X PUT ${base}/method`,
      'echo "|RC=$?"',
      'echo ==hdr',
      `curl -s -H "X-Cli-Test: hdr-42" ${base}/hdr`,
      'echo "|RC=$?"',
      'echo ==ofile',
      `curl -s -o /root/dl.txt ${base}/hello`,
      'echo RC=$?',
      'cat /root/dl.txt',
      'echo "|"',
      'echo ==obundle',
      `curl -so/root/dl2.txt ${base}/hello`,     // bundled bool + attached value
      'echo RC=$?',
      'cat /root/dl2.txt',
      'echo "|"',
      'echo ==refused',
      `curl -s ${refused}/`,
      'echo RC=$?',
      `curl ${refused}/ 2>/root/e2.txt`,
      'echo RC2=$?',
      'cat /root/e2.txt',
      'echo ==404',
      `curl -s ${base}/missing`,
      'echo "|RC=$?"',
      'echo ==404f',
      `curl -sf -o /root/f.out ${base}/missing`,
      'echo RC=$?',
      'wc -c /root/f.out',
      'echo ==404loud',
      `curl -f ${base}/missing >/root/junk.txt 2>/root/e3.txt`,
      'echo RC=$?',
      'cat /root/e3.txt',
      'wc -c /root/junk.txt',
      'echo ==redir',
      `curl -sL ${base}/hello`,
      'echo "|RC=$?"',
      'echo ==usage',
      'curl -s 2>/root/junk2.txt',
      'echo RC=$?',
      `curl -Z ${base}/hello 2>/root/junk3.txt`,
      'echo RC2=$?',
      'echo ==cli-done',
      '',
    ].join('\n');

    const r = await bootAsync(script);
    const out = r.stdout;
    const sec = (name) => section(out, name);
    const secHas = (name, needle) => {
      const s = sec(name);
      check(`cli [${name}] has ${JSON.stringify(needle)}`, s.includes(needle),
        JSON.stringify(s.slice(0, 200)) || r.stderr.slice(0, 200));
    };
    check('cli reached done marker', out.includes('==cli-done'),
      out.slice(-400) + '\nstderr: ' + r.stderr.slice(-400));
    // body to stdout, -s silences the status line, exit 0
    secHas('get', 'Hello, world!|RC=0');
    // without -s: status line on stderr, body untouched on stdout
    secHas('status', 'RC=0');
    secHas('status', 'curl: HTTP 200');
    secHas('status', 'Hello, world!|');
    // -d POST round-trips through /echo
    secHas('post', 'ping-cli-77|RC=0');
    // repeated -d joins with '&' (real curl semantics)
    secHas('postjoin', 'a=1&b=2|RC=0');
    // -X reaches the wire
    secHas('method', 'PUT|RC=0');
    // -H reaches the wire
    secHas('hdr', 'hdr-42|RC=0');
    // -o writes the body to FILE, nothing on stdout
    check('cli [ofile] file has body, stdout clean', sec('ofile') === 'RC=0\nHello, world!|\n',
      JSON.stringify(sec('ofile')));
    // bundled -so/root/dl2.txt: bool bundle + attached value form
    check('cli [obundle] bundled/attached flags', sec('obundle') === 'RC=0\nHello, world!|\n',
      JSON.stringify(sec('obundle')));
    // refused connection: exit 7 (CURLE_COULDNT_CONNECT), strerror unless -s
    secHas('refused', 'RC=7');
    secHas('refused', 'RC2=7');
    secHas('refused', 'curl: (7)');
    // HTTP 404 without -f is SUCCESS (curl idiom): body printed, exit 0
    secHas('404', 'nope|RC=0');
    // -f: exit 22, body suppressed (0-byte -o file)
    secHas('404f', 'RC=22');
    secHas('404f', '0 /root/f.out');
    secHas('404loud', 'RC=22');
    secHas('404loud', 'curl: (22)');
    secHas('404loud', '0 /root/junk.txt');
    // -L accepted (no-op: the veneer always follows redirects — documented)
    secHas('redir', 'Hello, world!|RC=0');
    // usage errors: exit 2 (missing URL, unknown option)
    secHas('usage', 'RC=2');
    secHas('usage', 'RC2=2');
  }

  clearTimeout(watchdog);
  for (const s of sockets) s.destroy();            // the /stall connections
  server.close();
  console.log(failures === 0 ? '\ncurl e2e: PASS' : `\ncurl e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
