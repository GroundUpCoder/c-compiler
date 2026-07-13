#!/usr/bin/env node
// HTTP transport end-to-end (todos/0172): a real C process in a worker_thread
// drives the FULL stack — C extern __http_* -> host.js env imports ->
// KernelClient RPC -> kernel 0x06xx -> Node's global fetch -> a local HTTP
// server. Proves the veneer-facing primitive carries real data: streamed GET,
// POST with a body echoed back, a large multi-chunk body (integrity through
// undici's streaming reader), a 404 (perform succeeds, status surfaced), and
// a mid-stream connection drop (EOF vs error split). No external network — the
// server is localhost, torn down at the end.
//
// Run: node tests/kernel/test_http_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const BIG = 512 * 1024;   // > HTTP_BUF_CAP (256K) so backpressure engages live

const INIT_C = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The kernel HTTP primitive (todos/0172), surfaced by host.js as env imports
   and declared __import by the compiler prelude. The libcurl veneer (0173)
   will wrap these; here we call them directly. */
__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen);
__import int __http_status(int id, int *status_out, char *hdr, int hdrcap);
__import int __http_read(int id, void *buf, int cap);
__import int __http_close(int id);

static char obuf[600000];   /* static: the wasm stack is tiny */

/* Returns total body bytes (>=0), or a negative code: -1 open, -2 status,
   -3 mid-stream read error. Fills *status and copies the body into obuf. */
static int fetch_all(const char *method, const char *url, const char *headers,
                     const void *body, int blen, int *status) {
    int id = __http_open(method, url, headers, body, blen);
    if (id < 0) return -1;
    char hdr[8192];
    int hl = __http_status(id, status, hdr, sizeof hdr);
    if (hl < 0) { __http_close(id); return -2; }
    int total = 0;
    for (;;) {
        char buf[8192];
        int n = __http_read(id, buf, sizeof buf);
        if (n < 0) { __http_close(id); return -3; }
        if (n == 0) break;                       /* clean EOF */
        if (total + n <= (int)sizeof obuf) memcpy(obuf + total, buf, n);
        total += n;
    }
    __http_close(id);
    return total;
}

int main(void) {
    const char *base = getenv("BASE");
    char url[256];
    int status, n;

    snprintf(url, sizeof url, "%s/hello", base);
    n = fetch_all("GET", url, "", 0, 0, &status);
    printf("hello status=%d n=%d body=%.*s\\n", status, n, n < 0 ? 0 : n, obuf);

    snprintf(url, sizeof url, "%s/echo", base);
    const char *payload = "ping-123";
    n = fetch_all("POST", url, "content-type: text/plain\\n", payload, (int)strlen(payload), &status);
    printf("echo status=%d body=%.*s\\n", status, n < 0 ? 0 : n, obuf);

    snprintf(url, sizeof url, "%s/big", base);
    n = fetch_all("GET", url, "", 0, 0, &status);
    printf("big status=%d n=%d first=%d last=%d\\n", status, n,
           n > 0 ? (unsigned char)obuf[0] : -1,
           n > 0 ? (unsigned char)obuf[n - 1] : -1);

    snprintf(url, sizeof url, "%s/missing", base);
    n = fetch_all("GET", url, "", 0, 0, &status);
    printf("missing status=%d\\n", status);

    snprintf(url, sizeof url, "%s/drop", base);
    n = fetch_all("GET", url, "", 0, 0, &status);
    printf("drop rc=%d\\n", n);

    printf("done\\n");
    return 0;
}
`;

// ---- local HTTP server ----
const server = http.createServer((req, res) => {
  const u = req.url;
  if (u === '/hello') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('Hello, ');
    setTimeout(() => res.end('world!'), 10);    // two chunks, small gap
    return;
  }
  if (u === '/echo' && req.method === 'POST') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { res.writeHead(200); res.end(Buffer.concat(parts)); });
    return;
  }
  if (u === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const chunk = Buffer.alloc(32 * 1024);
    let sent = 0;
    (function pump() {
      while (sent < BIG) {
        for (let i = 0; i < chunk.length; i++) chunk[i] = (sent + i) & 0xff;
        sent += chunk.length;
        if (!res.write(Buffer.from(chunk))) { res.once('drain', pump); return; }
      }
      res.end();
    })();
    return;
  }
  if (u === '/missing') { res.writeHead(404); res.end('nope'); return; }
  if (u === '/drop') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('half');
    setTimeout(() => req.socket.destroy(), 10);  // kill mid-stream
    return;
  }
  res.writeHead(500); res.end();
});

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-http-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}

(async () => {
  const images = new Map([['/bin/init', compile('init', INIT_C)]]);
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const base = `http://127.0.0.1:${port}`;

  const store = new BLOCK_FS.MemoryByteStore(8 << 20);
  const kfs = BLOCK_FS.createV4(store);
  let out = '';
  let haltResolve;
  const haltPromise = new Promise((res) => { haltResolve = res; });
  const kernel = new K.Kernel({
    fs: kfs,
    // No opts.fetch -> the kernel uses Node's global fetch (the real stack).
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => images.get(p) || null,
    onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
    onHalt: (status) => haltResolve(status),
    log: () => {},
  });
  kernel.createTty({ output: () => {} });

  const watchdog = setTimeout(() => {
    console.error('TIMEOUT\noutput:\n' + out);
    try { server.close(); } catch (e) {}
    process.exit(1);
  }, 90000);

  await kernel.boot({ path: '/bin/init', argv: ['init'],
    envp: ['BASE=' + base], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);
  server.close();

  check('init exited 0', status === 0, String(status));
  const lines = out.trim().split('\n');
  const line = (prefix) => lines.find((l) => l.startsWith(prefix)) || '';

  check('GET streams status + reassembled body',
    line('hello ') === 'hello status=200 n=13 body=Hello, world!', JSON.stringify(line('hello ')));
  check('POST body echoed back',
    line('echo ') === 'echo status=200 body=ping-123', JSON.stringify(line('echo ')));
  check('large body: size + integrity through the real streaming reader',
    line('big ') === `big status=200 n=${BIG} first=0 last=${(BIG - 1) & 0xff}`, JSON.stringify(line('big ')));
  check('404: perform succeeds, status surfaced',
    line('missing ') === 'missing status=404', JSON.stringify(line('missing ')));
  check('mid-stream drop: read returns an error (not a clean EOF)',
    line('drop ') === 'drop rc=-3', JSON.stringify(line('drop ')));
  check('reached done', lines[lines.length - 1] === 'done', JSON.stringify(lines[lines.length - 1]));
  check('no dangling HTTP transfers after halt', kernel._httpXfers.size === 0, String(kernel._httpXfers.size));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nhttp e2e: PASS' : `\nhttp e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
