#!/usr/bin/env node
// The host ticket bridge end-to-end (ticket #451; todos/NETWORK.md "The
// ticket bridge").
//
// The point under test is the ISOLATION INVARIANT: the in-OS client
// (os/file-gucos-ticket.c) and the host bridge (tools/ticket-bridge.js)
// know exactly one fact about the outside world — "the host MAY provide a
// command named `file-gucos-ticket` on PATH" — so every leg here runs
// against a FAKE handler this test writes onto a private PATH dir
// (positive control: it captures its stdin to a file the test inspects),
// or with that handler deliberately absent (the ENOENT leg). No real
// ticket tooling is consulted, and none may exist on this machine.
//
// Leg A boots the REAL client source per scenario (fake-worker kernel, the
// test_netbridge_e2e leg-A shape) and drives it through BOTH net modes:
// direct (no /etc/net) and through a live tools/net-bridge.js (/etc/net
// `bridge on`) — the bridge-on leg is what proves the client rides the
// ordinary kernel HTTP seam with zero special-casing (the net-bridge
// /health counter is the transit proof). Negative legs: handler absent
// (501 -> "no ticket handler installed"), handler nonzero exit (relayed as
// HANDLER failure, distinguishable from bridge failure), handler timeout
// (bridge 502), bridge unreachable, oversize body (413), usage.
//
// Leg B drives the bridge's browser-facing HTTP surface Node-side:
// CORS/PNA preflight, origin allowlist accept/refuse (readable 403), 413
// cap, 400 non-JSON, x-guc-exit encapsulation + expose-headers.
//
// Leg C boots the real baked image (driveBoot) and runs the SHIPPED
// /usr/bin/file-gucos-ticket from hush — the image.json registration
// proof, with a stdin body (`--body -`).
//
// Run: node tests/kernel/test_ticketbridge_e2e.js
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
const CLIENT_C = path.join(ROOT, 'os', 'file-gucos-ticket.c');
const TICKET_BRIDGE = path.join(ROOT, 'tools', 'ticket-bridge.js');
const NET_BRIDGE = path.join(ROOT, 'tools', 'net-bridge.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);
const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const { driveBoot } = require('./lib/drive.js');
const { mkdtempOwned } = require('../lib/harness-temp.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// ---- the fake handler (the ONE thing a real host would add) ----
//
// mkdtempOwned, not a bare mkdtempSync (review finding 3): it registers the
// dir for process-lifetime cleanup (normal exit, uncaught throw, SIGINT/
// SIGTERM) AND pid-tags the name so tests/lib/harness-leaks.js's startup
// reaper can collect it after a SIGKILL, which runs no handler by definition.
// The `os-` prefix is load-bearing for that second half — the reaper's
// TEMP_DIR_RE is /^os-.*-(\d+)-[A-Za-z0-9]{6}$/, so a `kernel-`-prefixed dir
// is tracked but never reaped.
const tmp = mkdtempOwned('os-ticketbridge-');
const fakeBin = path.join(tmp, 'fakebin');
fs.mkdirSync(fakeBin);
const handlerPath = path.join(fakeBin, 'file-gucos-ticket');
const capturePath = path.join(tmp, 'capture.json');
const CANNED = '{"ok":true,"ref":"guc#42"}';

// The bridge child's PATH is THIS DIRECTORY AND NOTHING ELSE — the
// inherited PATH is deliberately NOT appended. That is load-bearing, not
// tidiness: a real `file-gucos-ticket` may well be installed on the
// machine running this suite (one was, when this test was written), and
// with the ambient PATH in the search list the "handler absent" leg
// silently FALLS THROUGH to it — so the leg stops testing ENOENT, and
// worse, the suite starts invoking real ticket tooling with test payloads.
// A private single-entry PATH makes both impossible by construction, and
// makes every leg's verdict independent of what this host has installed.
// Consequence the fake scripts must respect: no PATH lookup inside them,
// so `cat`/`sleep` are spelled absolutely.
const HANDLER_PATH_ENV = fakeBin;

// The bridge's handler timeout for this run. Small enough that the timeout
// leg costs ~1.5s instead of 30s, and 6.7x below the fake handler's 10s
// sleep so A5's deadline assertion has room on both sides.
const HANDLER_TIMEOUT_MS = 1500;

function setHandler(mode) {
  // Rewritten between legs; the bridge resolves PATH per exec, no caching.
  //
  // `sleep` is deliberately a PROCESS TREE, not one sleeping process: the
  // grandchild inherits the handler's stdout/stderr, which is the shape a
  // real handler takes (a wrapper launching a tracker CLI) and the shape that
  // broke the deadline before the killTree fix. The trailing `echo` is what
  // GUARANTEES the tree: without a command after it, a shell may exec-replace
  // itself with the last command, collapsing the grandchild into the child
  // and letting a plain child.kill() look sufficient. (macOS /bin/sh does not
  // exec-optimize even without it — verified — but dash and others do, so the
  // leg must not depend on which shell /bin/sh happens to be.)
  const bodies = {
    ok: `#!/bin/sh\n/bin/cat > "$FGT_CAPTURE"\nprintf '%s' '${CANNED}'\n`,
    fail: `#!/bin/sh\n/bin/cat > "$FGT_CAPTURE"\nprintf '%s' '{"ok":false,"error":"refused by policy"}'\nexit 3\n`,
    sleep: `#!/bin/sh\n/bin/cat > /dev/null\n/bin/sleep 10\necho never-reached\n`,
  };
  if (mode === 'absent') { fs.rmSync(handlerPath, { force: true }); return; }
  fs.writeFileSync(handlerPath, bodies[mode], { mode: 0o755 });
}

function readCapture() {
  try { return JSON.parse(fs.readFileSync(capturePath, 'utf8')); }
  catch (e) { return null; }
}
function resetCapture() { fs.rmSync(capturePath, { force: true }); }

// ---- servers ----
// process.execPath, not 'node': the ticket bridge is launched with a
// deliberately single-entry PATH (see HANDLER_PATH_ENV), which is enough to
// find the handler and NOT enough to find the node binary — so resolving
// the interpreter through that PATH fails with a confusing `spawn node
// ENOENT`. An absolute interpreter keeps the restricted PATH scoped to the
// one lookup it is meant to restrict.
function spawnBridge(script, name, port, extraArgs, env) {
  const b = cp.spawn(process.execPath, [script, '--port=' + port, '--quiet'].concat(extraArgs || []),
    { stdio: ['ignore', 'pipe', 'inherit'], env: Object.assign({}, process.env, env || {}) });
  return new Promise((resolve, reject) => {
    let out = '';
    b.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(b); });
    b.on('exit', (c) => reject(new Error(name + ' exited ' + c + ' before listening')));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
async function freePort() {
  const s = http.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

// Raw one-shot GET (agent: false): fetch's pooled socket dies while
// driveBoot's spawnSync blocks the event loop (the netbridge lesson).
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

// ---- compile the REAL client source once ----
const clientWasmPath = path.join(tmp, 'fgt.wasm');
cp.execFileSync('node', [COMPILER, CLIENT_C, '-o', clientWasmPath], { stdio: 'pipe' });
const clientWasm = fs.readFileSync(clientWasmPath);

// ---- one fake-worker kernel boot of the client per scenario ----
// cfg = { argv: [...after argv0], etcTicket: 'url ...', etcNet: 'bridge on...' }
// -> { status, exit, signal, stdout, stderr, ms }
//
// `status` is the raw WAIT-STATUS onHalt delivers (kernel.js:1963), so a
// plain `=== 2` comparison against an exit code silently fails: exit 2
// arrives as 512. `exit` is the decoded code (null when signalled) and is
// what assertions should read.
async function runClient(cfg) {
  const images = new Map([['/bin/file-gucos-ticket', clientWasm]]);
  const store = new BLOCK_FS.MemoryByteStore(8 << 20);
  const kfs = BLOCK_FS.createV4(store);
  kfs.mkdir('/etc', 0o755);
  if (cfg.etcTicket) OS_COMMON.writeFile(kfs, '/etc/ticket', cfg.etcTicket);
  if (cfg.etcNet) OS_COMMON.writeFile(kfs, '/etc/net', cfg.etcNet);
  const out = { 1: '', 2: '' };
  let haltResolve;
  const haltPromise = new Promise((res) => { haltResolve = res; });
  const netFetch = OS_COMMON.createNetFetch();
  const kernel = new K.Kernel({
    fs: kfs,
    fetch: netFetch,
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => images.get(p) || null,
    onOutput: (pid, fd, bytes) => { out[fd] = (out[fd] || '') + Buffer.from(bytes).toString(); },
    onHalt: (status) => haltResolve(status),
    log: () => {},
  });
  const tty = kernel.createTty({ output: () => {} });
  OS_COMMON.netFetchAttach(netFetch, kernel, kfs);
  if (cfg.stdin) { tty.input(Buffer.from(cfg.stdin)); tty.eof(true); }
  const t0 = Date.now();
  await kernel.boot({ path: '/bin/file-gucos-ticket',
    argv: ['file-gucos-ticket'].concat(cfg.argv || []), envp: [], cwd: '/' });
  const status = await haltPromise;
  const signal = (status & 0x7f) || null;
  return { status, signal, exit: signal ? null : (status >> 8) & 0xff,
           stdout: out[1], stderr: out[2], ms: Date.now() - t0 };
}

(async () => {
  const watchdog = setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 240000);

  const ticketPort = await freePort();
  const ticketBase = 'http://127.0.0.1:' + ticketPort;
  // --handler-timeout=1500 serves the timeout leg without a 30s stall; the
  // ok/fail handlers answer in milliseconds, far inside it.
  const ticketProc = await spawnBridge(TICKET_BRIDGE, 'ticket-bridge', ticketPort,
    ['--handler-timeout=' + HANDLER_TIMEOUT_MS],
    { PATH: HANDLER_PATH_ENV, FGT_CAPTURE: capturePath });
  const netPort = await freePort();
  const netBase = 'http://127.0.0.1:' + netPort;
  const netProc = await spawnBridge(NET_BRIDGE, 'net-bridge', netPort);
  // Leftover children wedge the suite runner's log capture — kill on EVERY
  // exit path, failure exits included.
  process.on('exit', () => {
    try { ticketProc.kill(); } catch (e) {}
    try { netProc.kill(); } catch (e) {}
    // The mkdtemp dir needs no rm here — mkdtempOwned already tracks it for
    // every exit path, and the reaper covers SIGKILL (see its comment above).
  });
  const deadPort = await freePort();   // just-closed port = deterministic refusal

  /* ============ Leg A: the real client, per-scenario boots ============ */

  // A1: direct mode (no /etc/net), handler ok — the baseline positive.
  setHandler('ok');
  resetCapture();
  let r = await runClient({
    etcTicket: 'url ' + ticketBase + '\n',
    argv: ['--title', 'Boot smoke [451]', '--body', 'hello from gucOS',
           '--priority', '2', '--difficulty', 'light'],
  });
  check('A1 direct+ok: exit 0', r.exit === 0, r.exit + ' stderr=' + r.stderr);
  check('A1 direct+ok: handler reply verbatim on stdout', r.stdout === CANNED,
    JSON.stringify(r.stdout));
  check('A1 direct+ok: nothing on stderr', r.stderr === '', JSON.stringify(r.stderr));
  let cap = readCapture();
  check('A1 positive control: the handler received the exact JSON payload',
    cap !== null && cap.kind === 'ticket' && cap.title === 'Boot smoke [451]'
      && cap.body === 'hello from gucOS' && cap.priority === 2
      && cap.difficulty === 'light' && Object.keys(cap).length === 5,
    JSON.stringify(cap));

  // A2: net-bridge ON — the same client transits tools/net-bridge.js with
  // zero special-casing; the net-bridge /fetch counter is the transit proof.
  resetCapture();
  const netBefore = await bridgeCount(netBase);
  r = await runClient({
    etcTicket: 'url ' + ticketBase + '\n',
    etcNet: 'bridge on\nurl ' + netBase + '\n',
    argv: ['--title', 'quoted "title" with\nnewline', '--kind', 'alert'],
  });
  const netAfter = await bridgeCount(netBase);
  check('A2 bridge-on: exit 0 + reply verbatim', r.exit === 0 && r.stdout === CANNED,
    r.exit + ' ' + JSON.stringify(r.stdout) + ' stderr=' + r.stderr);
  check('A2 transit proof: the net-bridge proxied exactly this one request',
    netAfter - netBefore === 1, netBefore + ' -> ' + netAfter);
  cap = readCapture();
  check('A2: JSON escaping survived both hops (quotes + newline), fields omitted',
    cap !== null && cap.kind === 'alert' && cap.title === 'quoted "title" with\nnewline'
      && !('body' in cap) && !('priority' in cap) && !('difficulty' in cap),
    JSON.stringify(cap));

  // A3: handler ABSENT — the truthful "no handler installed here" leg.
  setHandler('absent');
  resetCapture();
  r = await runClient({
    etcTicket: 'url ' + ticketBase + '\n',
    argv: ['--title', 'nobody home'],
  });
  // The isolation guard, asserted rather than assumed (see HANDLER_PATH_ENV):
  // if the ambient PATH ever creeps back into the bridge's env, a real
  // handler installed on this machine answers instead and A3 stops being an
  // ENOENT leg at all. 501 is reachable ONLY from spawn ENOENT, so the check
  // below is the discriminator — this one just names the cause up front.
  check('A3 isolation: the bridge searches ONLY the private fake dir',
    HANDLER_PATH_ENV === fakeBin && !HANDLER_PATH_ENV.includes(path.delimiter),
    JSON.stringify(HANDLER_PATH_ENV));
  check('A3 ENOENT: nonzero exit', r.exit !== 0, String(r.exit));
  check('A3 ENOENT: names the missing handler, not the bridge',
    /no ticket handler installed/.test(r.stderr) && !/unreachable/.test(r.stderr),
    JSON.stringify(r.stderr));
  check('A3 ENOENT: nothing on stdout', r.stdout === '', JSON.stringify(r.stdout));

  // A4: handler nonzero exit — relayed as HANDLER failure with its own
  // words, distinguishable from a bridge refusal.
  setHandler('fail');
  resetCapture();
  r = await runClient({
    etcTicket: 'url ' + ticketBase + '\n',
    argv: ['--title', 'reject me'],
  });
  check('A4 handler-exit-3: nonzero exit', r.exit !== 0, String(r.exit));
  check('A4 handler-exit-3: relayed as handler failure with exit code + its stdout',
    /handler failed \(exit 3\)/.test(r.stderr) && /refused by policy/.test(r.stderr),
    JSON.stringify(r.stderr));
  check('A4 handler-exit-3: NOT labelled a bridge refusal',
    !/bridge refused/.test(r.stderr) && !/no ticket handler/.test(r.stderr),
    JSON.stringify(r.stderr));
  check('A4 positive control: the handler really ran (stdin captured)',
    readCapture() !== null && readCapture().title === 'reject me',
    JSON.stringify(readCapture()));

  // A5: handler TIMEOUT — the bridge SIGKILLs the handler's process GROUP at
  // --handler-timeout and answers a bridge-level 502.
  //
  // The DEADLINE ASSERTION below is the point of this leg, not the message
  // (review finding 2). Asserting only /timed out/ proves the timeout is
  // LABELLED, not that it is ENFORCED — and it stayed green through a real
  // defect: the handler's grandchild inherited its stdout pipe, so killing
  // only the direct child left 'close' blocked and a 1000ms timeout measured
  // 10439ms. Fixed it measures 1031ms. HANDLER_TIMEOUT_MS is 1500 and the
  // fake handler sleeps 10s, so the bound below separates the two by ~3x in
  // both directions: enforced ≈ 1.5s + boot, unenforced ≈ 10s+.
  setHandler('sleep');
  r = await runClient({
    etcTicket: 'url ' + ticketBase + '\n',
    argv: ['--title', 'sleeper'],
  });
  check('A5 handler-timeout: nonzero exit', r.exit !== 0, String(r.exit));
  check('A5 handler-timeout: bridge-level 502 naming the timeout',
    /HTTP 502/.test(r.stderr) && /timed out/.test(r.stderr), JSON.stringify(r.stderr));
  check('A5 handler-timeout is ENFORCED, not just labelled: answered well '
      + 'inside the handler\'s 10s sleep',
    r.ms < 5000, r.ms + 'ms (cap ' + HANDLER_TIMEOUT_MS + 'ms; >=5000 means the '
      + 'response waited on the orphaned grandchild, i.e. no wall-clock cap)');

  // A6: bridge UNREACHABLE — nothing listening at the configured url;
  // prompt (connect refusal, not a burned headers deadline).
  setHandler('ok');
  r = await runClient({
    etcTicket: 'url http://127.0.0.1:' + deadPort + '\n',
    argv: ['--title', 'into the void'],
  });
  check('A6 unreachable: nonzero exit + says unreachable, promptly',
    r.exit !== 0 && /unreachable/.test(r.stderr) && r.ms < 5000,
    r.exit + ' ' + r.ms + 'ms ' + JSON.stringify(r.stderr));

  // A7: oversize — a body whose ESCAPED JSON exceeds the bridge's 64 KB cap
  // arrives in-OS as a readable 413 (the #393 drain rule is what keeps it
  // from masquerading as "unreachable"). 40 K of '"' escapes to ~80 KB,
  // which clears the client's own 112 KB JSON_MAX and lands on the cap.
  // Passed as ONE argv value rather than on stdin on purpose: stdin here
  // would ride the tty line discipline (canonical mode, no newline in this
  // payload), which is a different mechanism than the one under test — and
  // leg C already proves the `--body -` stdin path end to end with the real
  // shell doing the piping.
  resetCapture();
  r = await runClient({
    etcTicket: 'url ' + ticketBase + '\n',
    argv: ['--title', 'too big', '--body', '"'.repeat(40 * 1024)],
  });
  check('A7 oversize: nonzero exit + the bridge\'s 413 relayed',
    r.exit !== 0 && /HTTP 413/.test(r.stderr) && /cap/.test(r.stderr),
    r.exit + ' ' + JSON.stringify(r.stderr.slice(0, 300)));
  check('A7 oversize: the handler never ran', readCapture() === null,
    JSON.stringify(readCapture()));

  // A8: usage — --title is required.
  r = await runClient({ argv: ['--body', 'no title'] });
  check('A8 usage: exit 2 naming --title',
    r.exit === 2 && /--title is required/.test(r.stderr),
    r.exit + ' ' + JSON.stringify(r.stderr.slice(0, 120)));

  /* ============ Leg B: the bridge's browser-facing HTTP surface ========= */

  setHandler('ok');
  let b = await fetch(ticketBase + '/file', { method: 'OPTIONS', headers: {
    origin: 'https://groundupcoder.com',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type',
    'access-control-request-private-network': 'true',
  } });
  check('B preflight: 204 + PNA allow + requested headers echoed',
    b.status === 204 && b.headers.get('access-control-allow-private-network') === 'true'
      && /content-type/.test(b.headers.get('access-control-allow-headers') || ''),
    b.status + ' pna=' + b.headers.get('access-control-allow-private-network'));

  resetCapture();
  const cntBeforeEvil = await bridgeCount(ticketBase);
  b = await fetch(ticketBase + '/file', { method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'ticket', title: 'evil' }) });
  check('B disallowed-origin POST: readable 403 — CORS echo + actionable text',
    b.status === 403 && b.headers.get('access-control-allow-origin') === 'https://evil.example'
      && /allow-origin/.test(await b.text()),
    b.status + ' acao=' + b.headers.get('access-control-allow-origin'));
  check('B disallowed origin: the handler never ran, counter untouched',
    readCapture() === null && (await bridgeCount(ticketBase)) === cntBeforeEvil,
    JSON.stringify(readCapture()));

  b = await fetch(ticketBase + '/file', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'ticket', title: 'x', body: 'y'.repeat(65 * 1024) }) });
  check('B oversize body: 413, no x-guc-exit',
    b.status === 413 && b.headers.get('x-guc-exit') === null, b.status);

  b = await fetch(ticketBase + '/file', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: 'not json at all' });
  check('B non-JSON body: 400', b.status === 400, b.status);
  b = await fetch(ticketBase + '/file', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '[1,2,3]' });
  check('B JSON but not an object: 400', b.status === 400, b.status);

  resetCapture();
  b = await fetch(ticketBase + '/file', { method: 'POST',
    headers: { origin: 'https://groundupcoder.com', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'ticket', title: 'from the deploy origin' }) });
  check('B allowed origin: encapsulated 200 — x-guc-exit 0, exposed, canned body',
    b.status === 200 && b.headers.get('x-guc-exit') === '0'
      && /x-guc-exit/.test(b.headers.get('access-control-expose-headers') || '')
      && (await b.text()) === CANNED,
    b.status + '/' + b.headers.get('x-guc-exit'));
  check('B allowed origin positive control: handler saw the payload',
    (readCapture() || {}).title === 'from the deploy origin', JSON.stringify(readCapture()));

  b = await fetch(ticketBase + '/health');
  check('B health: names the bridge', (await b.json()).bridge === 'guc-ticket-bridge');
  b = await fetch(ticketBase + '/other', { method: 'POST', body: '{}' });
  check('B unknown endpoint: 404', b.status === 404, b.status);

  /* ============ Leg C: the SHIPPED binary in the real image ============ */

  // The watchdog cannot protect a spawnSync block (timers don't run) and
  // would misfire when the loop resumes — driveBoot's own timeout owns this.
  clearTimeout(watchdog);
  setHandler('ok');
  resetCapture();
  const boot = driveBoot([
    `printf 'url ${ticketBase}\\n' > /etc/ticket`,
    `echo body-from-real-os | file-gucos-ticket --title 'Real image smoke' --body -`,
    'echo RC=$?',
    'exit',
  ]);
  check('C shipped binary: reply visible in-OS + exit 0',
    boot.stdout.includes(CANNED) && boot.stdout.includes('RC=0'),
    JSON.stringify(boot.stdout.slice(-400)));
  cap = readCapture();
  check('C shipped binary: stdin body reached the handler',
    cap !== null && cap.title === 'Real image smoke' && cap.body === 'body-from-real-os\n',
    JSON.stringify(cap));

  ticketProc.kill();
  netProc.kill();

  console.log(failures ? 'FAILURES: ' + failures : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
