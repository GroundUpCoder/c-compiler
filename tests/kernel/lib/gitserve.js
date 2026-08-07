/* gitserve.js — a git smart-HTTP server whose OTHER END is the host's REAL
 * git (ticket #478). The gucOS git network leg is only trustworthy against a
 * second implementation, so this server shells every request out to
 * `git upload-pack` / `git receive-pack` in --stateless-rpc mode — the same
 * plumbing `git http-backend` drives, without the CGI envelope.
 *
 * Protocol served (smart HTTP v0, the shape libgit2's smart transport speaks):
 *   GET  /<repo>/info/refs?service=git-upload-pack|git-receive-pack
 *     -> 200 application/x-<service>-advertisement:
 *        pkt-line("# service=<service>\n") + flush + `git <svc> --advertise-refs`
 *   POST /<repo>/git-upload-pack | /<repo>/git-receive-pack
 *     -> 200 application/x-<service>-result: `git <svc> --stateless-rpc`
 *        with the request body on stdin, stdout streamed back.
 *
 * Options:
 *   repos: { '/name.git': '/abs/path/to/bare-or-worktree' }  (required)
 *   auth:  { user, pass }  — when set, every request must carry the matching
 *          Basic Authorization header; anything else gets 401 + a
 *          WWW-Authenticate: Basic challenge (the credential-loop exerciser).
 *   redirects: { '/old.git': '/name.git' } — 301 the whole subtree, so a
 *          client that follows and re-bases its POSTs can be proven to.
 *
 * startGitServer(opts) -> Promise<{ port, url, close(), requests }> runs the
 * server IN-PROCESS; `requests` is a live array of 'METHOD path' strings —
 * the positive control that traffic really flowed through THIS server.
 *
 * 🔴 An e2e that drives boot.js through driveBoot (spawnSYNC — the test
 * process's event loop is DEAD for the whole boot) must NOT use the
 * in-process form: the server would never answer and every in-OS request
 * would ride the headers deadline into ETIMEDOUT. Use spawnGitServer(opts)
 * instead — it runs this same file as a CHILD process (the startServer /
 * serve.js pattern) and exposes the request log at GET /__requests so the
 * positive control survives the synchronous gap.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

function pktline(s) {
  const n = Buffer.byteLength(s) + 4;
  return n.toString(16).padStart(4, '0') + s;
}

function svcBin(service) {
  // 'git-upload-pack' -> ['git', 'upload-pack']; refuse anything else.
  if (service === 'git-upload-pack') return ['git', 'upload-pack'];
  if (service === 'git-receive-pack') return ['git', 'receive-pack'];
  return null;
}

function authorized(req, auth) {
  if (!auth) return true;
  const h = req.headers.authorization || '';
  const want = 'Basic ' + Buffer.from(auth.user + ':' + auth.pass).toString('base64');
  return h === want;
}

function startGitServer(opts) {
  const repos = opts.repos || {};
  const redirects = opts.redirects || {};
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__requests') {   // introspection, not traffic
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(requests));
      return;
    }
    requests.push(req.method + ' ' + req.url);
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;

    // Redirect subtree: /old.git/anything -> /new.git/anything (301).
    for (const [from, to] of Object.entries(redirects)) {
      if (path === from || path.startsWith(from + '/')) {
        res.writeHead(301, { location: 'http://127.0.0.1:' + server.address().port
          + to + path.slice(from.length) + u.search });
        res.end();
        return;
      }
    }

    if (!authorized(req, opts.auth)) {
      req.resume();
      res.writeHead(401, { 'www-authenticate': 'Basic realm="gitserve"',
        'content-type': 'text/plain' });
      res.end('auth required');
      return;
    }

    const m = /^(\/[^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    const dir = m && repos[m[1]];
    if (!dir) {
      req.resume();
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such repo: ' + path);
      return;
    }

    if (req.method === 'GET' && m[2] === 'info/refs') {
      const service = u.searchParams.get('service');
      const bin = svcBin(service);
      if (!bin) {   // dumb-protocol probe: refuse it honestly
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('smart HTTP only (?service= required)');
        return;
      }
      const adv = cp.spawnSync(bin[0], [bin[1], '--stateless-rpc', '--advertise-refs', dir],
        { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
      if (adv.status !== 0) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('advertise-refs failed: ' + adv.stderr);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-' + service + '-advertisement',
        'cache-control': 'no-cache' });
      res.end(Buffer.concat([
        Buffer.from(pktline('# service=' + service + '\n')),
        Buffer.from('0000'),
        adv.stdout,
      ]));
      return;
    }

    if (req.method === 'POST' && (m[2] === 'git-upload-pack' || m[2] === 'git-receive-pack')) {
      const service = m[2];
      const bin = svcBin(service);
      res.writeHead(200, { 'content-type': 'application/x-' + service + '-result',
        'cache-control': 'no-cache' });
      const child = cp.spawn(bin[0], [bin[1], '--stateless-rpc', dir],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      let errbuf = '';
      child.stderr.on('data', (d) => { errbuf += d; });
      req.pipe(child.stdin);
      child.stdout.pipe(res);
      child.on('exit', (code) => {
        if (code !== 0) {
          // Headers already went out 200 (the smart protocol reports errors
          // in-band); a hard death mid-stream must not look like a clean EOF.
          console.error('[gitserve] ' + service + ' exited ' + code + ': ' + errbuf);
          res.destroy();
        }
      });
      child.on('error', () => res.destroy());
      return;
    }

    req.resume();
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: 'http://127.0.0.1:' + port,
        requests,
        close: () => new Promise((ok) => server.close(ok)),
      });
    });
  });
}

/* Run the server as a CHILD process (survives the caller's spawnSync gaps).
 * Resolves { port, url, requests(), kill() }; requests() fetches the child's
 * live log via /__requests. The child dies with the caller (kill on exit). */
const children = [];
function spawnGitServer(opts) {
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gitserve-')), 'config.json');
  fs.writeFileSync(cfg, JSON.stringify(opts));
  const child = cp.spawn(process.execPath, [__filename, '--config=' + cfg],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let buf = '', ebuf = '';
    const to = setTimeout(() => reject(new Error('gitserve never announced: ' + buf + ebuf)), 10000);
    child.stderr.on('data', (d) => { ebuf += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on (http:\/\/127\.0\.0\.1:(\d+))/.exec(buf);
      if (m) {
        clearTimeout(to);
        resolve({
          port: parseInt(m[2], 10),
          url: m[1],
          requests: async () => (await fetch(m[1] + '/__requests')).json(),
          kill: () => { try { child.kill(); } catch (e) {} },
        });
      }
    });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
    child.on('exit', (code) => { clearTimeout(to); reject(new Error('gitserve exited ' + code + ': ' + ebuf)); });
  });
}
process.on('exit', () => { for (const c of children) { try { c.kill(); } catch (e) {} } });

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--config='));
  if (!arg) {
    console.error('usage: node gitserve.js --config=<json file>');
    process.exit(2);
  }
  const opts = JSON.parse(fs.readFileSync(arg.slice('--config='.length), 'utf-8'));
  startGitServer(opts).then((s) => {
    console.log('[gitserve] listening on ' + s.url);
  }, (e) => {
    console.error('[gitserve] ' + (e && e.message));
    process.exit(1);
  });
}

module.exports = { startGitServer, spawnGitServer, pktline };
