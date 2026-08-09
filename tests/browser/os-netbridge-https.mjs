// The net bridge from a PUBLIC https origin (ticket #362) — the missing
// coverage that let the shipped deploy break silently: every prior bridge
// test drove 127.0.0.1, the one origin class where the mixed-origin
// https -> http://127.0.0.1 hop needs no browser permission. On the real
// deploy (https://groundupcoder.com) Chrome 142+ Local Network Access
// gates that hop behind a user permission grant, and a worker-context
// fetch is silently denied without it — zero preflights, zero /fetch,
// exactly the #362 prod measurement.
//
// The origin is simulated EXACTLY: an https page on a fake public host
// (--host-resolver-rules maps prod.test to loopback, and
// --ip-address-space-overrides marks that endpoint PUBLIC, so Chromium's
// address-space classifier sees public->loopback precisely as prod does).
// The wrapper under test is the REAL os/os-common.js createNetFetch,
// loaded into a dedicated worker on that origin (the kernel worker's
// context class); the bridge is the REAL tools/net-bridge.js.
//
// Leg 1 (the platform block, pinned): no permission grant -> the wrapper
// rejects ENETUNREACH with a message naming the local-network-access
// permission, and the bridge's request counter proves NOTHING reached the
// wire. If a Chromium bump changes this story, this leg fails loudly and
// the honest-reporting product surface (#362 ctlpanel verdict) must be
// revisited.
//
// Leg 2 (the capability): with the local-network-access permission
// granted (what a real user's one-time "Allow" click produces), the SAME
// wrapper + bridge complete the hop — CORS preflight included (the
// x-guc-* request headers force OPTIONS), response decapsulated
// (x-guc-status / body / #359 post-redirect final url readable
// cross-origin, i.e. access-control-expose-headers is honoured for real).
// This is the leg that catches a bridge CORS/preflight regression, which
// no same-origin test can see.
//
// Usage: node os-netbridge-https.mjs
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, makeCheck, ROOT } from './lib/os-harness.mjs';

const { check, state } = makeCheck();

function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
function spawnBridge(port, allowOrigin) {
  const b = spawn(process.execPath,
    [path.join(ROOT, 'tools', 'net-bridge.js'), '--port=' + port,
     '--allow-origin=' + allowOrigin, '--quiet'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    b.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(b); });
    b.on('exit', (c) => reject(new Error('bridge exited ' + c + ' before listening')));
  });
}
async function bridgeCount(base) {
  const r = await fetch(base + '/health');
  return (await r.json()).requests;
}

// ---- the fake public https origin: self-signed cert, throwaway per run ----
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbh-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'crt.pem'),
  '-days', '2', '-nodes', '-subj', '/CN=prod.test',
  '-addext', 'subjectAltName=DNS:prod.test'], { stdio: 'ignore' });

// The worker runs the REAL wrapper on the https origin and reports the
// outcome shape the kernel would see (status/url/headers/body or errno).
const WORKER_JS = `
importScripts('/os-common.js');
onmessage = async (e) => {
  const nf = OS_COMMON.createNetFetch();
  nf._state.on = true;
  nf._state.url = e.data.bridge;
  try {
    const r = await nf(e.data.target, {});
    const hdrs = {};
    r.headers.forEach((v, k) => { hdrs[k] = v; });
    const body = r.body ? await new Response(r.body).text() : '';
    postMessage({ ok: true, status: r.status, url: r.url, hdrs, body });
  } catch (err) {
    postMessage({ ok: false, errno: err.errno || null, message: String(err.message || err) });
  }
};
`;
const PAGE_HTML = `<!doctype html><script>
window.probe = (bridge, target) => new Promise((resolve) => {
  const w = new Worker('/probe-worker.js');
  w.onmessage = (m) => { w.terminate(); resolve(m.data); };
  w.postMessage({ bridge, target });
});
</script>bridge-https harness`;

const httpsPort = await freePort();
const bridgePort = await freePort();
const targetPort = await freePort();
const ORIGIN = 'https://prod.test:' + httpsPort;
const bridgeBase = 'http://127.0.0.1:' + bridgePort;
const targetBase = 'http://127.0.0.1:' + targetPort;

