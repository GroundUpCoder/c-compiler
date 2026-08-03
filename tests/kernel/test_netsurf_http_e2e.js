#!/usr/bin/env node
// #182 (todos/0437) — NetSurf REAL NETWORKING: the gucOS http/https fetcher
// (vendor/netsurf/gucos/httpfetch.c) over the kernel HTTP transport, driven
// end to end in a booted OS against a live local HTTP server.
//
// The boot is an ASYNC spawn (the test_curl_e2e CLI-leg rule): the target
// server lives on THIS process's event loop, so a spawnSync boot would
// freeze the very server the in-OS browser is fetching from.  All wmctl
// waits therefore run inside the hush script; every satisfied wait echoes
// a marker, and any `wmctl: wait ... timed out` on the captured output
// fails the test loudly (the driveBoot discipline, applied by hand).
//
// Legs (direct mode, then the #359 redirect leg again over the BRIDGE):
//   - a real http: page loads end to end (title follows <title>);
//   - a GET form submits (coordinate click on a 300x150 button at 0,0)
//     and the response renders — the query string reaches the server;
//   - a urlenc POST form submits — method and body reach the server;
//   - a redirecting URL renders the FINAL page, the server sees llcache's
//     REFETCH of the final URL (FETCH_REDIRECT really fired — one
//     transport-followed hit + one refetch hit), and the page's relative
//     <img> resolves against the FINAL directory (/sub/pic.png, not
//     /pic.png) — the #359 payoff and the reason it sequenced first;
//   - 404: the response body renders as content (status flows, no hang);
//   - DNS failure and connection-refused: NetSurf's fetch-error query
//     page renders ("Error occurred fetching page" — FetchErrorTitle);
//   - headers timeout (/never, the kernel's 30s deadline): FETCH_TIMEDOUT
//     renders the DEDICATED timeout query page ("Connection timed out" —
//     distinct from the fetch-error page, proving the TIMEDOUT/ERROR
//     split); this leg costs real wall clock by nature (the deadline IS
//     the product behaviour);
//   - bridge mode: /etc/net flips the kernel fetch through a live
//     tools/net-bridge.js, and the redirect leg repeats — final URL,
//     refetch and relative-img resolution identical (both modes or
//     neither, the #359 fence).
//
// #368 legs — RESPONSE HEADERS REACH llcache.  Until #368 the fetcher
// emitted ZERO FETCH_HEADER messages on every successful fetch (the
// synthetic x-guc-final-url line was NUL-terminated in place, and being
// FIRST that severed the blob from every real header), so NetSurf never
// saw Content-Type — the reported Windows-1252 mojibake — and llcache
// never saw cache-control/etag/last-modified, which killed conditional
// requests and cache lifetimes outright.
//
// There is no in-OS dump of the FETCH_HEADER stream to count: NetSurf's
// JS bindings carry no XMLHttpRequest, llcache NSLOGs no header name, and
// a leaked synthetic line would be stored and never looked up.  So each
// header is asserted BY NAME through its own distinct, separately-failing
// effect — which is strictly stronger than a count, because it also
// proves the value was carried intact and parsed:
//   - content-type  -> /utf8.html is `text/html; charset=utf-8` with NO
//     <meta charset>; its title must read back as UTF-8 and NOT as the
//     Windows-1252 mojibake (both directions asserted);
//   - etag          -> the second visit to /reval.html carries
//     `If-None-Match: "nshdr-v1"` on the wire;
//   - last-modified -> that same request carries `If-Modified-Since` at
//     the served instant;
//   - cache-control -> `no-cache` on /reval.html is what forces that
//     revalidation at all, and `max-age=3600` on /fresh.html keeps its
//     SECOND visit entirely off the wire (the two-sided control: with no
//     cache headers llcache computes a zero freshness lifetime and
//     refetches, so a pre-#368 build hits the server twice).
// The 304 path is exercised for real: the conditional request is answered
// 304 and the page still renders from cache.
//
// Navigation inside ONE netsurf process is by link click (llcache is
// per-process, so a second `netsurf URL` would be a cold cache and could
// observe nothing).  The link shape is vendor/netsurf/test/squares.html's
// proven `<a><div w×h></div></a>` block.
//
// A native replica of the two blob-walking loops —
// logs/2026-08-03/368-netsurf-charset/nscharset/hdrloop.c — was the
// development red control (0 headers before the fix, 4 after).  It is
// deliberately NOT enrolled in any suite: it is a hand-copy of the
// function and would drift silently away from the code it claims to
// guard.  These legs run the real fetcher.
//
// The red control for "the fetcher is really load-bearing" was run at
// development time (register call stashed -> the first leg FAILS with no
// fetcher for the scheme); it cannot be a permanent leg because the
// fetcher registers at compile time.  v1 descopes are asserted nowhere
// here by design: multipart POST answers a loud FETCH_ERROR naming
// todos/0433 (unit-visible in the fetcher source), cookies cannot work in
// direct browser mode (fetch forbidden-header rules), auth has no UI.
//
// Run: node tests/kernel/test_netsurf_http_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const BRIDGE = path.join(ROOT, 'tools', 'net-bridge.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- pages ---- */
// The submit buttons are 300x150 at the top-left of a margin-0 body, so a
// coordinate click at (50,50) cannot miss whatever the exact layout does.
const BTN = 'position:absolute;left:0;top:0;width:300px;height:150px';
const INDEX_PAGE = `<html><head><title>HttpLanded</title></head>
<body style="margin:0">
<form action="/formget" method="get">
<input type="hidden" name="q" value="marker42">
<input type="submit" value="Go" style="${BTN}">
</form></body></html>`;
const POSTFORM_PAGE = `<html><head><title>PostForm</title></head>
<body style="margin:0">
<form action="/formpost" method="post">
<input type="hidden" name="p" value="marker43">
<input type="submit" value="Send" style="${BTN}">
</form></body></html>`;
const finalPage = (title, img) => `<html><head><title>${title}</title></head>
<body style="margin:0"><p>landed</p><img src="${img}"></body></html>`;

