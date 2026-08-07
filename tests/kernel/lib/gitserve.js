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
 * startGitServer(opts) -> Promise<{ port, url, close(), requests }>.
 * `requests` is a live array of ' METHOD path' strings — the positive control
 * that traffic really flowed through THIS server.
 */
'use strict';
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

module.exports = { startGitServer, pktline };
