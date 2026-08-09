// Host-level regression test for ticket #393: the net-bridge wrapper's
// "bridge unreachable" mislabel, and the encapsulation gaps that fed it.
//
// The old createNetFetch rejection handler branded EVERY bridge-fetch
// failure "net bridge unreachable ... is tools/net-bridge.js running?" /
// ENETUNREACH — including failures a perfectly healthy bridge causes: a
// non-Latin-1 url or header value (fetch rejects the header the wrapper
// itself built), a 413 answered mid-upload (the bridge destroyed the
// socket, the client saw a connection reset), a disallowed origin (the
// preflight 403 carried no CORS headers, an opaque TypeError in a
// browser). Every diagnosis that started from that message went looking
// at a dead bridge that wasn't dead (that mislabel is what disguised
// #391's real bug).
//
// Legs:
//   A. fake bridge answering plain statuses -> the wrapper names the real
//      status, never "unreachable"; 403 EACCES, 502 EIO, 200-without-
//      encapsulation called out as not-the-bridge-protocol.
//   B. genuinely dead bridge -> keeps "unreachable" + ENETUNREACH, and the
//      message now carries the undici cause (connect ECONNREFUSED ...).
//   C. non-Latin-1 url/header transmission: the wire header values are
//      pure ASCII (URL -> its ASCII serialization; header JSON \uXXXX-
//      escaped) and the bridge-side JSON.parse round-trips losslessly,
//      astral pairs included. Invalid inputs (unparsable url, non-token
//      method) reject EINVAL naming the value — never blaming the bridge.
//   D. the REAL tools/net-bridge.js: an over-cap body gets a clean 413
//      through the wrapper (drain, not destroy), and a disallowed-origin
//      request gets a CORS-readable 403 after a passing preflight.
//   E. ticket #391 path selection under a mocked `location`: same-origin
//      targets (relative AND absolute) take the BASE fetch even with the
//      bridge ON — proven by WHICH url the counting base fetch received,
//      not by "it worked" — off-origin targets go bridged with x-guc-url
//      ABSOLUTIZED, an opaque location origin never matches, no location
//      (headless) means no passthrough (relative stays a loud EINVAL —
//      the strict-subset invariant), and bridge OFF stays an exact-args
//      tail call.
//
// Run: node tests/host/test_netbridge_wrapper.js
'use strict';
const http = require('http');
const net = require('net');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const BRIDGE = path.join(ROOT, 'tools', 'net-bridge.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

function listen(server) {
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
}

/* A port with no listener: bind, note the port, close. */
async function deadPort() {
  const srv = net.createServer();
  const port = await new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
  await new Promise((ok) => srv.close(ok));
  return port;
}

function wrapper(url) {
  const f = OS_COMMON.createNetFetch();
  f._state.on = true;
  f._state.url = url;
  return f;
}

/* Reject-shape probe: resolve {errno, message} from the rejection. */
function errOf(p) {
  return p.then(() => ({ resolved: true }), (e) => ({ errno: e.errno, message: e.message + '' }));
}

async function legA() {
  console.log('--- leg A: bridge-level answers are named, never "unreachable"');
  let mode = 'plain400';
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'plain400') { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad x-guc-url'); }
      else if (mode === 'plain403') { res.writeHead(403); res.end('origin not allowed'); }
      else if (mode === 'plain502') { res.writeHead(502); res.end('connect ECONNREFUSED 10.0.0.9:80'); }
      else if (mode === 'bare200') { res.writeHead(200); res.end('welcome to nginx'); }
    });
  });
  const port = await listen(fake);
  const f = wrapper('http://127.0.0.1:' + port);

  let r = await errOf(f('http://example.com/', {}));
  check('400: message names HTTP 400 and a RUNNING bridge',
    /HTTP 400/.test(r.message) && /RUNNING/.test(r.message), r.message);
  check('400: never "unreachable", never ENETUNREACH',
    !/unreachable/.test(r.message) && r.errno !== 'ENETUNREACH', r.errno + ':' + r.message);
  check('400: bridge body text carried into the message', /bad x-guc-url/.test(r.message), r.message);

  mode = 'plain403';
  r = await errOf(f('http://example.com/', {}));
  check('403: EACCES + names HTTP 403', r.errno === 'EACCES' && /HTTP 403/.test(r.message),
    r.errno + ':' + r.message);

  mode = 'plain502';
  r = await errOf(f('http://example.com/', {}));
  check('502: EIO + upstream error text, not "unreachable"',
    r.errno === 'EIO' && /upstream/.test(r.message) && /ECONNREFUSED 10\.0\.0\.9/.test(r.message)
      && !/unreachable/.test(r.message),
    r.errno + ':' + r.message);

  mode = 'bare200';
  r = await errOf(f('http://example.com/', {}));
  check('200 without x-guc-status: called out as not the bridge protocol',
    /x-guc-status/.test(r.message) && !/unreachable/.test(r.message), r.message);

  await new Promise((ok) => fake.close(ok));
}