/* ---- #368 pages ---- */
// U+00F1: two UTF-8 bytes (C3 B1) that a Windows-1252 fallback decodes as
// the two printable characters "Ã±", so correct and broken decodes are
// both valid UTF-8 strings — no transport can mangle one and not the
// other, which keeps the two-sided title assertion honest.
const UTF8_TITLE = 'CharsetUtf8-ñ';
const UTF8_MOJIBAKE = 'CharsetUtf8-Ã±';
const UTF8_PAGE = `<html><head><title>${UTF8_TITLE}</title></head>
<body style="margin:0"><p>${UTF8_TITLE}</p></body></html>`;   /* NO <meta charset> */

const REVAL_ETAG = '"nshdr-v1"';
const REVAL_LM = 'Mon, 01 Jan 2024 00:00:00 GMT';   /* a real Monday; safely past */

// squares.html's proven click target: an inline <a> wrapping a sized
// block.  Stacked with no whitespace between them, so link 1 owns y
// 0..120 and link 2 starts at 120 — clicked at y=60 and y=200, both of
// which stay inside their box even if a stray line box shifts the second.
const linkDiv = (href, colour) =>
  `<a href="${href}"><div style="width:400px;height:120px;background:${colour}"></div></a>`;
const linkPage = (title, links) =>
  `<html><head><title>${title}</title></head><body style="margin:0">`
  + links.map(([h, c]) => linkDiv(h, c)).join('') + '</body></html>';

