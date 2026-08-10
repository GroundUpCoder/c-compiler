#!/usr/bin/env node
// HTTP transport end-to-end (todos/0172; fd-shaped since todos/0417): a real
// C process in a worker_thread drives the FULL stack — C extern __http_* +
// read()/close()/__wait -> host.js env imports -> KernelClient RPC -> kernel
// 0x06xx/0x04xx -> Node's global fetch -> a local HTTP server. Proves the
// fd-shaped primitive end to end: WAIT-first streamed GET, POST echo, a
// large multi-chunk body (backpressure through undici's streaming reader),
// 404, mid-stream drop (EOF vs error split), TWO transfers multiplexed
// through ONE __wait, a transfer beside a PIPE in one __wait, the
// statusConsumed park (a consumed status BLOCKS until the first body byte —
// no spin), both kernel deadlines as ETIMEDOUT (distinguishable from a
// connect error), and close(2) aborting the fetch server-visibly. No
// external network — the server is localhost, torn down at the end.
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
#include <errno.h>
#include <unistd.h>

/* The kernel HTTP primitive (todos/0172, fd-shaped todos/0417), surfaced by
   host.js as env imports and declared __import by the compiler prelude. The
   libcurl veneer (0173) wraps these; here we drive them directly, with the
   WAIT-first consumer contract: park on the fd, consume the status once,
   read until EAGAIN, park again. */
__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);
__import int __http_error(int fd, char *buf, int cap);   /* #392: error-TEXT peek */
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

static char obuf[600000];   /* static: the wasm stack is tiny */
static char g_hdr[8192];    /* last fetch's header blob (#359 legs) */

static int wait_fd(int fd, int timeout_ms) {
    return __wait(&fd, 1, 0, timeout_ms);
}

/* WAIT-first whole-transfer fetch. Returns total body bytes (>=0) or a
   negative code: -1 open, -2 status phase, -3 body phase. Fills *status,
   copies the body into obuf, and leaves the failing errno in *err_out. */
static int fetch_all(const char *method, const char *url, const char *headers,
                     const void *body, int blen, int *status,
                     int hdrs_ms, int idle_ms, int *err_out) {
    *err_out = 0;
    int fd = __http_open(method, url, headers, body, blen, hdrs_ms, idle_ms);
    if (fd < 0) { *err_out = errno; return -1; }
    char hdr[8192];
    for (;;) {
        int hl = __http_status(fd, status, hdr, sizeof hdr - 1);
        if (hl >= 0) {
            int cl = hl < (int)sizeof hdr - 1 ? hl : (int)sizeof hdr - 1;
            memcpy(g_hdr, hdr, cl);
            g_hdr[cl] = 0;
            break;
        }
        if (errno == EAGAIN || errno == EINTR) { wait_fd(fd, -1); continue; }
        *err_out = errno; close(fd); return -2;
    }
    int total = 0;
    for (;;) {
        char buf[8192];
        int n = (int)read(fd, buf, sizeof buf);
        if (n > 0) {
            if (total + n <= (int)sizeof obuf) memcpy(obuf + total, buf, n);
            total += n;
            continue;
        }
        if (n == 0) break;                       /* clean EOF */
        if (errno == EAGAIN || errno == EINTR) { wait_fd(fd, -1); continue; }
        *err_out = errno; close(fd); return -3;
    }
    close(fd);
    return total;
}

/* One multiplexed transfer's state for the mux leg. */
struct xs { int fd, status, total, got_status, done, failed; };

/* Advance one transfer as far as it will go without blocking — the
   try-consume-until-EAGAIN discipline (__wait does not name the ready fd). */
