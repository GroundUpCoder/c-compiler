// Drive the REAL NetSurf engine (monkey frontend, wasm) over a ladder of
// UTF-8 pages and dump the exact strings it hands to the text plotter.
//
// monkey prints "PLOT TEXT X n Y n STR <text>" — that is the string AFTER
// parse/decode and BEFORE the font layer, so it separates the two candidate
// causes cleanly:
//   * mojibake in STR  -> the document was DECODED wrong (charset selection)
//   * clean UTF-8 STR  -> decode is fine; the mojibake is in the font/glyph layer
//
// Usage: node xp/nscharset/monkey.mjs [wasm]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WASM = process.argv[2] || path.join(ROOT, 'build', 'netsurf-smoke', 'nsmonkey.wasm');
const RES = path.join(ROOT, 'build', 'netsurf-smoke', 'res');

// Sample: "Español" (2-byte seq) and "Tiếng Việt" (3-byte seqs).
const SAMPLE = 'Español | Tiếng Việt';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nscharset-'));
const CASES = [
  { name: 'meta-charset',
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title></head><body><p>${SAMPLE}</p></body></html>` },
  { name: 'http-equiv',
    html: `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>t</title></head><body><p>${SAMPLE}</p></body></html>` },
  { name: 'no-declaration',
    html: `<!DOCTYPE html><html><head><title>t</title></head><body><p>${SAMPLE}</p></body></html>` },
  { name: 'bom',
    html: `﻿<!DOCTYPE html><html><head><title>t</title></head><body><p>${SAMPLE}</p></body></html>` },
];
for (const c of CASES) {
  c.file = path.join(DIR, c.name + '.html');
  fs.writeFileSync(c.file, c.html, 'utf8');   // real UTF-8 bytes on disk
}

const WANT = SAMPLE;

function runCase(c) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'host.js'), WASM], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NETSURFRES: RES + '/' },
    });
    let out = '';
    let win = null, sentRedraw = false, sentQuit = false;
    const send = (l) => { try { child.stdin.write(l + '\n'); } catch {} };
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
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
    send(`WINDOW NEW file://${c.file}`);
  });
}

const hex = (s) => Buffer.from(s, 'utf8').toString('hex').replace(/(..)/g, '$1 ').trim();

console.log(`engine: ${WASM}`);
console.log(`sample: ${JSON.stringify(WANT)}\n        bytes ${hex(WANT)}\n`);

let bad = 0;
for (const c of CASES) {
  const out = await runCase(c);
  const texts = [...out.matchAll(/PLOT TEXT X \d+ Y \d+ STR (.*)/g)].map(m => m[1].replace(/\r$/, ''));
  // the interesting line is the one carrying our sample (or its corruption)
  const line = texts.find(t => /Espa|Ti/.test(t)) ?? '(no text plotted)';
  const ok = line === WANT;
  if (!ok) bad++;
  console.log(`== ${c.name}`);
  console.log(`   plotted : ${JSON.stringify(line)}`);
  console.log(`   bytes   : ${hex(line)}`);
  console.log(`   ${ok ? 'MATCHES the source text' : '*** MISMATCH — decoded wrong ***'}\n`);
}
console.log(bad === 0 ? 'all cases decoded correctly' : `${bad}/${CASES.length} cases decoded WRONG`);
fs.rmSync(DIR, { recursive: true, force: true });
