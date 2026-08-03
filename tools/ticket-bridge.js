#!/usr/bin/env node
// ticket-bridge.js — the host ticket bridge (ticket #451; todos/NETWORK.md).
//
// A single-file, dependency-free localhost server that lets the in-OS
// `file-gucos-ticket` client hand a ticket/alert request OUT of the OS
// without this repo learning anything about how tickets are filed: on a
// valid POST the bridge shells out to a command named `file-gucos-ticket`
// resolved from the HOST's PATH, feeds it the request JSON on stdin, and
// relays that handler's stdout and exit code. The handler is NOT part of
// this repo — a host without one installed gets a truthful 501. The user
// runs the bridge themselves:
//
//   node tools/ticket-bridge.js [--port=8210] [--allow-origin=ORIGIN[,...]]
//                               [--handler-timeout=MS] [--quiet]
//
// Security posture: copied wholesale from tools/net-bridge.js (deliberate —
// see the posture note there). Binds 127.0.0.1 STRICTLY, no widening flag;
// Origin allowlist (no-Origin local clients allowed; localhost/127.0.0.1
// any port; https://groundupcoder.com; --allow-origin extends, `*` allows
// all); answers CORS preflights for every origin including Chrome's
// Private Network Access probe, and enforces the allowlist on the real
// request as a READABLE 403 (#393). This endpoint SPAWNS A PROCESS per
// request, so it is additionally boring under abuse even from an allowed
// origin: a small request-body cap, a handler stdout cap, a handler
// timeout (SIGKILL), and an in-flight exec clamp with a bounded queue.
//
// Wire contract with os/file-gucos-ticket.c (private, version-locked):
//   POST /file
//     body: ONE JSON object (the client sends {kind, title, body?,
//           priority?, difficulty?}) — the bridge checks it parses as a
//           JSON object and otherwise treats it as OPAQUE: no ticket
//           semantics live on this side of the wall either. The raw body
//           bytes are what the handler receives on stdin.
//   -> 200 with the ENCAPSULATED handler result:
//     x-guc-exit: the handler's exit code (CORS-exposed)
//     body:       the handler's stdout, verbatim (its JSON reply)
//   Encapsulation is what keeps "the handler rejected your ticket"
//   distinguishable from "the bridge refused you" (the net-bridge
//   x-guc-status convention): bridge-level answers are plain statuses and
//   NEVER carry x-guc-exit —
//     400  request body is not a JSON object
//     403  origin refused
//     413  request body exceeds the cap
//     501  no `file-gucos-ticket` handler on the host's PATH (ENOENT)
//     502  the handler died without a result (timeout/SIGKILL, spawn
//          failure, stdout overflow)
//     503  too many ticket requests in flight
//   GET /health -> {"bridge":"guc-ticket-bridge","requests":N} — the e2e's
//   positive-control counter (N counts /file requests that reached the
//   handler-exec stage).
'use strict';

const http = require('http');
const cp = require('child_process');

const DEFAULT_PORT = 8210;
const HANDLER_CMD = 'file-gucos-ticket';   // the ONE fact this repo knows
const BODY_CAP = 64 * 1024;                // a ticket, not a file proxy
const STDOUT_CAP = 256 * 1024;             // handler reply cap
const DEFAULT_HANDLER_TIMEOUT = 30 * 1000; // then SIGKILL
const MAX_INFLIGHT = 2;                    // concurrent handler execs
const MAX_QUEUE = 8;                       // pending beyond that -> 503

function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, allow: [], quiet: false,
                 handlerTimeout: DEFAULT_HANDLER_TIMEOUT };
  for (const a of argv) {
    let m;
    if ((m = /^--port=(\d+)$/.exec(a))) opts.port = parseInt(m[1], 10);
    else if ((m = /^--allow-origin=(.+)$/.exec(a))) opts.allow.push(...m[1].split(',').filter(Boolean));
    else if ((m = /^--handler-timeout=(\d+)$/.exec(a))) opts.handlerTimeout = parseInt(m[1], 10);
    else if (a === '--quiet') opts.quiet = true;
    else {
      console.error('ticket-bridge: unknown argument ' + a);
      console.error('usage: node tools/ticket-bridge.js [--port=N] '
        + '[--allow-origin=ORIGIN[,ORIGIN...]] [--handler-timeout=MS] [--quiet]');
      process.exit(2);
    }
  }
  return opts;
}

