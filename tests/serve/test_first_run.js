// First-run path test: `node serve.js .` must print a URL that actually
// works. This broke once (logs/2026-07-06/first-boot-ux-and-seeding-perf.md
// #1): the printed URL was a bare http://localhost:PORT, which 404s because
// the repo root has no index.html — the OS lives at /os/os.html. The
// browser acceptance test (tests/browser/os-boots.mjs) launches serve.js
// but navigates to a hardcoded URL, so it can't catch a printed-URL
// regression; this test parses serve.js's stdout like a human would.
//
// Asserts: the printed URL points at /os/os.html, GET on it returns 200
// text/html with the COOP/COEP headers (load-bearing for SharedArrayBuffer),
// the page's worker scripts are servable, and a missing path 404s.
//
// Run: node tests/serve/test_first_run.js
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

function startAndGetUrl() {
  // Port 0 → ephemeral port, no collisions; serve.js prints the real one.
  const child = cp.spawn('node', [path.join(ROOT, 'serve.js'), '.', '0'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    // stderr must be CONSUMED, not just piped (#725): an unread pipe fills at
    // ~64KB and blocks the child — a serve.js failing verbosely (its startup
    // bake runs stdio-inherited into these pipes) would then hang instead of
    // exiting, converting the real error into the 5s no-URL timeout below.
    // And on failure stderr is the one stream that says WHY: the 2026-08-25
    // ship-gate red ("exited early (code 1)") was unattributable because this
    // handler was missing.
    child.stderr.on('data', (d) => { err += d.toString(); });
    const evidence = () => '; stdout: ' + out + '; stderr: ' + (err || '(empty)');
    const timer = setTimeout(() => {
      reject(new Error('serve.js printed no URL within 5s' + evidence()));
    }, 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/https?:\/\/\S+/);
      if (m) { clearTimeout(timer); resolve({ child, url: m[0] }); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('serve.js exited early (code ' + code + ')' + evidence()));
    });
  });
}

async function main() {
  const { child, url } = await startAndGetUrl();
  try {
    check('printed URL points at the OS page', url.endsWith('/os/os.html'), url);

    const res = await fetch(url);
    check('printed URL returns 200', res.status === 200, 'status=' + res.status);
    check('Content-Type is text/html',
      (res.headers.get('content-type') || '').startsWith('text/html'),
      res.headers.get('content-type'));
    check('COOP header present (SAB requirement)',
      res.headers.get('cross-origin-opener-policy') === 'same-origin');
    check('COEP header present (SAB requirement)',
      res.headers.get('cross-origin-embedder-policy') === 'require-corp');

    // The page is a thin bridge — it dies without its workers and the
    // compiler. Assert the tree serves them (catches a moved/renamed file
    // breaking first boot even when the page itself 200s).
    const base = url.replace(/\/os\/os\.html$/, '');
    for (const dep of ['/os/kernel-worker.js', '/os/process-worker.js',
                       '/kernel.js', '/host.js', '/compiler.js']) {
      const r = await fetch(base + dep);
      check(dep + ' is servable (200 js)', r.status === 200 &&
        (r.headers.get('content-type') || '').startsWith('text/javascript'),
        'status=' + r.status + ' type=' + r.headers.get('content-type'));
    }

    const missing = await fetch(base + '/no-such-file-xyz');
    check('missing path 404s', missing.status === 404, 'status=' + missing.status);
  } finally {
    child.kill();
  }
  console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) { console.error(e); process.exit(1); });
