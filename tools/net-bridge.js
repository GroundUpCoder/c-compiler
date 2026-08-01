#!/usr/bin/env node
// net-bridge.js — the Tier 2.5 HTTP bridge (ticket #349; todos/NETWORK.md).
//
// A single-file, dependency-free localhost proxy that gives the in-browser
// OS generic HTTP egress: the kernel worker's fetch is CORS-gated by the
// platform, so with the `net` cfgstore setting ON the kernel-side fetch
// wrapper (os/os-common.js createNetFetch) reroutes every transfer through
// this process, which performs the real request with the USER'S network
// identity (their machine, their LAN, their dev servers) and streams the
// response back. The user runs it themselves:
//
//   node tools/net-bridge.js [--port=8199] [--allow-origin=ORIGIN[,ORIGIN...]]
//                            [--quiet]
//
// This is NOT todos/NETWORK.md Tier 4's `tools/net-relay.js` (the reserved
// name for the unbuilt raw-TCP websockify relay). The bridge speaks HTTP
// only — request in, response out, one hop — and shares no wire format
// with the relay design.
//
// Security posture (Stage 1, deliberate):
// - Binds 127.0.0.1 STRICTLY. There is no flag to widen the bind — a
//   reachable-from-the-LAN bridge is an open proxy, and "the user really
//   wants that" is a Tier 4 conversation, not a CLI flag.
// - Origin allowlist: a request WITHOUT an Origin header is a non-browser
//   local client (curl, boot.js) that already owns the machine's network —
//   allowed. A request WITH an Origin must match the allowlist: localhost /
//   127.0.0.1 on any port (dev serve.js), https://groundupcoder.com (the
//   shipped deploy), plus any --allow-origin additions (`*` allows all —
//   explicit opt-in only). The threat model is ARBITRARY OTHER WEBSITES
//   driving a user's bridge from a background tab; the two legitimate
//   embedder origins default in.
// - Answers CORS preflights, including Chrome's Private Network Access
//   probe (Access-Control-Allow-Private-Network: true) — a public https
//   page fetching 127.0.0.1 sends one before every request.
//
// Wire contract with createNetFetch (private, version-locked with os/):
//   POST /fetch
//     x-guc-url:     absolute http(s) target URL
//     x-guc-method:  upstream method (default GET)
//     x-guc-headers: JSON [[name, value], ...] — the app's request headers
//     body:          the request body, forwarded verbatim
//   -> 200 with the ENCAPSULATED upstream response:
//     x-guc-status:  upstream status code
//     x-guc-headers: JSON [[name, value], ...] (what Node fetch yields —
//                    NOT wire-faithful, matching the kernel's documented
//                    header semantics; capped, oversized sets truncated
//                    at a pair boundary)
//     x-guc-final-url: the upstream's POST-REDIRECT final URL (#359 —
//                    Node fetch follows redirects; this is where the
//                    response actually came from)
//     body:          upstream body, streamed with backpressure
//   Encapsulation is what keeps "upstream said 403" distinguishable from
//   "the bridge refused you": bridge-level answers are plain statuses
//   (400 bad request, 403 origin refused, 413 body cap, 502 upstream
//   fetch failure) and never carry x-guc-status.
//   GET /health -> {"bridge":"guc-net-bridge","requests":N} — the Control
//   Panel applet's Test target and the e2e's request counter.
'use strict';

const http = require('http');

const DEFAULT_PORT = 8199;
const BODY_CAP = 32 * 1024 * 1024;      // request-body buffer cap (v1 bodies are whole-buffer anyway)
const HDR_JSON_CAP = 32 * 1024;         // response-header JSON cap (kernel flattens to 64K)

// Hop-by-hop / transport-owned request headers the bridge must not forward:
// the upstream fetch owns its own connection and body framing.
const STRIP_REQ = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'expect',
]);
// Response headers that describe the BRIDGE->CLIENT hop, not the upstream
// payload as delivered: Node fetch has already decoded the body, so the
// upstream framing/encoding headers would misdescribe the bytes we ship.
const STRIP_RESP = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, allow: [], quiet: false };
  for (const a of argv) {
    let m;
    if ((m = /^--port=(\d+)$/.exec(a))) opts.port = parseInt(m[1], 10);
    else if ((m = /^--allow-origin=(.+)$/.exec(a))) opts.allow.push(...m[1].split(',').filter(Boolean));
    else if (a === '--quiet') opts.quiet = true;
    else {
      console.error('net-bridge: unknown argument ' + a);
      console.error('usage: node tools/net-bridge.js [--port=N] [--allow-origin=ORIGIN[,ORIGIN...]] [--quiet]');
      process.exit(2);
    }
  }
  return opts;
}

