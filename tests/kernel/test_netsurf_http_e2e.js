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

/* ---- the target server (records every request) ---- */
const seen = [];   // "METHOD path[ body]"
const server = http.createServer((req, res) => {
  const u = req.url;
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
    const t = setTimeout(() => child.kill('SIGKILL'), 540000);
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
                   'got-redir2']) {
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

  console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
