// Does the HTTP Content-Type charset actually reach NetSurf?
//
// google.com/search and facebook.com ship NO <meta charset> — the HTTP
// Content-Type header is their ONLY encoding declaration. This serves the
// same document over local HTTP with controlled headers and drives it
// through nsmonkey-http (the monkey frontend + the REAL gucOS http fetcher),
// printing the exact string NetSurf hands the text plotter.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WASM = path.join(ROOT, 'build', 'nscharset', 'nsmonkey-http.wasm');
const RES = path.join(ROOT, 'build', 'netsurf-smoke', 'res');
const PORT = 3391;

const SAMPLE = 'Español | Tiếng Việt';
const NOMETA = `<!DOCTYPE html><html><head><title>t</title></head><body><p>${SAMPLE}</p></body></html>`;
const WITHMETA = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><p>${SAMPLE}</p></body></html>`;

// name -> [Content-Type header value, body]
const ROUTES = {
  // THE case: header declares utf-8, document declares nothing.
  '/hdr-charset':  ['text/html; charset=utf-8', NOMETA],
  // Facebook's literal spelling — a QUOTED charset value.
  '/hdr-quoted':   ['text/html; charset="utf-8"', NOMETA],
  // Google's literal spelling — uppercase, unquoted.
  '/hdr-upper':    ['text/html; charset=UTF-8', NOMETA],
  // Control: no charset anywhere. Falling back is CORRECT here.
  '/hdr-none':     ['text/html', NOMETA],
  // Control: no header charset, but the document declares it.
  '/meta-only':    ['text/html', WITHMETA],
};

const server = http.createServer((req, res) => {
  const r = ROUTES[req.url];
  if (!r) { res.writeHead(404); res.end(); return; }
  const body = Buffer.from(r[1], 'utf8');
  res.writeHead(200, { 'content-type': r[0], 'content-length': body.length });
  res.end(body);
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

function runCase(url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'host.js'), WASM], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NETSURFRES: RES + '/' },
    });
    let out = '', err = '';
    let win = null, sentRedraw = false, sentQuit = false;
    const send = (l) => { try { child.stdin.write(l + '\n'); } catch {} };
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.stdout.on('data', (b) => {
      out += b.toString('utf8');
      if (win === null) { const m = out.match(/WINDOW NEW WIN (\d+)/); if (m) win = m[1]; }
      if (win !== null && !sentRedraw) {
        const s = out.indexOf(`START_THROBBER WIN ${win}`);
        if (s >= 0 && out.indexOf(`STOP_THROBBER WIN ${win}`, s) >= 0) {
          sentRedraw = true; send(`WINDOW REDRAW ${win}`);
        }
      }
      if (sentRedraw && !sentQuit && new RegExp(`REDRAW WIN ${win} STOP`).test(out)) {
        sentQuit = true; send('QUIT');
      }
    });
    child.on('exit', () => { clearTimeout(timer); resolve({ out, err }); });
    send(`WINDOW NEW ${url}`);
  });
}

const hex = (s) => Buffer.from(s, 'utf8').toString('hex').replace(/(..)/g, '$1 ').trim();
console.log(`sample: ${JSON.stringify(SAMPLE)}\n`);

let bad = [];
for (const route of Object.keys(ROUTES)) {
  const { out } = await runCase(`http://127.0.0.1:${PORT}${route}`);
  const texts = [...out.matchAll(/PLOT TEXT X \d+ Y \d+ STR (.*)/g)].map(m => m[1].replace(/\r$/, ''));
  const line = texts.find(t => /Espa|Ti/.test(t)) ?? '(nothing plotted)';
  const ok = line === SAMPLE;
  const expectFallback = route === '/hdr-none';
  console.log(`== ${route}   [Content-Type: ${ROUTES[route][0]}]`);
  console.log(`   plotted : ${JSON.stringify(line)}`);
  if (!ok && !expectFallback) { console.log('   *** WRONG — the declared charset was NOT honoured ***'); bad.push(route); }
  else if (!ok && expectFallback) console.log('   (fallback — correct: nothing declared the charset)');
  else console.log('   correct');
  console.log('');
}
server.close();
console.log(bad.length ? `BROKEN: ${bad.join(', ')}` : 'all declared charsets honoured');