/* Origin policy — see the posture note in the header. */
function originAllowed(origin, allow) {
  if (origin === undefined || origin === null) return true;   // non-browser local client
  if (allow.includes('*')) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  if (origin === 'https://groundupcoder.com') return true;    // the shipped deploy
  return allow.includes(origin);
}

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    // x-guc-final-url MUST stay in this list (#359): a response header
    // absent here is silently invisible to a cross-origin reader — the
    // shipped deploy (https origin -> 127.0.0.1 bridge) IS cross-origin.
    'access-control-expose-headers': 'x-guc-status, x-guc-headers, x-guc-final-url',
    'vary': 'origin',
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.quiet ? () => {} : (m) => console.log('[net-bridge] ' + m);
  let requests = 0;                     // /fetch attempts (the e2e's positive-control counter)

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, opts.allow);

    if (req.method === 'OPTIONS') {
      // CORS preflight (any custom x-guc-* header forces one). Chrome's
      // Private Network Access probe adds Access-Control-Request-Private-
      // Network: true and requires the mirrored allow header.
      if (!allowed) { res.writeHead(403); res.end(); return; }
      const h = Object.assign(corsHeaders(origin), {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers':
          req.headers['access-control-request-headers'] || 'x-guc-url, x-guc-method, x-guc-headers, content-type',
        'access-control-max-age': '600',
      });
      if (req.headers['access-control-request-private-network'] === 'true')
        h['access-control-allow-private-network'] = 'true';
      res.writeHead(204, h);
      res.end();
      return;
    }

    if (!allowed) {
      log('403 origin refused: ' + origin);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('origin not allowed: ' + origin + ' (add --allow-origin=' + origin + ')');
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, Object.assign(corsHeaders(origin), { 'content-type': 'application/json' }));
      res.end(JSON.stringify({ bridge: 'guc-net-bridge', requests: requests }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/fetch') {
      res.writeHead(404, corsHeaders(origin));
      res.end();
      return;
    }

    const url = req.headers['x-guc-url'];
    const method = (req.headers['x-guc-method'] || 'GET') + '';
    if (!url || !/^https?:\/\//i.test(url)) {
      res.writeHead(400, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
      res.end('x-guc-url must be an absolute http(s) URL');
      return;
    }
    let pairs = [];
    try {
      const parsed = JSON.parse(req.headers['x-guc-headers'] || '[]');
      if (Array.isArray(parsed)) pairs = parsed.filter((p) => Array.isArray(p) && p.length === 2);
    } catch (e) { /* malformed header JSON: forward none */ }
    const headers = [];
    for (const [k, v] of pairs)
      if (!STRIP_REQ.has((k + '').toLowerCase())) headers.push([k + '', v + '']);

    // Buffer the request body (v1 bodies are whole-buffer kernel-side; the
    // cap is a guard, not a feature ceiling — exceeding it is a loud 413).
    const chunks = [];
    let blen = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      blen += c.length;
      if (blen > BODY_CAP) {
        over = true;
        res.writeHead(413, corsHeaders(origin));
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      requests++;
      const n = requests;
      log(n + ': ' + method + ' ' + url + (origin ? '  origin=' + origin : ''));

      // A dying client must abort the upstream transfer — close(2) on the
      // OS fd aborts the wrapper's bridge fetch, and that abort has to
      // propagate one more hop or the upstream stream leaks.
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      const init = { method: method, headers: headers, redirect: 'follow', signal: ac.signal };
      if (blen) init.body = Buffer.concat(chunks);

      fetch(url, init).then(async (up) => {
        const hp = [];
        let hlen = 0;
        up.headers.forEach((v, k) => {
          // Truncate at a pair boundary under the cap — the kernel already
          // documents header blobs as not wire-faithful.
          if (hlen < HDR_JSON_CAP && !STRIP_RESP.has(k)) { hp.push([k, v]); hlen += k.length + v.length + 8; }
        });
        res.writeHead(200, Object.assign(corsHeaders(origin), {
          'content-type': 'application/octet-stream',
          'x-guc-status': String(up.status),
          'x-guc-headers': JSON.stringify(hp),
          // #359: the upstream's post-redirect final URL (Node fetch
          // follows redirects; up.url is where the response came from).
          'x-guc-final-url': up.url || url,
        }));
        if (!up.body) { res.end(); return; }
        const reader = up.body.getReader();
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            if (!res.write(Buffer.from(r.value))) {
              await new Promise((ok) => res.once('drain', ok));   // backpressure
            }
          }
          res.end();
        } catch (e) {
          // Mid-stream upstream failure: kill the socket so the client sees
          // a mid-stream drop (EIO), never a clean-looking truncated EOF.
          log(n + ': mid-stream error: ' + (e && e.message));
          res.destroy();
        }
      }, (err) => {
        if (res.writableEnded || res.destroyed) return;
        const msg = (err && err.cause && err.cause.message) || (err && err.message) || 'fetch failed';
        log(n + ': upstream failed: ' + msg);
        res.writeHead(502, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end(msg);
      });
    });
  });

  server.listen(opts.port, '127.0.0.1', () => {
    // The "listening" line is the spawn barrier for the e2e and for humans.
    console.log('[net-bridge] listening on http://127.0.0.1:' + server.address().port);
    if (!opts.quiet) {
      console.log('[net-bridge] origins allowed: localhost/127.0.0.1 (any port), https://groundupcoder.com'
        + (opts.allow.length ? ', ' + opts.allow.join(', ') : ''));
    }
  });
  server.on('error', (e) => {
    console.error('[net-bridge] ' + (e && e.message));
    process.exit(1);
  });
}

main();
