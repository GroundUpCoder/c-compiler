#!/usr/bin/env node
// NetSurf vendored-tree smoke: build bin.json (monkey frontend) with compiler.js and
// drive the whole browser end-to-end under standalone host.js —
//   load test/hello.html over file:// → parse (hubbub→libdom) → style
//   (libcss) → lay out → PLOT with correct geometry → QUIT clean.
//
//   node vendor/netsurf/smoke.mjs            build + run + assert
//   node vendor/netsurf/smoke.mjs --build    build only (writes the wasm)
//
// The wasm lands at build/netsurf-smoke/nsmonkey.wasm.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

const OUT_DIR = path.join(ROOT, 'build', 'netsurf-smoke');
const WASM = path.join(OUT_DIR, 'nsmonkey.wasm');

// ---- build ----
console.log('building vendor/netsurf/bin.json (592-TU class link)…');
const t0 = Date.now();
const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const bytes = OS_COMMON.buildProject(
  CompilerJS,
  'vendor/netsurf/bin.json',
  (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'),
);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(WASM, bytes);
console.log(`built ${WASM} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (process.argv.includes('--build')) process.exit(0);

// ---- assemble the runtime resource dir (monkey honours ${NETSURFRES}) ----
// The engine needs its resource: stylesheets and Messages to finish a page
// load (a missing default.css sends the load into the about:fetcherror
// path).  These come straight from the vendored resources tree — the same
// files Lane 3 will seed at /usr/share/netsurf in the OS image.
const RES = path.join(OUT_DIR, 'res');
fs.mkdirSync(RES, { recursive: true });
const RSRC = path.join(HERE, 'netsurf', 'resources');
for (const f of ['default.css', 'quirks.css', 'internal.css', 'adblock.css']) {
  fs.copyFileSync(path.join(RSRC, f), path.join(RES, f));
}
fs.copyFileSync(path.join(RSRC, 'Messages.en'), path.join(RES, 'Messages'));

// ---- run: drive the monkey protocol ----
const url = 'file://' + path.join(HERE, 'test', 'hello.html');
const child = spawn(process.execPath, [path.join(ROOT, 'host.js'), WASM], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, NETSURFRES: RES + '/' },
});

let out = '';
let win = null;
let sentRedraw = false;
let sentQuit = false;
const send = (line) => { child.stdin.write(line + '\n'); };

const killTimer = setTimeout(() => {
  console.error('SMOKE FAIL: timeout (60s) — last output:\n' + out.slice(-2000));
  child.kill('SIGKILL');
  process.exit(1);
}, 60_000);

send(`WINDOW NEW ${url}`);

child.stdout.on('data', (buf) => {
  out += buf.toString();
  process.stdout.write(buf);
  // window number from "WINDOW NEW WIN <n> FOR …"
  if (win === null) {
    const m = out.match(/WINDOW NEW WIN (\d+)/);
    if (m) win = m[1];
  }
  // Page finished loading → ask for a full redraw.  The throbber stops
  // once right at window creation, so the load-complete marker is a
  // STOP_THROBBER that comes AFTER the load's START_THROBBER.
  if (win !== null && !sentRedraw) {
    const start = out.indexOf(`START_THROBBER WIN ${win}`);
    if (start >= 0 && out.indexOf(`STOP_THROBBER WIN ${win}`, start) >= 0) {
      sentRedraw = true;
      send(`WINDOW REDRAW ${win}`);
    }
  }
  // redraw frame complete → quit
  if (sentRedraw && !sentQuit && new RegExp(`REDRAW WIN ${win} STOP`).test(out)) {
    sentQuit = true;
    send('QUIT');
  }
});

child.on('exit', (code) => {
  clearTimeout(killTimer);
  const need = [
    /WINDOW NEW WIN \d+/,
    /PLOT RECT X0 \d+ Y0 \d+ X1 \d+ Y1 \d+/,
    /PLOT TEXT X \d+ Y \d+ STR Hello gucOS/,
    /PLOT TEXT X \d+ Y \d+ STR NetSurf vendored smoke test\./,
    new RegExp(`REDRAW WIN ${win} STOP`),
  ];
  const missing = need.filter((re) => !re.test(out));
  if (code === 0 && missing.length === 0) {
    console.log('\nSMOKE PASS: loaded, parsed, styled, laid out, plotted, clean exit');
    process.exit(0);
  }
  console.error(`\nSMOKE FAIL: exit=${code}, missing=${missing.map(String).join(' ')}`);
  process.exit(1);
});
