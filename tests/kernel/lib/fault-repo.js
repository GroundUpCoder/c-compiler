#!/usr/bin/env node
// A deliberately faulty package repo, for the gucman index-diagnosis legs
// (ticket #456). serve.js can only serve a whole file correctly, so the
// malformed-RESPONSE shapes need a server that is faulty on purpose.
//
// It runs as its OWN PROCESS, and that is not incidental: driveBoot() is
// spawnSync, so it blocks the caller's event loop for the whole boot. A
// server created inside the test process accepts the connection and then
// never answers, and the transfer dies on the kernel's 30s headers deadline
// — which reports as "Timeout was reached", i.e. a plausible-looking red
// that has nothing to do with what the leg is testing. Every repo server in
// this suite is a child process for exactly this reason.
//
// Each route answers HTTP 200 — the point is that the STATUS is fine and
// only the body is not, which is the shape the caller cannot distinguish
// without being told the byte count.
//
//   node tests/kernel/lib/fault-repo.js     # prints "port <n>" when listening
'use strict';
const http = require('http');

// A prefix of a valid index: legal JSON so far, and then it just stops.
const SHORT_BODY = '{"baseVersion": 1, "packages": {"punes"';

const ROUTES = {
  // A 200 that carries nothing at all. One of only two states that reproduce
  // the reported symptom, and the one that used to reach cJSON_Parse(NULL).
  '/empty/index.json': (res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '0' });
    res.end();
  },
  // Chunked ON PURPOSE (no content-length): ending early is then a WELL-FORMED
  // HTTP response carrying an incomplete document, so no layer below gucman
  // can call it an error. A body short of a DECLARED length cannot end
  // cleanly — the fetch under the veneer rejects it and it surfaces as a curl
  // error instead — which is why that shape is not offered here.
  '/short/index.json': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(SHORT_BODY);
  },
  // A whole body that simply is not JSON — a captive portal, the case the
  // original one-sentence message was actually about.
  '/garbage/index.json': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('<!DOCTYPE html>\n<html><body>captive portal</body></html>\n');
  },
};

function start() {
  const srv = http.createServer((req, res) => {
    const h = ROUTES[req.url.split('?')[0]];
    if (h) { h(res); return; }
    res.writeHead(404); res.end('nope');
  });
  srv.listen(0, '127.0.0.1', () => {
    process.stdout.write(`port ${srv.address().port}\n`);
  });

  // Die with our parent, the same poll serve.js uses. The test file kills us
  // from its own exit handler, but an exit handler does not run when that
  // process is SIGKILLed — and the suite runner kills a timed-out test file
  // exactly that way. A poll, not a handler, because a parent's death
  // delivers no signal here. This is the layer that matters most for us:
  // harness-leaks.js's orphan patterns anchor on `serve.js` or on
  // `tests/kernel/<name>.js`, and neither matches `tests/kernel/lib/
  // fault-repo.js`, so nothing external would ever reap this listener.
  const initialPpid = process.ppid;
  if (initialPpid > 1) {
    const watch = setInterval(() => {
      if (process.ppid === initialPpid) return;
      clearInterval(watch);
      process.exit(0);
    }, 1000);
    watch.unref();
  }
}

module.exports = { SHORT_BODY, ROUTES };
if (require.main === module) start();