/* ---- the target server (records every request) ---- */
const seen = [];   // "METHOD path[ body]"
const reqs = [];   // { url, headers } — #368 needs the REQUEST headers too
const revalStatus = [];  // the status this server answered /reval.html with
const server = http.createServer((req, res) => {
  const u = req.url;
  reqs.push({ url: u, method: req.method, headers: req.headers });
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const body = Buffer.concat(parts).toString();
    seen.push(req.method + ' ' + u + (body ? ' ' + body : ''));
    if (u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(INDEX_PAGE); return; }
    if (u.startsWith('/formget')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>FormLanded</title></head><body>got</body></html>');
      return;
    }
    if (u === '/postform.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(POSTFORM_PAGE); return; }
    if (u === '/formpost') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>PostLanded</title></head><body>posted</body></html>');
      return;
    }
    if (u === '/redir') { res.writeHead(302, { location: '/sub/final.html' }); res.end(); return; }
    if (u === '/sub/final.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(finalPage('RedirLanded', 'pic.png')); return; }
    if (u === '/redir2') { res.writeHead(302, { location: '/sub/final2.html' }); res.end(); return; }
    if (u === '/sub/final2.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(finalPage('RedirLanded2', 'pic2.png')); return; }
    if (u === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>NotFound404</title></head><body>gone</body></html>');
      return;
    }
    if (u === '/never') { return; }            // headers never sent -> kernel deadline

    /* ---- #368 routes ---- */
    if (u === '/utf8.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(Buffer.from(UTF8_PAGE, 'utf8'));
      return;
    }
    if (u === '/reval.html') {
      // `no-cache` forbids serving from cache unvalidated, so every
      // revisit must revalidate; the etag/last-modified are what that
      // revalidation has to carry back.
      if (req.headers['if-none-match'] === REVAL_ETAG) {
        revalStatus.push(304);
        res.writeHead(304, { etag: REVAL_ETAG, 'cache-control': 'no-cache' });
        res.end();
        return;
      }
      revalStatus.push(200);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'etag': REVAL_ETAG,
        'last-modified': REVAL_LM,
        'cache-control': 'no-cache',
      });
      res.end(linkPage('RevalOne', [['/hop.html', '#0000ff']]));
      return;
    }
    if (u === '/fresh.html') {
      // max-age=3600: llcache must serve the SECOND visit from cache and
      // never reach this handler again.
      res.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'max-age=3600',
        'etag': '"fresh-v1"',
      });
      res.end(linkPage('FreshOne', [['/hop2.html', '#00ffff']]));
      return;
    }
    // The two hop pages carry NO cache headers on purpose (zero freshness
    // lifetime -> always refetched), so they can never mask a count.
    if (u === '/hop.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(linkPage('HopPage', [['/reval.html', '#00ff00'], ['/fresh.html', '#ff0000']]));
      return;
    }
    if (u === '/hop2.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(linkPage('HopTwo', [['/fresh.html', '#ff00ff']]));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('x');
  });
});

function listen(s) {
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
}
async function freePort() {
  const s = http.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}
function spawnBridge(port) {
  const b = cp.spawn('node', [BRIDGE, '--port=' + port, '--quiet'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    b.stdout.on('data', (d) => { out += d; if (out.includes('listening')) resolve(b); });
    b.on('exit', (c) => reject(new Error('bridge exited ' + c + ' before listening')));
  });
}

