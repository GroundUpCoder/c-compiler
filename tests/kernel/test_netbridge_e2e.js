#!/usr/bin/env node
// Tier 2.5 HTTP bridge end-to-end (ticket #349; todos/NETWORK.md Tier 2.5).
//
// Three legs, and the FIRST is the point (the HP pairing): a single C
// process drives OFF -> ON -> OFF -> ON-but-dead through live /etc/net
// writes, so "OFF changed nothing" is asserted IN THE SAME RUN as a
// positive control proving the ON path really reroutes. The bridge's
// /health request counter is the discriminator: after one OFF fetch, one
// bridged fetch, and another OFF fetch, the counter reads EXACTLY 1 —
// 0 would mean the reroute never engaged, 2+ would mean OFF leaked
// through the bridge. The live toggle is the watchPath choke (no reboot:
// the same process keeps fetching across every flip), synchronized by an
// ack-file protocol rather than a sleep: the test registers its own
// watchPath on /etc/net AFTER netFetchAttach, so same-batch setTimeout
// FIFO guarantees the wrapper re-resolved before the ack lands.
// ON-but-dead asserts the settled errno ruling — ENETUNREACH, promptly
// (a timing bound, not just the errno).
//
// Leg B units: the wrapper's 403->EACCES mapping (a browser-origin bridge
// refusal), and the bridge's HTTP surface a real browser needs — the
// CORS/PNA preflight, origin allowlist accept/refuse, upstream-failure
// 502 encapsulation.
//
// Leg C boots the REAL os/boot.js (the shipped embedder wiring): hush
// writes /etc/net, /bin/curl fetches through the bridge and then direct
// after flipping off, with the same counter pairing.
//
// Run: node tests/kernel/test_netbridge_e2e.js
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
const BRIDGE = path.join(ROOT, 'tools', 'net-bridge.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const INIT_C = `
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

__import int __http_open(const char *method, const char *url, const char *headers,
                         const void *body, int blen, int headers_ms, int idle_ms);
__import int __http_status(int fd, int *status_out, char *hdr, int hdrcap);
__import int __wait(const int *rfds, int nr, int ring, int timeout_ms);

static char obuf[8192];

static int wait_fd(int fd, int timeout_ms) {
    return __wait(&fd, 1, 0, timeout_ms);
}

/* WAIT-first whole-transfer fetch (the test_http_e2e shape). Returns body
   bytes or negative phase code; errno of the failing phase in *err_out. */
static int fetch_all(const char *url, int *status, int *err_out) {
    *err_out = 0;
    int fd = __http_open("GET", url, "", 0, 0, 0, 0);
    if (fd < 0) { *err_out = errno; return -1; }
    char hdr[4096];
    for (;;) {
        int hl = __http_status(fd, status, hdr, sizeof hdr);
        if (hl >= 0) break;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(fd, -1); continue; }
        *err_out = errno; close(fd); return -2;
    }
    int total = 0;
    for (;;) {
        char buf[4096];
        int n = (int)read(fd, buf, sizeof buf);
        if (n > 0) {
            if (total + n <= (int)sizeof obuf) memcpy(obuf + total, buf, n);
            total += n; continue;
        }
        if (n == 0) break;
        if (errno == EAGAIN || errno == EINTR) { wait_fd(fd, -1); continue; }
        *err_out = errno; close(fd); return -3;
    }
    close(fd);
    return total;
}

/* Rewrite /etc/net, then wait for the harness's ack FILE — a real marker,
   not a sleep: the embedder watch callback is a deferred setTimeout(0)
   coalescer with no C-visible completion, so the harness's own watch
   (registered AFTER netFetchAttach: same-batch FIFO means the wrapper
   already re-resolved) drops a content-keyed ack we poll for. Loud
   failure after 10s. */
static int set_net(const char *content, const char *ack) {
    FILE *f = fopen("/etc/net", "w");
    if (!f) { printf("setnet FAIL fopen: %s\\n", strerror(errno)); return -1; }
    fputs(content, f);
    fclose(f);
    for (int i = 0; i < 1000; i++) {
        if (access(ack, 0) == 0) return 0;
        usleep(10 * 1000);
    }
    printf("setnet FAIL: no ack %s\\n", ack);
    return -1;
}

static long now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, 0);
    return tv.tv_sec * 1000L + tv.tv_usec / 1000;
}

