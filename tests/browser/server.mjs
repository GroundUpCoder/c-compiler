// Minimal static file server for the browser tests. Serves files from
// ./www/ with the right MIME types and cross-origin isolation headers
// so OPFS, SharedArrayBuffer, and JSPI all work in headless Chromium.
//
// Usage: `node server.mjs [port]`  (default port: 3175)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'www');
const PORT = parseInt(process.argv[2] || '3175', 10);

const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.mjs':   'application/javascript; charset=utf-8',
  '.wasm':  'application/wasm',
  '.pak':   'application/octet-stream',
  '.png':   'image/png',
  '.css':   'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Cross-origin isolation — required for OPFS sync access handles and
  // SharedArrayBuffer to work in Chromium.
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/quake.html';

  const filePath = path.join(ROOT, urlPath);
  // Block path-escape attempts.
  if (!filePath.startsWith(ROOT)) { res.statusCode = 403; return res.end('forbidden'); }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; return res.end('not found: ' + urlPath); }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}/ — serving ${ROOT}`);
});

// Graceful shutdown so Playwright can stop us between runs.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
