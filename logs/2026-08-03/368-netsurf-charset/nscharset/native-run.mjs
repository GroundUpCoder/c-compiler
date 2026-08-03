// Run NATIVE NetSurf (upstream monkey frontend + upstream libcurl fetcher,
// built on the Mac Mini from the same vendored sources) over the charset
// ladder — including the two real pages jku saw garbled.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(ROOT, 'build', 'nscharset', 'nsmonkey-native');
const PORT = 3393;

const SAMPLE = 'Español | Tiếng Việt';
const NOMETA = `<!DOCTYPE html><html><head><title>t</title></head><body><p>${SAMPLE}</p></body></html>`;
const WITHMETA = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><p>${SAMPLE}</p></body></html>`;

const ROUTES = {
  '/hdr-charset': ['text/html; charset=utf-8', NOMETA],
  '/hdr-quoted':  ['text/html; charset="utf-8"', NOMETA],
  '/hdr-upper':   ['text/html; charset=UTF-8', NOMETA],
  '/hdr-none':    ['text/html', NOMETA],
  '/meta-only':   ['text/html', WITHMETA],
};
const server = http.createServer((req, res) => {
  const r = ROUTES[req.url];
  if (!r) { res.writeHead(404); res.end(); return; }
  const body = Buffer.from(r[1], 'utf8');
  res.writeHead(200, { 'content-type': r[0], 'content-length': body.length });
  res.end(body);
});
await new Promise(ok => server.listen(PORT, '127.0.0.1', ok));

// A file:// control too (no headers at all).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nsnat-'));
fs.writeFileSync(path.join(DIR, 'meta.html'), WITHMETA, 'utf8');
fs.writeFileSync(path.join(DIR, 'bare.html'), NOMETA, 'utf8');

const CASES = [
  { label: 'file:// with <meta charset>',        url: 'file://' + path.join(DIR, 'meta.html'), want: SAMPLE },
  { label: 'file:// with NO declaration',        url: 'file://' + path.join(DIR, 'bare.html'), want: null },
  { label: 'http header charset, no meta',       url: `http://127.0.0.1:${PORT}/hdr-charset`, want: SAMPLE },
  { label: 'http header charset QUOTED, no meta',url: `http://127.0.0.1:${PORT}/hdr-quoted`,  want: SAMPLE },
  { label: 'http header charset UPPER, no meta', url: `http://127.0.0.1:${PORT}/hdr-upper`,   want: SAMPLE },
  { label: 'http NO charset anywhere',           url: `http://127.0.0.1:${PORT}/hdr-none`,    want: null },
  { label: 'http no header charset, meta only',  url: `http://127.0.0.1:${PORT}/meta-only`,   want: SAMPLE },
  { label: 'REAL google.com (landing)',          url: 'https://www.google.com', real: true },
  { label: 'REAL google.com/search?q=español',   url: 'https://www.google.com/search?q=espa%C3%B1ol', real: true },
  { label: 'REAL facebook.com',                  url: 'https://www.facebook.com', real: true },
];

function run(url) {
  return new Promise((resolve) => {
    const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let win = null, sentRedraw = false, sentQuit = false;
    const send = (l) => { try { child.stdin.write(l + '\n'); } catch {} };
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stderr.on('data', () => {});
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
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
    send(`WINDOW NEW ${url}`);
  });
}

// Mojibake detector: UTF-8 read as Windows-1252 always leaves these pairs.
const MOJI = /Ã.|Â.|á»|áº|â€/;

console.log(`native binary: ${BIN}`);
console.log(`sample       : ${JSON.stringify(SAMPLE)}\n`);

for (const c of CASES) {
  const out = await run(c.url);
  const texts = [...out.matchAll(/PLOT TEXT X \d+ Y \d+ STR (.*)/g)].map(m => m[1].replace(/\r$/, ''));
  console.log(`== ${c.label}`);
  if (c.real) {
    const moji = texts.filter(t => MOJI.test(t));
    console.log(`   ${texts.length} text runs plotted, ${moji.length} showing mojibake`);
    if (moji.length) console.log(`   e.g. ${JSON.stringify(moji.slice(0, 3))}`);
    else console.log(`   sample runs: ${JSON.stringify(texts.filter(t => t.trim()).slice(0, 3))}`);
  } else {
    const line = texts.find(t => /Espa|Ti/.test(t)) ?? '(nothing plotted)';
    const ok = line === SAMPLE;
    console.log(`   plotted : ${JSON.stringify(line)}`);
    if (c.want === null) console.log(`   ${ok ? 'decoded UTF-8' : 'fell back to Windows-1252'} (expected: fallback)`);
    else console.log(`   ${ok ? 'CORRECT' : '*** WRONG — declared charset ignored ***'}`);
  }
  console.log('');
}
server.close();
fs.rmSync(DIR, { recursive: true, force: true });