static void xs_advance(struct xs *x) {
    if (x->done) return;
    if (!x->got_status) {
        char hdr[512];
        int hl = __http_status(x->fd, &x->status, hdr, sizeof hdr);
        if (hl < 0) {
            if (errno == EAGAIN || errno == EINTR) return;
            x->done = 1; x->failed = 1; close(x->fd); return;
        }
        x->got_status = 1;
    }
    for (;;) {
        char buf[4096];
        int n = (int)read(x->fd, buf, sizeof buf);
        if (n > 0) { x->total += n; continue; }
        if (n == 0) { x->done = 1; close(x->fd); return; }
        if (errno == EAGAIN || errno == EINTR) return;
        x->done = 1; x->failed = 1; close(x->fd); return;
    }
}

int main(void) {
    const char *base = getenv("BASE");
    const char *refused = getenv("REFUSED");
    char url[256], url2[256];
    int status, n, err;

    snprintf(url, sizeof url, "%s/hello", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    printf("hello status=%d n=%d body=%.*s\\n", status, n, n < 0 ? 0 : n, obuf);

    /* #359: the synthetic final-url line is PREPENDED (first line of the
       blob) and, without a redirect, equals the request url. */
    {
        char *nl = strchr(g_hdr, '\\n');
        if (nl) *nl = 0;
        printf("plainfinal first=%s\\n", g_hdr);
    }

    snprintf(url, sizeof url, "%s/echo", base);
    const char *payload = "ping-123";
    n = fetch_all("POST", url, "content-type: text/plain\\n", payload, (int)strlen(payload), &status, 0, 0, &err);
    printf("echo status=%d body=%.*s\\n", status, n < 0 ? 0 : n, obuf);

    snprintf(url, sizeof url, "%s/big", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    printf("big status=%d n=%d first=%d last=%d\\n", status, n,
           n > 0 ? (unsigned char)obuf[0] : -1,
           n > 0 ? (unsigned char)obuf[n - 1] : -1);

    snprintf(url, sizeof url, "%s/missing", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    printf("missing status=%d\\n", status);

    snprintf(url, sizeof url, "%s/drop", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    printf("drop rc=%d eio=%d\\n", n, err == EIO);

    /* #359: a redirecting URL reports the POST-redirect final url. */
    snprintf(url, sizeof url, "%s/redir", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    {
        char *nl = strchr(g_hdr, '\\n');
        if (nl) *nl = 0;
        printf("redir status=%d n=%d first=%s\\n", status, n, g_hdr);
    }

    /* #359: a server-sent x-guc-final-url is FILTERED — exactly one line
       with that name survives, and it is the transport's own. */
    snprintf(url, sizeof url, "%s/spoof", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    {
        int cnt = 0;
        const char *sp = g_hdr;
        while ((sp = strstr(sp, "x-guc-final-url:")) != 0) { cnt++; sp++; }
        char *nl = strchr(g_hdr, '\\n');
        if (nl) *nl = 0;
        printf("spoof count=%d first=%s\\n", cnt, g_hdr);
    }

    /* TWO transfers through ONE __wait — the 0417 flagship. The slow
       response arrives ~400ms after the fast one; a bounded round count
       proves the loop waits instead of spinning. */
    snprintf(url, sizeof url, "%s/slow", base);
    snprintf(url2, sizeof url2, "%s/fast", base);
    struct xs slow, fast;
    memset(&slow, 0, sizeof slow); memset(&fast, 0, sizeof fast);
    slow.fd = __http_open("GET", url, "", 0, 0, 0, 0);
    fast.fd = __http_open("GET", url2, "", 0, 0, 0, 0);
    int first_done = 0, rounds = 0;
    while ((!slow.done || !fast.done) && rounds < 100) {
        int fds[2]; int nf = 0;
        if (!fast.done) fds[nf++] = fast.fd;
        if (!slow.done) fds[nf++] = slow.fd;
        __wait(fds, nf, 0, 10000);
        rounds++;
        xs_advance(&fast);
        xs_advance(&slow);
        if (!first_done && fast.done) first_done = 1;
        if (!first_done && slow.done) first_done = 2;
    }
    printf("mux first=%d fast=%d/%d slow=%d/%d bounded=%d ok=%d\\n",
           first_done, fast.status, fast.total, slow.status, slow.total,
           rounds < 100, !fast.failed && !slow.failed);

    /* A transfer beside a PIPE in one __wait: the pipe's data answers the
       mixed wait promptly while the transfer is still pending. */
    snprintf(url, sizeof url, "%s/slow", base);
    int tfd = __http_open("GET", url, "", 0, 0, 0, 0);
    int pfds[2];
    if (pipe(pfds) != 0) { printf("pipewait FAIL pipe()\\n"); return 1; }
    if (write(pfds[1], "x", 1) != 1) { printf("pipewait FAIL write\\n"); return 1; }
    int wfds[2]; wfds[0] = tfd; wfds[1] = pfds[0];
    int why = __wait(wfds, 2, 0, 5000);
    char pc = 0;
    int pn = (int)read(pfds[0], &pc, 1);
    printf("pipewait why=%d pn=%d pc=%c\\n", why, pn, pc ? pc : '?');
    close(pfds[0]); close(pfds[1]);
    /* drain the transfer so it tears down cleanly */
    {
        struct xs t; memset(&t, 0, sizeof t); t.fd = tfd;
        int r2 = 0;
        while (!t.done && r2 < 100) { wait_fd(tfd, 10000); xs_advance(&t); r2++; }
    }

    /* statusConsumed: consume the status, then WAIT for the first body
       byte with a 250ms cap — the wait must PARK and time out (why 0),
       not spin on a permanently-readable fd. The byte lands ~700ms in. */
    snprintf(url, sizeof url, "%s/latebody", base);
    int lfd = __http_open("GET", url, "", 0, 0, 0, 0);
    for (;;) {
        char hdr[256];
        if (__http_status(lfd, &status, hdr, sizeof hdr) >= 0) break;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(lfd, -1); continue; }
        break;
    }
    int lwhy = wait_fd(lfd, 250);          /* must be 0: parked, timed out */
    int ltotal = 0;
    for (;;) {
        char buf[256];
        int ln = (int)read(lfd, buf, sizeof buf);
        if (ln > 0) { ltotal += ln; continue; }
        if (ln == 0) break;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(lfd, -1); continue; }
        ltotal = -1; break;
    }
    close(lfd);
    printf("late why=%d n=%d\\n", lwhy, ltotal);

    /* headers deadline: the server never answers -> ETIMEDOUT, and the
       process carries on. */
    snprintf(url, sizeof url, "%s/never", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 300, 0, &err);
    printf("never rc=%d etimedout=%d\\n", n, err == ETIMEDOUT);

    /* idle deadline: a stalled body times out ... */
    snprintf(url, sizeof url, "%s/stall", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 300, &err);
    printf("stall rc=%d etimedout=%d\\n", n, err == ETIMEDOUT);

    /* ... and a slow-but-live stream (a byte every ~100ms) does not. */
    snprintf(url, sizeof url, "%s/slowfeed", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 1000, &err);
    printf("slowfeed status=%d n=%d\\n", status, n);

    /* a connect error is NOT ETIMEDOUT — the codes stay distinguishable */
    snprintf(url, sizeof url, "%s/x", refused);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    printf("refused rc=%d etimedout=%d\\n", n, err == ETIMEDOUT);

    /* #392: the error-TEXT peek. Healthy = 0 bytes; after the failure the
       real diagnostic (Node's cause chain: connect ECONNREFUSED host:port)
       crosses to C, NUL-terminated. The healthy peek runs on a transfer
       that CANNOT have settled — /never accepts the connect and sends
       nothing, and no deadline is armed — because peeking an fd that is
       EXPECTED to fail races the connect rejection (a refused localhost
       port can land its error before the peek: a measured 5% flake).
       Peek the failed text BEFORE close — the last release frees the
       transfer, text included. */
    snprintf(url, sizeof url, "%s/never", base);
    int hfd = __http_open("GET", url, "", 0, 0, 0, 0);
    char etxt[512];
    etxt[0] = 'Z';                               /* prove the healthy peek writes the NUL */
    int epre = __http_error(hfd, etxt, (int)sizeof etxt);
    int eprenul = etxt[0] == 0;
    close(hfd);                                  /* aborts the pending fetch */
    snprintf(url, sizeof url, "%s/x", refused);
    int efd = __http_open("GET", url, "", 0, 0, 0, 0);
    for (;;) {
        char hdr[256];
        if (__http_status(efd, &status, hdr, sizeof hdr) >= 0) break;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(efd, -1); continue; }
        break;                                   /* the error landed */
    }
    int elen = __http_error(efd, etxt, (int)sizeof etxt);
    close(efd);
    printf("errtext pre=%d prenul=%d has=%d refused=%d nul=%d\\n",
           epre, eprenul, elen > 0,
           strstr(etxt, "ECONNREFUSED") != 0,
           elen > 0 && elen < (int)sizeof etxt && etxt[elen] == 0);

    /* close(2) aborts the fetch: start an endless stream, read one chunk,
       close, then ask the server whether it saw the connection die. */
    snprintf(url, sizeof url, "%s/bigabort", base);
    int afd = __http_open("GET", url, "", 0, 0, 0, 0);
    for (;;) {
        char hdr[256];
        if (__http_status(afd, &status, hdr, sizeof hdr) >= 0) break;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(afd, -1); continue; }
        break;
    }
    for (;;) {
        char buf[4096];
        int an = (int)read(afd, buf, sizeof buf);
        if (an > 0) break;
        if (an < 0 && (errno == EAGAIN || errno == EINTR)) { wait_fd(afd, -1); continue; }
        break;
    }
    close(afd);
    usleep(400000);                        /* let the abort reach the server */
    snprintf(url, sizeof url, "%s/abortcheck", base);
    n = fetch_all("GET", url, "", 0, 0, &status, 0, 0, &err);
    printf("abort seen=%.*s\\n", n < 0 ? 0 : n, obuf);

    printf("done\\n");
    return 0;
}
`;

// ---- local HTTP server ----
let bigabortAborted = false;
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
  if (u === '/redir') { res.writeHead(302, { location: '/landed' }); res.end(); return; }
  if (u === '/landed') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed.'); return; }
  if (u === '/spoof') {   // #359: an upstream lying with the synthetic name
    res.writeHead(200, { 'x-guc-final-url': 'http://spoofed.example/evil', 'content-type': 'text/plain' });
    res.end('s');
    return;
  }
  if (u === '/drop') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('half');
    setTimeout(() => req.socket.destroy(), 10);  // kill mid-stream
    return;
  }
  if (u === '/fast') { res.writeHead(200); res.end('F'); return; }
  if (u === '/slow') {
    setTimeout(() => { res.writeHead(200); res.end('SLOW-BODY'); }, 400);
    return;
  }
  if (u === '/latebody') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.flushHeaders();                          // headers now, body byte at 700ms
    setTimeout(() => res.end('LATE'), 700);
    return;
  }
  if (u === '/never') { return; }                // headers never sent
  if (u === '/stall') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial-');                       // then never finish
    return;
  }
  if (u === '/slowfeed') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let i = 0;
    const t = setInterval(() => {
      res.write('y');
      if (++i >= 4) { clearInterval(t); res.end(); }
    }, 100);
    return;
  }
  if (u === '/bigabort') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const t = setInterval(() => res.write(Buffer.alloc(8 * 1024, 7)), 50);
    res.on('close', () => {
      clearInterval(t);
      if (!res.writableEnded) bigabortAborted = true;
    });
    return;
  }
  if (u === '/abortcheck') { res.writeHead(200); res.end(bigabortAborted ? 'yes' : 'no'); return; }
  res.writeHead(500); res.end();
});
const sockets = new Set();
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

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
  // A port that just closed = deterministic connection-refused target.
  const refusedPort = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const refused = `http://127.0.0.1:${refusedPort}`;

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
    envp: ['BASE=' + base, 'REFUSED=' + refused], cwd: '/' });
  const status = await haltPromise;
  clearTimeout(watchdog);
  sockets.forEach((s) => s.destroy());          // /never keeps a socket open
  server.close();

  check('init exited 0', status === 0, String(status) + '\noutput:\n' + out);
  const lines = out.trim().split('\n');
  const line = (prefix) => lines.find((l) => l.startsWith(prefix)) || '';

  check('GET streams status + reassembled body (WAIT-first)',
    line('hello ') === 'hello status=200 n=13 body=Hello, world!', JSON.stringify(line('hello ')));
  check('POST body echoed back',
    line('echo ') === 'echo status=200 body=ping-123', JSON.stringify(line('echo ')));
  check('large body: size + integrity through the real streaming reader',
    line('big ') === `big status=200 n=${BIG} first=0 last=${(BIG - 1) & 0xff}`, JSON.stringify(line('big ')));
  check('404: perform succeeds, status surfaced',
    line('missing ') === 'missing status=404', JSON.stringify(line('missing ')));
  check('mid-stream drop: read errors with EIO (not EOF, not a timeout)',
    line('drop ') === 'drop rc=-3 eio=1', JSON.stringify(line('drop ')));
  check('#359 non-redirect: synthetic final-url line is FIRST and equals the request url',
    line('plainfinal ') === `plainfinal first=x-guc-final-url: ${base}/hello`,
    JSON.stringify(line('plainfinal ')));
  check('#359 redirect: final url is the POST-redirect url, body from the target',
    line('redir ') === `redir status=200 n=7 first=x-guc-final-url: ${base}/landed`,
    JSON.stringify(line('redir ')));
  check('#359 spoof: a server-sent x-guc-final-url is filtered — one line, ours',
    line('spoof ') === `spoof count=1 first=x-guc-final-url: ${base}/spoof`,
    JSON.stringify(line('spoof ')));
  check('TWO transfers through ONE __wait: fast completes first, both intact, bounded rounds',
    line('mux ') === `mux first=1 fast=200/1 slow=200/9 bounded=1 ok=1`, JSON.stringify(line('mux ')));
  check('a pipe answers a mixed transfer+pipe __wait promptly',
    line('pipewait ') === 'pipewait why=1 pn=1 pc=x', JSON.stringify(line('pipewait ')));
  check('statusConsumed: post-status wait PARKS for the body (why=0 timeout, then the byte)',
    line('late ') === 'late why=0 n=4', JSON.stringify(line('late ')));
  check('headers deadline: no-answer server is ETIMEDOUT, process continues',
    line('never ') === 'never rc=-2 etimedout=1', JSON.stringify(line('never ')));
  check('idle deadline: stalled body is ETIMEDOUT',
    line('stall ') === 'stall rc=-3 etimedout=1', JSON.stringify(line('stall ')));
  check('idle deadline: slow-but-live stream survives',
    line('slowfeed ') === 'slowfeed status=200 n=4', JSON.stringify(line('slowfeed ')));
  check('connect error stays distinguishable from a timeout',
    /^refused rc=-2 etimedout=0$/.test(line('refused ')), JSON.stringify(line('refused ')));
  check('#392 __http_error: empty while healthy, the real diagnostic after (cause chain, NUL-terminated)',
    line('errtext ') === 'errtext pre=0 prenul=1 has=1 refused=1 nul=1',
    JSON.stringify(line('errtext ')));
  check('close(2) aborts the fetch — the server saw the connection die',
    line('abort ') === 'abort seen=yes', JSON.stringify(line('abort ')));
  check('reached done', lines[lines.length - 1] === 'done', JSON.stringify(lines[lines.length - 1]));
  let danglingHttp = 0;
  kernel._ofds.forEach((o) => { if (o.kind === 'http') danglingHttp++; });
  check('no dangling HTTP transfers after halt', danglingHttp === 0, String(danglingHttp));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nhttp e2e: PASS' : `\nhttp e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