async function legB() {
  console.log('--- leg B: a genuinely dead bridge keeps unreachable/ENETUNREACH');
  const port = await deadPort();
  const f = wrapper('http://127.0.0.1:' + port);
  const r = await errOf(f('http://example.com/', {}));
  check('dead bridge: ENETUNREACH kept', r.errno === 'ENETUNREACH', r.errno);
  check('dead bridge: message kept (unreachable + is net-bridge running)',
    /unreachable/.test(r.message) && /net-bridge\.js running/.test(r.message), r.message);
  check('dead bridge: undici cause surfaced (ECONNREFUSED), not a bare "fetch failed"',
    /ECONNREFUSED/.test(r.message), r.message);
}

async function legC() {
  console.log('--- leg C: non-Latin-1 crosses the hop; invalid input is EINVAL, not bridge-blame');
  let seen = null;
  const echo = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen = {
        url: req.headers['x-guc-url'],
        method: req.headers['x-guc-method'],
        headers: req.headers['x-guc-headers'],
      };
      res.writeHead(200, { 'x-guc-status': '200', 'x-guc-headers': '[]' });
      res.end();
    });
  });
  const port = await listen(echo);
  const f = wrapper('http://127.0.0.1:' + port);

  // A UTF-8 url + header values spanning Latin-1, BMP and an astral pair.
  const pairs = [['x-note', 'héllo wörld'], ['x-emoji', 'crab \u{1f980} done'], ['x-cjk', '你好']];
  const ok = await f('http://example.com/päth/π?q=héllo', { headers: pairs })
    .then((resp) => resp.status, (e) => 'rejected: ' + e.message);
  check('non-Latin-1 url + headers: the bridged fetch SUCCEEDS', ok === 200, ok);
  check('x-guc-url is the ASCII URL serialization',
    seen && seen.url === 'http://example.com/p%C3%A4th/%CF%80?q=h%C3%A9llo', seen && seen.url);
  const asciiOnly = seen && /^[\x00-\x7f]*$/.test(seen.url + seen.method + seen.headers);
  check('every x-guc-* wire value is pure ASCII', !!asciiOnly,
    seen && JSON.stringify(seen));
  let roundTrip = null;
  try { roundTrip = JSON.parse(seen.headers); } catch (e) {}
  check('header JSON round-trips losslessly (astral pair included)',
    JSON.stringify(roundTrip) === JSON.stringify(pairs), seen && seen.headers);

  // Invalid inputs: honest EINVAL naming the value, no bridge in the blame.
  let r = await errOf(f('no scheme at all', {}));
  check('unparsable url: EINVAL naming the url',
    r.errno === 'EINVAL' && /invalid target url/.test(r.message) && /no scheme at all/.test(r.message),
    r.errno + ':' + r.message);
  check('unparsable url: not labelled unreachable', !/unreachable/.test(r.message), r.message);
  r = await errOf(f('http://example.com/', { method: 'GÉT' }));
  check('non-token method: EINVAL naming the method',
    r.errno === 'EINVAL' && /invalid HTTP method/.test(r.message) && /G\\u00c9T|GÉT/.test(r.message),
    r.errno + ':' + r.message);

  await new Promise((ok) => echo.close(ok));
}