/* Origin policy — net-bridge.js's originAllowed, verbatim. */
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
    // x-guc-exit is the handler-result half of the encapsulation; absent
    // from this list it would be silently invisible to a cross-origin
    // reader (#359's lesson) — the shipped deploy IS cross-origin.
    'access-control-expose-headers': 'x-guc-exit',
    'vary': 'origin',
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.quiet ? () => {} : (m) => console.log('[ticket-bridge] ' + m);
  let requests = 0;                     // handler-exec attempts (the e2e's counter)
  let inflight = 0;
  const queue = [];                     // bounded; each entry is a run thunk

  function pump() {
    while (inflight < MAX_INFLIGHT && queue.length) { inflight++; queue.shift()(); }
  }

  /* Run the handler for one validated request body. Fixed argv, payload on
   * stdin, NEVER through a shell, never interpolated into arguments. */
  function runHandler(body, origin, res) {
    requests++;
    const n = requests;
    log(n + ': ' + HANDLER_CMD + ' <' + body.length + ' bytes'
      + (origin ? '  origin=' + origin : ''));
    const done = () => { inflight--; pump(); };
    let child;
    try {
      child = cp.spawn(HANDLER_CMD, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      done();
      res.writeHead(502, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
      res.end('ticket handler spawn failed: ' + (e && e.message));
      return;
    }
    const out = [], errChunks = [];
    let outLen = 0, finished = false, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (e) {}
    }, opts.handlerTimeout);
    const answer = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done();
      fn();
    };
    child.on('error', (e) => answer(() => {
      // ENOENT is the honest "this host has no ticket handler installed"
      // answer — a DISTINCT status so the in-OS client can say so.
      if (e && e.code === 'ENOENT') {
        log(n + ': no handler on PATH');
        res.writeHead(501, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('no ticket handler installed on this host: the `' + HANDLER_CMD
          + '` command is not on the bridge\'s PATH');
      } else {
        log(n + ': spawn failed: ' + (e && e.message));
        res.writeHead(502, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('ticket handler spawn failed: ' + (e && e.message));
      }
    }));
    child.stdout.on('data', (c) => {
      outLen += c.length;
      if (outLen > STDOUT_CAP) {
        try { child.kill('SIGKILL'); } catch (e) {}
        answer(() => {
          log(n + ': handler stdout exceeded cap');
          res.writeHead(502, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
          res.end('ticket handler reply exceeds the ' + STDOUT_CAP + '-byte cap');
        });
        return;
      }
      out.push(c);
    });
    child.stderr.on('data', (c) => { if (errChunks.length < 64) errChunks.push(c); });
    child.on('close', (code, signal) => answer(() => {
      const errText = Buffer.concat(errChunks).toString().slice(0, 2000);
      if (timedOut) {
        log(n + ': handler timed out after ' + opts.handlerTimeout + 'ms');
        res.writeHead(502, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('ticket handler timed out after ' + opts.handlerTimeout + 'ms (killed)');
        return;
      }
      if (code === null) {
        log(n + ': handler killed by ' + signal);
        res.writeHead(502, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('ticket handler killed by ' + signal);
        return;
      }
      if (code !== 0) log(n + ': handler exit ' + code + (errText ? ' — ' + errText : ''));
      else log(n + ': handler ok');
      // The handler ANSWERED (exit 0 or not): encapsulate. A nonzero exit
      // is the HANDLER rejecting the ticket — the client tells them apart
      // by x-guc-exit, never by HTTP status.
      res.writeHead(200, Object.assign(corsHeaders(origin), {
        'content-type': 'application/json',
        'x-guc-exit': String(code),
      }));
      res.end(Buffer.concat(out));
    }));
    child.stdin.on('error', () => {});   // handler may exit before reading
    child.stdin.end(body);
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const allowed = originAllowed(origin, opts.allow);

    if (req.method === 'OPTIONS') {
      // CORS preflight, PNA probe included — answers for EVERY origin
      // (#393): the allowlist is enforced on the real request, which a
      // refused page can then READ as a 403 (a preflight-level refusal is
      // an opaque TypeError, indistinguishable from a dead bridge).
      const h = Object.assign(corsHeaders(origin), {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers':
          req.headers['access-control-request-headers'] || 'content-type',
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
      // Drain + CORS-echo so the refusal is READABLE cross-origin (#393).
      req.resume();
      res.writeHead(403, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
      res.end('origin not allowed: ' + origin + ' (add --allow-origin=' + origin + ')');
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, Object.assign(corsHeaders(origin), { 'content-type': 'application/json' }));
      res.end(JSON.stringify({ bridge: 'guc-ticket-bridge', requests: requests }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/file') {
      req.resume();
      res.writeHead(404, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
      res.end('not found: ' + req.method + ' ' + req.url
        + ' — the bridge serves POST /file and GET /health');
      return;
    }

    // Buffer the request body under the cap (answer AND keep draining on
    // overflow — destroying the socket mid-upload turns a healthy 413 into
    // "bridge unreachable" at the client, #393).
    const chunks = [];
    let blen = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      blen += c.length;
      if (blen > BODY_CAP) {
        over = true;
        chunks.length = 0;
        res.writeHead(413, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('request body exceeds the ' + BODY_CAP + '-byte bridge cap');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      // Wire-format check only — no ticket semantics: one JSON object.
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch (e) { parsed = undefined; }
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null
          || Array.isArray(parsed)) {
        res.writeHead(400, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('request body must be one JSON object');
        return;
      }
      if (inflight >= MAX_INFLIGHT && queue.length >= MAX_QUEUE) {
        log('503: exec queue full');
        res.writeHead(503, Object.assign(corsHeaders(origin), { 'content-type': 'text/plain' }));
        res.end('too many ticket requests in flight');
        return;
      }
      // A client that dies while queued must not still exec the handler.
      let dead = false;
      res.on('close', () => { if (!res.writableEnded) dead = true; });
      queue.push(() => {
        if (dead) { inflight--; pump(); return; }
        runHandler(body, origin, res);
      });
      pump();
    });
  });

  server.listen(opts.port, '127.0.0.1', () => {
    // The "listening" line is the spawn barrier for the e2e and for humans.
    console.log('[ticket-bridge] listening on http://127.0.0.1:' + server.address().port);
    if (!opts.quiet) {
      console.log('[ticket-bridge] origins allowed: localhost/127.0.0.1 (any port), https://groundupcoder.com'
        + (opts.allow.length ? ', ' + opts.allow.join(', ') : ''));
      console.log('[ticket-bridge] handler: `' + HANDLER_CMD + '` from PATH, '
        + opts.handlerTimeout + 'ms timeout');
    }
  });
  server.on('error', (e) => {
    console.error('[ticket-bridge] ' + (e && e.message));
    process.exit(1);
  });
}

main();
