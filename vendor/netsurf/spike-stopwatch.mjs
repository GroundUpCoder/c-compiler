#!/usr/bin/env node
// Lane B spike driver: does live DOM mutation become VISIBLE?
//
// Loads test/stopwatch.html (demo 4: setInterval writes a counter into a
// <span> via textContent) in the JS-enabled monkey build and asserts that
// successive WINDOW REDRAW frames plot an INCREASING counter — i.e. the
// mutation -> re-box -> reflow -> repaint bridge works end to end.
//
//   node vendor/netsurf/spike-stopwatch.mjs             build + run
//   node vendor/netsurf/spike-stopwatch.mjs --no-build  reuse existing wasm
//   node vendor/netsurf/spike-stopwatch.mjs --wasm=PATH drive a specific wasm
//   node vendor/netsurf/spike-stopwatch.mjs --expect-static
//       assert the OPPOSITE (baseline builds: counter stays 0) — used to
//       prove the A/B delta honestly.

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
let WASM = path.join(OUT_DIR, 'nsmonkey.wasm');
const EXPECT_STATIC = process.argv.includes('--expect-static');
for (const a of process.argv) {
  if (a.startsWith('--wasm=')) WASM = path.resolve(a.slice(7));
}

if (!process.argv.includes('--no-build') && !process.argv.some(a => a.startsWith('--wasm='))) {
  console.log('building vendor/netsurf/bin.json…');
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
  console.log(`built ${WASM} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// resource dir (same as smoke.mjs)
const RES = path.join(OUT_DIR, 'res');
fs.mkdirSync(RES, { recursive: true });
const RSRC = path.join(HERE, 'netsurf', 'resources');
for (const f of ['default.css', 'quirks.css', 'internal.css', 'adblock.css']) {
  fs.copyFileSync(path.join(RSRC, f), path.join(RES, f));
}
fs.copyFileSync(path.join(RSRC, 'Messages.en'), path.join(RES, 'Messages'));

const url = 'file://' + path.join(HERE, 'test', 'stopwatch.html');
const child = spawn(process.execPath,
  [path.join(ROOT, 'host.js'), WASM, '--enable_javascript=1'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, NETSURFRES: RES + '/' },
  });

let out = '';
let pos = 0; // consumed-up-to marker for waitFor
const send = (line) => { child.stdin.write(line + '\n'); };
const fail = (msg) => {
  console.error(`\nSPIKE FAIL: ${msg}\n--- last output ---\n${out.slice(-3000)}`);
  child.kill('SIGKILL');
  process.exit(1);
};
const killTimer = setTimeout(() => fail('global timeout (90s)'), 90_000);

child.stdout.on('data', (buf) => { out += buf.toString(); });

// wait until re after `pos`, advance pos past the match
function waitFor(re, what, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      re.lastIndex = 0;
      const m = re.exec(out.slice(pos));
      if (m) {
        clearInterval(iv);
        pos += m.index + m[0].length;
        resolve(m);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        fail(`timeout waiting for ${what} (${re})`);
      }
    }, 20);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// capture one full redraw frame; returns the frame text
async function captureFrame(win) {
  send(`WINDOW REDRAW ${win}`);
  await waitFor(new RegExp(`REDRAW WIN ${win} START`), 'redraw start');
  const frameStart = pos;
  await waitFor(new RegExp(`REDRAW WIN ${win} STOP`), 'redraw stop');
  return out.slice(frameStart, pos);
}

// the counter is the PLOT TEXT run for the span (a standalone number)
function counterOf(frame) {
  const nums = [...frame.matchAll(/PLOT TEXT X \d+ Y \d+ STR (\d+)\s*$/gm)]
    .map((m) => parseInt(m[1], 10));
  return nums.length ? Math.max(...nums) : null;
}

send(`WINDOW NEW ${url}`);
const mWin = await waitFor(/WINDOW NEW WIN (\d+)/, 'window creation');
const win = mWin[1];
await waitFor(new RegExp(`START_THROBBER WIN ${win}`), 'load start');
await waitFor(new RegExp(`STOP_THROBBER WIN ${win}`), 'load complete');

// JS must actually be running (ticks arrive on the console)
await waitFor(/TICK 1\b/, 'first JS tick (is JS enabled?)');

const frame1 = await captureFrame(win);
const c1 = counterOf(frame1);
console.log(`frame 1 counter: ${c1}`);
if (c1 === null) fail('frame 1: no counter text plotted at all');
if (!/PLOT TEXT .* STR Elapsed:/.test(frame1)) fail('frame 1: page text missing');

// let a few more ticks land, then look for mutation-driven invalidation
const afterFrame1 = out.length; // only invalidations from HERE are mutation-driven
await waitFor(/TICK 4\b/, 'tick 4');
await sleep(200); // let the coalesced reconvert + invalidate drain

const sawInvalidate = /INVALIDATE_AREA WIN|WINDOW INVALIDATE/.test(out.slice(afterFrame1));

const frame2 = await captureFrame(win);
const c2 = counterOf(frame2);
console.log(`frame 2 counter: ${c2} (content-driven invalidate seen: ${sawInvalidate})`);

await waitFor(/TICK 8\b/, 'tick 8');
await sleep(200);
const frame3 = await captureFrame(win);
const c3 = counterOf(frame3);
console.log(`frame 3 counter: ${c3}`);

send('QUIT');
child.on('exit', (code) => {
  clearTimeout(killTimer);
  if (EXPECT_STATIC) {
    // baseline: mutation must be INVISIBLE (counter pinned at 0)
    if (c2 === 0 && c3 === 0 && code === 0) {
      console.log('\nSPIKE BASELINE CONFIRMED: counter never repaints (0, 0) — mutation invisible without the bridge');
      process.exit(0);
    }
    console.error(`\nSPIKE BASELINE UNEXPECTED: counters ${c1}/${c2}/${c3}, exit=${code} — baseline is NOT static?!`);
    process.exit(1);
  }
  if (code !== 0) fail(`nonzero exit ${code}`);
  if (!(c2 > 0 && c3 > c2)) {
    fail(`counter did not advance across frames: ${c1} -> ${c2} -> ${c3}`);
  }
  if (!sawInvalidate) {
    fail('no content-driven INVALIDATE_AREA observed (repaint was only redraw-forced)');
  }
  console.log(`\nSPIKE PASS: live DOM mutation repaints — counter ${c1} -> ${c2} -> ${c3}, clean exit`);
  process.exit(0);
});