async function legD() {
  console.log('--- leg D: the REAL bridge — clean 413, CORS-readable origin refusal');
  const port = await deadPort();   // free port for the bridge to take
  const bridge = cp.spawn(process.execPath, [BRIDGE, '--port=' + port, '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error('bridge never printed listening')), 5000);
      bridge.stdout.on('data', (d) => { if (/listening/.test(d + '')) { clearTimeout(t); ok(); } });
      bridge.on('exit', (c) => bad(new Error('bridge exited ' + c)));
    });
    const bridgeBase = 'http://127.0.0.1:' + port;

    // Over-cap body THROUGH the wrapper: before #393 the bridge destroyed
    // the socket mid-upload and the wrapper reported the healthy bridge
    // unreachable; now it is a clean, named 413.
    const f = wrapper(bridgeBase);
    const big = Buffer.alloc(33 * 1024 * 1024, 0x61);   // BODY_CAP is 32 MiB
    const r = await errOf(f('http://example.com/', { method: 'POST', body: big }));
    check('over-cap body: named HTTP 413 from a RUNNING bridge',
      /HTTP 413/.test(r.message) && /RUNNING/.test(r.message), r.errno + ':' + r.message);
    check('over-cap body: never "unreachable"/ENETUNREACH',
      !/unreachable/.test(r.message) && r.errno !== 'ENETUNREACH', r.errno + ':' + r.message);

    // Disallowed origin: the preflight passes (204), the POST is refused
    // with a CORS-readable 403 — diagnosable in a browser, EACCES at the
    // wrapper.
    let resp = await fetch(bridgeBase + '/fetch', { method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    check('real bridge: disallowed-origin preflight answers 204', resp.status === 204, resp.status);
    resp = await fetch(bridgeBase + '/fetch', { method: 'POST', headers: {
      origin: 'https://evil.example',
      'x-guc-url': 'http://example.com/', 'x-guc-method': 'GET', 'x-guc-headers': '[]',
    } });
    const text = await resp.text();
    check('real bridge: origin refusal is 403 + CORS echo + actionable text',
      resp.status === 403
        && resp.headers.get('access-control-allow-origin') === 'https://evil.example'
        && /allow-origin/.test(text),
      resp.status + ' acao=' + resp.headers.get('access-control-allow-origin') + ' ' + text);
  } finally {
    bridge.kill('SIGKILL');
  }
}

async function legE() {
  console.log('--- leg E (#391): same-origin passthrough / off-origin absolutization / headless subset');
  // The wrapper posts bridged requests through the SAME base fetch it
  // passes same-origin traffic to, so a recording base is the one
  // discriminator that proves WHICH path a call took: passthrough hands
  // base the caller's original url; the bridged path hands it
  // `<bridge>/fetch` and the target only ever appears in x-guc-url.
  let seenUrl = null;   // x-guc-url the fake bridge received
  const echo = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seenUrl = req.headers['x-guc-url'];
      res.writeHead(200, { 'x-guc-status': '200', 'x-guc-headers': '[]' });
      res.end();
    });
  });
  const port = await listen(echo);

  const baseCalls = [];
  const SENTINEL = { sentinel: true };
  const countingBase = (url, init) => {
    baseCalls.push(url + '');
    if ((url + '').startsWith('http://127.0.0.1:' + port)) return fetch(url, init);
    return Promise.resolve(SENTINEL);   // passthrough traffic never leaves the mock
  };
  const f = OS_COMMON.createNetFetch(countingBase);
  f._state.on = true;
  f._state.url = 'http://127.0.0.1:' + port;

  const ORIGIN = 'http://10.9.9.9:7777';   // never 127.0.0.1: must not collide with the bridge
  globalThis.location = { href: ORIGIN + '/os.html', origin: ORIGIN };
  try {
    // Same-origin RELATIVE (jku's exact case: gucman's /packages/index.json).
    let got = await f('/packages/index.json', {});
    check('bridge ON + same-origin relative url: the BASE fetch ran, with the caller\'s exact url',
      got === SENTINEL && baseCalls.length === 1 && baseCalls[0] === '/packages/index.json',
      JSON.stringify(baseCalls));
    check('...and the bridge never saw it', seenUrl === null, seenUrl);

    // Same-origin ABSOLUTE: same passthrough.
    got = await f(ORIGIN + '/abs', {});
    check('bridge ON + same-origin absolute url: still the base fetch',
      got === SENTINEL && baseCalls[1] === ORIGIN + '/abs' && seenUrl === null,
      JSON.stringify(baseCalls));

    // Off-origin, non-absolute form (protocol-relative — the one relative
    // shape that resolves OFF-origin): bridged, and x-guc-url is the
    // ABSOLUTIZED serialization. Pre-#391 this was an EINVAL (new URL
    // with no base throws on '//host/path').
    let r = await f('//example.com/pkg', {});
    check('bridge ON + off-origin protocol-relative url: bridged, x-guc-url absolutized',
      r.status === 200 && seenUrl === 'http://example.com/pkg',
      'x-guc-url=' + seenUrl);
    check('...via the bridge endpoint, not passthrough',
      baseCalls[2] === 'http://127.0.0.1:' + port + '/fetch', JSON.stringify(baseCalls));

    // Off-origin absolute: bridged, untouched.
    seenUrl = null;
    r = await f('http://example.com/other', {});
    check('bridge ON + off-origin absolute url: bridged verbatim',
      r.status === 200 && seenUrl === 'http://example.com/other', seenUrl);

    // An opaque origin must never satisfy the same-origin test.
    globalThis.location = { href: ORIGIN + '/os.html', origin: 'null' };
    seenUrl = null;
    r = await f(ORIGIN + '/opaque', {});
    check('opaque (\'null\') location origin: no passthrough, goes bridged',
      r.status === 200 && seenUrl === ORIGIN + '/opaque', seenUrl);

    // Bridge OFF with a location: the exact-args tail call is unchanged
    // (relative url handed through untouched, no resolution).
    globalThis.location = { href: ORIGIN + '/os.html', origin: ORIGIN };
    f._state.on = false;
    got = await f('/packages/index.json', {});
    check('bridge OFF: exact-args tail call to base, url untouched',
      got === SENTINEL && baseCalls[baseCalls.length - 1] === '/packages/index.json',
      JSON.stringify(baseCalls.slice(-1)));
    f._state.on = true;
  } finally {
    delete globalThis.location;
  }

  // Headless (no location): NO passthrough. A relative url keeps failing
  // loudly — EINVAL naming the url, never a silent success and never a
  // bridge transit (the strict-subset invariant).
  seenUrl = null;
  const callsBefore = baseCalls.length;
  let r = await errOf(f('/packages/index.json', {}));
  check('no location + relative url: loud EINVAL naming the url (subset invariant)',
    r.errno === 'EINVAL' && /invalid target url/.test(r.message)
      && /\/packages\/index\.json/.test(r.message),
    r.errno + ':' + r.message);
  check('no location + relative url: nothing fetched, bridge never saw it',
    seenUrl === null && baseCalls.length === callsBefore, JSON.stringify(baseCalls.slice(callsBefore)));

  // Headless + absolute url: still bridged (nothing regressed for the
  // urls that always worked).
  r = await f('http://example.com/headless', {});
  check('no location + absolute url: bridged as ever',
    r.status === 200 && seenUrl === 'http://example.com/headless', seenUrl);

  await new Promise((ok) => echo.close(ok));
}

async function main() {
  await legA();
  await legB();
  await legC();
  await legD();
  await legE();
  console.log(failures ? failures + ' FAILURE(S)' : 'all netbridge-wrapper checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