(async () => {
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const deadPort = await freePort();
  const bridgePort = await freePort();
  const bridgeProc = await spawnBridge(bridgePort);
  process.on('exit', () => { try { bridgeProc.kill(); } catch (e) {} });

  // Bake synchronously FIRST (no server dependency during the bake), then
  // boot async so the server stays live.
  const { dir: tmp, image } = freshImage('os-nshttp-');
  driveBoot('true', { image });

  const bootAsync = (script) => new Promise((resolve, reject) => {
    const child = cp.spawn('node',
      [path.join(ROOT, 'os/boot.js'), '--image=' + image, '--quiet'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    /* One boot drives every leg; the #368 legs added ~10 navigations on
     * top of the 8 original ones (and leg 7 spends the kernel's 30s
     * headers deadline by design), so the kill timer sits under the
     * registered 900s suite cap rather than the old 600s default. */
    const t = setTimeout(() => child.kill('SIGKILL'), 840000);
    child.on('close', () => { clearTimeout(t); resolve({ stdout: so, stderr: se }); });
    child.on('error', reject);
    child.stdin.write(script.endsWith('\n') ? script : script + '\n');
    child.stdin.end();
  });

  const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;
  const closeWin = (v, title) =>
    `wmctl close $${v} && wmctl wait nowin "${title}" 8000 && echo closed-${v}`;

  const script = [
    /* --- leg 1: plain http page + GET form submit --- */
    `netsurf ${base}/index.html &`,
    'wmctl wait win HttpLanded 60000 && echo got-index',
    sidOf('A', 'HttpLanded'),
    'wmctl click $A 50 50',                    /* the 300x150 submit button */
    'wmctl wait win FormLanded 30000 && echo got-formget',
    sidOf('A2', 'FormLanded'),
    closeWin('A2', 'FormLanded'),

    /* --- leg 2: urlenc POST form --- */
    `netsurf ${base}/postform.html &`,
    'wmctl wait win PostForm 30000 && echo got-postform',
    sidOf('B', 'PostForm'),
    'wmctl click $B 50 50',
    'wmctl wait win PostLanded 30000 && echo got-formpost',
    sidOf('B2', 'PostLanded'),
    closeWin('B2', 'PostLanded'),

    /* --- leg 3: redirect, DIRECT mode --- */
    `netsurf ${base}/redir &`,
    'wmctl wait win RedirLanded 30000 && echo got-redir',
    sidOf('C', 'RedirLanded'),
    closeWin('C', 'RedirLanded'),

    /* --- leg 4: 404 body renders as content --- */
    `netsurf ${base}/missing &`,
    'wmctl wait win NotFound404 30000 && echo got-404',
    sidOf('D', 'NotFound404'),
    closeWin('D', 'NotFound404'),

    /* --- leg 5: DNS failure -> fetch-error query page --- */
    'netsurf http://no-such-host.invalid/ &',
    'wmctl wait win "Error occurred fetching page" 30000 && echo got-dnserr',
    sidOf('E', 'Error occurred fetching page'),
    closeWin('E', 'Error occurred fetching page'),

    /* --- leg 6: connection refused -> fetch-error query page --- */
    `netsurf http://127.0.0.1:${deadPort}/ &`,
    'wmctl wait win "Error occurred fetching page" 30000 && echo got-refused',
    sidOf('F', 'Error occurred fetching page'),
    closeWin('F', 'Error occurred fetching page'),

    /* --- leg 7: headers timeout (kernel 30s deadline) -> FETCH_TIMEDOUT
     *     renders the DEDICATED timeout query page (query_timeout.c,
     *     "Connection timed out" — distinct from the fetch-error page,
     *     which is how this leg proves the TIMEDOUT/ERROR split) --- */
    `netsurf ${base}/never &`,
    'wmctl wait win "Connection timed out" 50000 && echo got-timeout',
    sidOf('G', 'Connection timed out'),
    closeWin('G', 'Connection timed out'),

    /* --- leg 8: BRIDGE mode redirect (both modes or neither) --- */
    `printf 'bridge on\\nurl http://127.0.0.1:${bridgePort}\\n' > /etc/net`,
    `netsurf ${base}/redir2 &`,
    'wmctl wait win RedirLanded2 30000 && echo got-redir2',
    sidOf('H', 'RedirLanded2'),
    closeWin('H', 'RedirLanded2'),

    /* --- leg 9 (#368): content-type reaches NetSurf — a charset=utf-8
     *     page with NO <meta charset> must decode as UTF-8.  The `wmctl
     *     list` echo is what makes the assertion two-sided: the correct
     *     title must appear in the output and the Windows-1252 mojibake
     *     must not. --- */
    `netsurf ${base}/utf8.html &`,
    `wmctl wait win "${UTF8_TITLE}" 30000 && echo got-utf8`,
    'wmctl list | grep CharsetUtf8',
    sidOf('I', UTF8_TITLE),
    closeWin('I', UTF8_TITLE),

    /* --- leg 10 (#368): the cache headers reach llcache.  ONE netsurf
     *     process throughout — llcache is per-process, so every hop is a
     *     link click.  reval(no-cache,etag,last-modified) -> hop ->
     *     reval again (must revalidate: If-None-Match + If-Modified-Since
     *     on the wire, answered 304, page still renders) -> hop ->
     *     fresh(max-age=3600) -> hop2 -> fresh again (must NOT reach the
     *     server at all). --- */
    `netsurf ${base}/reval.html &`,
    'wmctl wait win RevalOne 30000 && echo got-reval1',
    sidOf('J', 'RevalOne'),
    'wmctl click $J 200 60',
    'wmctl wait win HopPage 30000 && echo got-hop1',
    'wmctl click $J 200 60',                   /* hop link 1 -> /reval.html */
    'wmctl wait win RevalOne 30000 && echo got-reval2',
    'wmctl click $J 200 60',
    'wmctl wait win HopPage 30000 && echo got-hop2',
    'wmctl click $J 200 200',                  /* hop link 2 -> /fresh.html */
    'wmctl wait win FreshOne 30000 && echo got-fresh1',
    'wmctl click $J 200 60',
    'wmctl wait win HopTwo 30000 && echo got-hop3',
    'wmctl click $J 200 60',                   /* -> /fresh.html, from cache */
    'wmctl wait win FreshOne 30000 && echo got-fresh2',
    closeWin('J', 'FreshOne'),

    'echo ALL-LEGS-DONE',
    'exit',
  ].join('\n');

  const r = await bootAsync(script);
  const out = r.stdout;

  bridgeProc.kill();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  check('boot reached the end marker', out.includes('ALL-LEGS-DONE'),
    out.slice(-500) + '\nstderr: ' + r.stderr.slice(-500));
  check('no wmctl wait burned its clock (driveBoot discipline by hand)',
    !/wmctl: wait .* timed out/.test(out + r.stderr),
    (out + r.stderr).match(/wmctl: wait .* timed out.*/g));

  /* leg completion markers */
  for (const m of ['got-index', 'got-formget', 'got-formpost', 'got-redir',
                   'got-404', 'got-dnserr', 'got-refused', 'got-timeout',
                   'got-redir2',
                   'got-utf8', 'got-reval1', 'got-hop1', 'got-reval2',
                   'got-hop2', 'got-fresh1', 'got-hop3', 'got-fresh2']) {
    check('leg marker ' + m, out.includes(m));
  }

  /* server-side truth */
  const count = (needle) => seen.filter((l) => l === needle || l.startsWith(needle)).length;
  check('GET form: the query string reached the wire',
    seen.some((l) => l.startsWith('GET /formget?') && l.includes('q=marker42')),
    JSON.stringify(seen.filter((l) => l.includes('formget'))));
  check('POST form: method POST and the urlenc body reached the wire',
    seen.includes('POST /formpost p=marker43'),
    JSON.stringify(seen.filter((l) => l.includes('formpost'))));
  check('direct redirect: llcache REFETCHED the final URL (transport hit + refetch hit)',
    count('GET /sub/final.html') === 2,
    JSON.stringify(seen.filter((l) => l.includes('final.html'))));
  check('direct redirect: the relative <img> resolved against the FINAL directory (#359 payoff)',
    count('GET /sub/pic.png') >= 1 && count('GET /pic.png') === 0,
    JSON.stringify(seen.filter((l) => l.includes('pic.png'))));
  check('bridge redirect: llcache refetched the final URL through the bridge',
    count('GET /sub/final2.html') === 2,
    JSON.stringify(seen.filter((l) => l.includes('final2.html'))));
  check('bridge redirect: relative <img> resolved against the FINAL directory',
    count('GET /sub/pic2.png') >= 1 && count('GET /pic2.png') === 0,
    JSON.stringify(seen.filter((l) => l.includes('pic2.png'))));

  /* ---- #368: the four response headers, each attributed BY NAME to its
   * own separately-failing effect.  Every one of these reads ZERO/absent
   * on a pre-#368 build, where no FETCH_HEADER was ever emitted. ---- */
  const revalReqs = reqs.filter((r) => r.url === '/reval.html');
  const freshReqs = reqs.filter((r) => r.url === '/fresh.html');
  const cond = revalReqs[1] ? revalReqs[1].headers : {};

  check('#368 content-type: charset=utf-8 with NO <meta charset> decoded as UTF-8',
    out.includes(UTF8_TITLE), JSON.stringify(out.match(/.*CharsetUtf8.*/g)));
  check('#368 content-type: and NOT as the Windows-1252 mojibake',
    !out.includes(UTF8_MOJIBAKE), JSON.stringify(out.match(/.*CharsetUtf8.*/g)));
  // Not a #368 discriminator — a pre-fix build ALSO hits twice (with no
  // cache headers llcache computes a zero freshness lifetime and refetches
  // unconditionally).  It is the precondition the two conditional-header
  // checks below index into, so it is asserted rather than assumed.
  check('#368 the no-cache page was revalidated exactly once (2 wire hits)',
    revalReqs.length === 2, JSON.stringify(revalReqs.map((r) => r.headers['if-none-match'])));
  check('#368 etag: the revalidation carried If-None-Match with the served value',
    cond['if-none-match'] === REVAL_ETAG, JSON.stringify(cond['if-none-match']));
  check('#368 last-modified: the revalidation carried If-Modified-Since at the served instant',
    cond['if-modified-since'] !== undefined &&
    Date.parse(cond['if-modified-since']) === Date.parse(REVAL_LM),
    JSON.stringify(cond['if-modified-since']));
  check('#368 the conditional request really took the 304 path',
    revalStatus.join(',') === '200,304', JSON.stringify(revalStatus));
  check('#368 the page still rendered after the 304 (served from cache)',
    revalStatus[1] === 304 && out.includes('got-reval2'),
    JSON.stringify(revalStatus));
  check('#368 cache-control: max-age=3600 kept the SECOND visit off the wire',
    freshReqs.length === 1, JSON.stringify(freshReqs.map((r) => r.url)));

  console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
