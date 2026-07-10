#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const arg = process.argv[2] || 'build';
const preferredPort = parseInt(process.argv[3] || '8080', 10);

const resolved = path.resolve(arg);
const stat = fs.statSync(resolved, { throwIfNoEntry: false });
const singleFile = stat && stat.isFile() ? resolved : null;
const root = singleFile ? path.dirname(resolved) : resolved;

// Prebaked system-image freshness (todos/0040 + 0082): when serving the OS
// tree, make sure os/os-system.img is current BEFORE listening — a stale/
// missing blob makes every fresh browser boot silently fall back to the
// ~16s in-worker bake, and a version-current blob baked before an
// uncommitted compiler.js/os//vendor edit would be silently FETCHED (the
// browser can't check input mtimes — this gate is the browser-path half of
// todos/0082). Baking is delegated to tools/mkimage.js (the same seed
// pipeline). Version rule mirrors kernel-worker.js: rebake only when
// baked < manifest (a NEWER blob is kept); input rule: rebake when any
// bake input (compiler.js, os/, vendor closure) is newer than the blob.
function ensureSystemImage(dir) {
  const manifestPath = path.join(dir, 'os', 'image.json');
  const mkimagePath = path.join(dir, 'tools', 'mkimage.js');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(mkimagePath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const wanted = manifest.version | 0;
  const imgPath = path.join(dir, 'os', 'os-system.img');
  let baked = -1;
  let why = null;
  if (fs.existsSync(imgPath)) {
    const { BLOCK_FS } = require(path.join(dir, 'host.js'));
    const COMMON = require(path.join(dir, 'os', 'os-common.js'));
    const store = new COMMON.NodeFileStore(fs, imgPath, false);
    baked = COMMON.bakedVersion(BLOCK_FS, store);
    store.close();
    if (baked >= wanted) {
      const inp = COMMON.newestBakeInput(fs, path, dir, manifest);
      if (fs.statSync(imgPath).mtimeMs >= inp.mtimeMs) return;
      why = `v${baked} but input-stale (${path.relative(dir, inp.path)} is newer)`;
    }
  }
  if (!why) why = `${baked < 0 ? 'missing' : 'is v' + baked} < manifest v${wanted}`;
  console.log(`os/os-system.img ${why} — baking…`);
  const r = require('child_process').spawnSync(process.execPath, [mkimagePath], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('mkimage failed — not serving a stale system image');
    process.exit(1);
  }
}
if (!singleFile) ensureSystemImage(root);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = singleFile && url === '/' ? singleFile : path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
});

function tryListen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < preferredPort + 10) {
      tryListen(port + 1);
    } else {
      console.error(err.message);
      process.exit(1);
    }
  });
  server.listen(port);
}

server.once('listening', () => {
  const port = server.address().port;
  // There is no index.html at the repo root, so the bare URL 404s — point
  // at the real entry when serving a tree that contains the OS page.
  const osPage = !singleFile && fs.existsSync(path.join(root, 'os', 'os.html'));
  console.log(`Open http://localhost:${port}${osPage ? '/os/os.html' : ''}`);
});

tryListen(preferredPort);
