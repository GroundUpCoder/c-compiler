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
  console.log(`Open http://localhost:${server.address().port}`);
});

tryListen(preferredPort);