int main(void) {
    const char *target = getenv("TARGET");
    const char *bridge = getenv("BRIDGE");
    const char *dead = getenv("DEAD");
    char url[256], cfg[512];
    int status, n, err;

    /* phase 1: default OFF (no /etc/net at all) -> direct */
    snprintf(url, sizeof url, "%s/one", target);
    n = fetch_all(url, &status, &err);
    printf("one status=%d body=%.*s\\n", status, n < 0 ? 0 : n, obuf);

    /* phase 2: bridge ON -> the SAME process's next fetch transits it */
    snprintf(cfg, sizeof cfg, "bridge on\\nurl %s\\n", bridge);
    if (set_net(cfg, "/ack-on") != 0) return 1;
    snprintf(url, sizeof url, "%s/two", target);
    n = fetch_all(url, &status, &err);
    printf("two status=%d body=%.*s\\n", status, n < 0 ? 0 : n, obuf);

    /* phase 3: OFF again -> direct again */
    if (set_net("bridge off\\n", "/ack-off") != 0) return 1;
    snprintf(url, sizeof url, "%s/three", target);
    n = fetch_all(url, &status, &err);
    printf("three status=%d body=%.*s\\n", status, n < 0 ? 0 : n, obuf);

    /* phase 4: ON but the bridge is absent -> ENETUNREACH, promptly.
       The bound matters as much as the errno: a hang here would burn the
       30s headers deadline instead of failing at connect refusal. */
    snprintf(cfg, sizeof cfg, "bridge on\\nurl %s\\n", dead);
    if (set_net(cfg, "/ack-dead") != 0) return 1;
    snprintf(url, sizeof url, "%s/four", target);
    long t0 = now_ms();
    n = fetch_all(url, &status, &err);
    long dt = now_ms() - t0;
    printf("four rc=%d unreach=%d fast=%d\\n", n, err == ENETUNREACH, dt < 3000);

    printf("done\\n");
    return 0;
}
`;

// ---- servers ----
const targetPaths = [];
const target = http.createServer((req, res) => {
  targetPaths.push(req.url);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('T' + req.url);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function spawnBridge(port, extraArgs) {
  const b = cp.spawn('node', [BRIDGE, '--port=' + port, '--quiet'].concat(extraArgs || []),
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    b.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(b); });
    b.on('exit', (c) => reject(new Error('bridge exited ' + c + ' before listening')));
  });
}

async function freePort() {
  const s = http.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

// Raw one-shot GET (agent: false — a FRESH connection every time). fetch's
// pooled keep-alive socket dies while driveBoot's spawnSync blocks the
// event loop past the bridge server's keep-alive timeout, and the reuse
// then EPIPEs; the health probe must not depend on pool liveness.
function bridgeCount(base) {
  return new Promise((resolve, reject) => {
    http.get(base + '/health', { agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).requests); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---- compile ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-netbridge-'));
function compile(name, src) {
  const c = path.join(tmp, name + '.c');
  const wasm = path.join(tmp, name + '.wasm');
  fs.writeFileSync(c, src);
  cp.execFileSync('node', [COMPILER, c, '-o', wasm], { stdio: 'pipe' });
  return fs.readFileSync(wasm);
}

(async () => {
  const targetPort = await listen(target);
  const targetBase = `http://127.0.0.1:${targetPort}`;
  const bridgePort = await freePort();
  const bridgeBase = `http://127.0.0.1:${bridgePort}`;
  const bridgeProc = await spawnBridge(bridgePort);
  // The bridge child inherits this process's stdout pipe; a leftover child
  // wedges the suite runner's log capture (tail-until-EOF), so kill it on
  // EVERY exit path — the failure exits included.
  process.on('exit', () => { try { bridgeProc.kill(); } catch (e) {} });
  const deadPort = await freePort();          // just-closed port = deterministic refusal

  const watchdog = setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 120000);

  /* ================= Leg A: the paired OFF/ON/OFF/dead run ================ */

  const images = new Map([['/bin/init', compile('init', INIT_C)]]);
  const store = new BLOCK_FS.MemoryByteStore(8 << 20);
  const kfs = BLOCK_FS.createV4(store);
  kfs.mkdir('/etc', 0o755);

  let out = '';
  let haltResolve;
  const haltPromise = new Promise((res) => { haltResolve = res; });
  // The embedders' exact wiring: wrapper at construction, attach after.
  const netFetch = OS_COMMON.createNetFetch();
  const kernel = new K.Kernel({
    fs: kfs,
    fetch: netFetch,
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => images.get(p) || null,
    onOutput: (pid, fd, bytes) => { out += Buffer.from(bytes).toString(); },
    onHalt: (status) => haltResolve(status),
    log: () => {},
  });
  kernel.createTty({ output: () => {} });
  OS_COMMON.netFetchAttach(netFetch, kernel, kfs);

  // The ack watch — registered AFTER netFetchAttach so the wrapper's own
  // resolve runs first in the same settled batch (setTimeout FIFO).
  // Content-keyed (idempotent: a truncate settle and a close settle may
  // both fire it), so each distinct config maps to one ack file.
  kernel.watchPath('/etc/net', () => {
    const text = OS_COMMON.readFileText(kfs, '/etc/net') || '';
    let ack = null;
    if (/bridge on/.test(text) && text.includes(bridgeBase)) ack = '/ack-on';
    else if (/bridge off/.test(text)) ack = '/ack-off';
    else if (/bridge on/.test(text)) ack = '/ack-dead';
    if (ack) OS_COMMON.writeFile(kfs, ack, 'x');
  });

  await kernel.boot({ path: '/bin/init', argv: ['init'],
    envp: ['TARGET=' + targetBase, 'BRIDGE=' + bridgeBase,
           'DEAD=http://127.0.0.1:' + deadPort], cwd: '/' });
  const status = await haltPromise;

  check('leg A: init exited 0', status === 0, String(status) + '\noutput:\n' + out);
  const lines = out.trim().split('\n');
  const line = (prefix) => lines.find((l) => l.startsWith(prefix)) || '';

  check('OFF (default, no store): fetch succeeds direct',
    line('one ') === 'one status=200 body=T/one', JSON.stringify(line('one ')));
  check('ON (live /etc/net write, same process, no reboot): fetch succeeds through the bridge',
    line('two ') === 'two status=200 body=T/two', JSON.stringify(line('two ')));
  check('OFF again (live): fetch succeeds direct',
    line('three ') === 'three status=200 body=T/three', JSON.stringify(line('three ')));
  check('ON + bridge absent: ENETUNREACH before the status phase, under 3s',
    line('four ') === 'four rc=-2 unreach=1 fast=1', JSON.stringify(line('four ')));

  // THE PAIRING: the bridge saw EXACTLY the one ON-phase request. 0 =
  // the reroute never engaged (the (HP) trap: OFF-green proving nothing);
  // >1 = an OFF fetch leaked through the bridge.
  const countA = await bridgeCount(bridgeBase);
  check('positive control: bridge request counter reads exactly 1 (ON engaged, OFF stayed away)',
    countA === 1, 'requests=' + countA);
  check('target saw all three successful fetches',
    targetPaths.join(',') === '/one,/two,/three', targetPaths.join(','));

  /* ============ Leg B: wrapper errno mapping + bridge HTTP surface ========= */

  // 403 -> EACCES: a browser-origin refusal, simulated by a base fetch
  // that pins a disallowed Origin (Node fetch lets us set it; browsers
  // set it themselves).
  const evilBase = (url, init) => {
    init = Object.assign({}, init);
    init.headers = Object.assign({}, init.headers, { origin: 'https://evil.example' });
    return fetch(url, init);
  };
  const evilFetch = OS_COMMON.createNetFetch(evilBase);
  evilFetch._state.on = true;
  evilFetch._state.url = bridgeBase;
  const eaccess = await evilFetch(targetBase + '/never-taken', {}).then(
    () => 'resolved', (e) => e.errno + ':' + /HTTP 403/.test(e.message));
  check('wrapper maps a bridge origin-refusal (403) to EACCES', eaccess === 'EACCES:true', eaccess);
  check('the refused fetch never reached the target', !targetPaths.includes('/never-taken'),
    targetPaths.join(','));

  // ENETUNREACH tagging is the wrapper's own (not a kernel fabrication).
  const deadFetch = OS_COMMON.createNetFetch();
  deadFetch._state.on = true;
  deadFetch._state.url = 'http://127.0.0.1:' + deadPort;
  const unreach = await deadFetch(targetBase + '/x', {}).then(
    () => 'resolved', (e) => e.errno);
  check('wrapper tags an unreachable bridge ENETUNREACH', unreach === 'ENETUNREACH', unreach);

  // The browser-facing surface: CORS/PNA preflight, allowlist, 502.
  let r = await fetch(bridgeBase + '/fetch', { method: 'OPTIONS', headers: {
    origin: 'https://groundupcoder.com',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'x-guc-url, x-guc-method, x-guc-headers',
    'access-control-request-private-network': 'true',
  } });
  check('preflight: 204 + PNA allow + requested headers echoed',
    r.status === 204 && r.headers.get('access-control-allow-private-network') === 'true'
      && /x-guc-url/.test(r.headers.get('access-control-allow-headers') || ''),
    r.status + ' pna=' + r.headers.get('access-control-allow-private-network'));

  r = await fetch(bridgeBase + '/fetch', { method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  check('preflight from a disallowed origin: 403', r.status === 403, r.status);

  r = await fetch(bridgeBase + '/fetch', { method: 'POST', headers: {
    origin: 'https://groundupcoder.com',
    'x-guc-url': targetBase + '/allowed', 'x-guc-method': 'GET', 'x-guc-headers': '[]',
  } });
  check('allowed origin proxies: encapsulated 200 + CORS origin echo',
    r.status === 200 && r.headers.get('x-guc-status') === '200'
      && r.headers.get('access-control-allow-origin') === 'https://groundupcoder.com'
      && (await r.text()) === 'T/allowed',
    r.status + '/' + r.headers.get('x-guc-status'));

  r = await fetch(bridgeBase + '/fetch', { method: 'POST', headers: {
    'x-guc-url': 'http://127.0.0.1:' + deadPort + '/x',
  } });
  check('upstream connect failure: bridge-level 502, no x-guc-status',
    r.status === 502 && r.headers.get('x-guc-status') === null, r.status);

  r = await fetch(bridgeBase + '/fetch', { method: 'POST', headers: { 'x-guc-url': 'ftp://x/y' } });
  check('non-http target URL: 400', r.status === 400, r.status);

  /* ============== Leg C: the shipped boot.js wiring (IMG boot) ============= */

  // The watchdog cannot protect a spawnSync block (timers don't run), and
  // it would misfire the moment the loop resumes after a long in-boot
  // bake — driveBoot's own 300s timeout owns this leg.
  clearTimeout(watchdog);

  // Both curls aim at the bridge's own /health — the ONE server that stays
  // live while spawnSync blocks this process's event loop (a target hosted
  // HERE would deadlock: the in-OS fetch waits on a server whose accept
  // loop is frozen until the boot returns). The discriminator is still the
  // /fetch counter: the bridged curl transits POST /fetch (+1) on its way
  // to /health, the direct curl hits /health without touching it.
  const { image } = freshImage('os-netbridge-');
  const countBefore = await bridgeCount(bridgeBase);
  const boot = driveBoot([
    `printf 'bridge on\\nurl ${bridgeBase}\\n' > /etc/net`,
    `curl -s ${bridgeBase}/health`, 'echo',
    `printf 'bridge off\\nurl ${bridgeBase}\\n' > /etc/net`,
    `curl -s ${bridgeBase}/health`, 'echo',
    // The Network applet's Test Bridge round-trip needs a RUNNING bridge,
    // which this test owns — ctlpanel's own e2e keeps to store-writes. The
    // verdict lands as the status STATIC's exact text (agent needles are
    // exact-match), so the label wait IS the assertion; a timeout is a
    // loud driveBoot failure.
    'ctlpanel Network &',
    'wmctl wait win "Network Properties" 15000',
    'wmctl click "Test Bridge"',
    'wmctl wait label "Result: bridge answered: HTTP 200" 8000',
    'echo NETTEST-OK',
    'exit',
  ], { image });
  const countAfter = await bridgeCount(bridgeBase);
  const healthLines = boot.stdout.split('\n').filter((l) => l.includes('guc-net-bridge'));
  check('leg C: boot.js honours the store — both curls returned the health JSON',
    healthLines.length === 2, JSON.stringify(boot.stdout.slice(-300)));
  check('leg C pairing: exactly one /fetch transit from the real OS (bridged yes, direct no)',
    countAfter - countBefore === 1, countBefore + ' -> ' + countAfter);
  check('leg C: the applet Test Bridge round-trip reported HTTP 200',
    boot.stdout.includes('NETTEST-OK'), JSON.stringify(boot.stdout.slice(-200)));

  bridgeProc.kill();
  target.close();

  console.log(failures ? 'FAILURES: ' + failures : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