// The upstream "internet" the bridge fetches server-side (no CORS there —
// the bridge process is Node). /redir exercises the #359 final-url axis.
const target = http.createServer((req, res) => {
  if (req.url === '/redir') { res.writeHead(302, { location: '/landed' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
  res.end('T' + req.url);
});
await new Promise((ok) => target.listen(targetPort, '127.0.0.1', ok));

const web = https.createServer({
  key: fs.readFileSync(path.join(certDir, 'key.pem')),
  cert: fs.readFileSync(path.join(certDir, 'crt.pem')),
}, (req, res) => {
  if (req.url === '/os-common.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(fs.readFileSync(path.join(ROOT, 'os', 'os-common.js')));
  } else if (req.url === '/probe-worker.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(WORKER_JS);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE_HTML);
  }
});
await new Promise((ok) => web.listen(httpsPort, '127.0.0.1', ok));

const bridge = await spawnBridge(bridgePort, ORIGIN);
let browser = null;
try {
  browser = await launchBrowser([
    '--host-resolver-rules=MAP prod.test 127.0.0.1',
    '--ignore-certificate-errors',
    // The load-bearing flag: mark the https endpoint PUBLIC so the page's
    // address space matches the shipped deploy's. Without it both ends are
    // loopback and LNA never engages (the pre-#362 blind spot).
    '--ip-address-space-overrides=127.0.0.1:' + httpsPort + '=public',
  ]);

  async function runProbe(grant, targetUrl) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    if (grant) await ctx.grantPermissions(['local-network-access'], { origin: ORIGIN });
    try {
      const page = await ctx.newPage();
      await page.goto(ORIGIN + '/');
      return await page.evaluate(
        (a) => window.probe(a.bridge, a.target),
        { bridge: bridgeBase, target: targetUrl });
    } finally { await ctx.close(); }
  }

  /* ---- leg 1: no grant — the platform blocks the hop before the wire ---- */
  const before = await bridgeCount(bridgeBase);
  const blocked = await runProbe(false, targetBase + '/hello');
  check('no grant: wrapper rejects', blocked.ok === false, JSON.stringify(blocked));
  check('no grant: labelled ENETUNREACH (the shipped errno)',
    blocked.errno === 'ENETUNREACH', blocked.errno);
  check('no grant: the message names the local-network-access permission',
    /local-network-access permission/.test(blocked.message || ''), blocked.message);
  const afterBlocked = await bridgeCount(bridgeBase);
  check('no grant: ZERO requests reached the bridge (the #362 prod measurement)',
    afterBlocked === before, before + ' -> ' + afterBlocked);

  /* ---- leg 2: granted — the full hop through the real bridge ---- */
  const ok1 = await runProbe(true, targetBase + '/hello');
  check('granted: wrapper resolves through the bridge', ok1.ok === true, JSON.stringify(ok1));
  check('granted: upstream status + body decapsulated',
    ok1.status === 200 && ok1.body === 'T/hello', ok1.status + ' ' + JSON.stringify(ok1.body));
  check('granted: upstream headers visible through x-guc-headers',
    ok1.hdrs && ok1.hdrs['x-upstream'] === 'yes', JSON.stringify(ok1.hdrs));
  const afterOk = await bridgeCount(bridgeBase);
  check('granted: exactly one /fetch transit', afterOk === afterBlocked + 1,
    afterBlocked + ' -> ' + afterOk);

  // #359 from a REAL https origin: the final url rides a CORS-exposed
  // response header — readable only if access-control-expose-headers is
  // honoured on this genuinely cross-origin hop.
  const ok2 = await runProbe(true, targetBase + '/redir');
  check('granted: #359 post-redirect final url exposed cross-origin',
    ok2.ok === true && ok2.url === targetBase + '/landed' && ok2.body === 'T/landed',
    JSON.stringify(ok2));
} catch (e) {
  check('harness', false, (e && e.stack) || String(e));
} finally {
  if (browser) await browser.close();
  bridge.kill();
  target.close();
  web.close();
  fs.rmSync(certDir, { recursive: true, force: true });
}
console.log(state.failures ? 'FAILURES: ' + state.failures : 'ALL PASSED');
process.exit(state.failures ? 1 : 0);
