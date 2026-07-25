#!/usr/bin/env node
// Lane B spike: danger-zone probes for live re-conversion.
//
// Drives test/spike-danger.html via monkey WINDOW CLICK (real hit-tested
// clicks onto onclick spans — WINDOW EXEC acks but never executes in this
// vendored snapshot, verified pre-existing on the unpatched baseline).
// Probes, in order:
//   1. repeated JS-driven re-boxes; form gadget values must survive
//   2. radio-group interaction after re-boxes (gadget re-bind by node)
//   3. input.value set from JS survives the next re-box
//   4. text selection (triple-click) across a re-box
//   5. imagemap click-through after re-boxes (re-extracted hash)
//   6. LAST, expected-hazard: display:none the CHECKED radio's row, re-box,
//      click the other radio — form_radio_set has no NULL-box guard.
//
//   node vendor/netsurf/spike-danger.mjs

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(ROOT, 'build', 'netsurf-smoke');
const WASM = path.join(OUT_DIR, 'nsmonkey.wasm');

const RES = path.join(OUT_DIR, 'res');
fs.mkdirSync(RES, { recursive: true });
const RSRC = path.join(HERE, 'netsurf', 'resources');
for (const f of ['default.css', 'quirks.css', 'internal.css', 'adblock.css']) {
  fs.copyFileSync(path.join(RSRC, f), path.join(RES, f));
}
fs.copyFileSync(path.join(RSRC, 'Messages.en'), path.join(RES, 'Messages'));

const url = 'file://' + path.join(HERE, 'test', 'spike-danger.html');
const child = spawn(process.execPath, [path.join(ROOT, 'host.js'), WASM, '--enable_javascript=1'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, NETSURFRES: RES + '/' },
});

let out = '';
let pos = 0;
let exited = null;
child.on('exit', (code, sig) => { exited = { code, sig }; });
child.stdout.on('data', (buf) => { out += buf.toString(); });
const send = (line) => { if (!exited) child.stdin.write(line + '\n'); };
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const finish = (fatal) => {
  try { fs.writeFileSync(path.join(OUT_DIR, 'danger-transcript.txt'), out); } catch {}
  console.log('\n=== danger probe summary ===');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  if (fatal) console.log(`FATAL: ${fatal}`);
  process.exit(results.every((r) => r.ok) && !fatal ? 0 : 1);
};
const killTimer = setTimeout(() => {
  console.error('global timeout; last output:\n' + out.slice(-2000));
  finish('global timeout');
}, 120_000);

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
      } else if (exited || Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        if (!exited) console.error(`timeout waiting for ${what}; tail:\n` + out.slice(-1200));
        resolve(null);
      }
    }, 20);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureFrame(win) {
  send(`WINDOW REDRAW ${win}`);
  const st = await waitFor(new RegExp(`REDRAW WIN ${win} START`), 'redraw start');
  if (!st) return null;
  const frameStart = pos;
  const sp = await waitFor(new RegExp(`REDRAW WIN ${win} STOP`), 'redraw stop');
  if (!sp) return null;
  return out.slice(frameStart, pos);
}
const textAt = (frame, str) => {
  const m = frame && frame.match(new RegExp(`PLOT TEXT X (\\d+) Y (\\d+) STR ${str}`));
  return m ? { x: +m[1], y: +m[2] } : null;
};
// click just above the text baseline, inside the glyph run
const clickText = (win, at, dx = 8, dy = -5) =>
  send(`WINDOW CLICK WIN ${win} X ${at.x + dx} Y ${at.y + dy} BUTTON LEFT KIND SINGLE`);

send(`WINDOW NEW ${url}`);
const mWin = await waitFor(/WINDOW NEW WIN (\d+)/, 'window');
const win = mWin[1];
await waitFor(new RegExp(`START_THROBBER WIN ${win}`), 'load start');
await waitFor(new RegExp(`STOP_THROBBER WIN ${win}`), 'load complete');
await sleep(100);

// --- baseline frame: geometry + everything renders ---
const f0 = await captureFrame(win);
if (!f0) finish('no baseline frame');
const tMut = textAt(f0, 'MUTATE');
const tVal = textAt(f0, 'SETVAL');
const tHide = textAt(f0, 'HIDEROW');
const bbbb = textAt(f0, 'BBBB');
const selp = textAt(f0, 'Selectable');
const bmp = f0.match(/PLOT BITMAP X (\d+) Y (\d+) WIDTH 64 HEIGHT 64/);
record('baseline: triggers/form/img/text all plotted',
  !!(tMut && tVal && tHide && bbbb && selp && bmp && textAt(f0, 'hello') && textAt(f0, 'two') && textAt(f0, 'S0')));
if (!tMut) finish('no MUTATE trigger — cannot drive anything');

// NB: upstream monkey CLICK dispatches the DOM click TWICE (press+click
// both fire; reproduced on the unpatched baseline) — handlers run 2x per
// injected click, so the mutation counter advances by 2 per click.
let mutSeen = 0;
async function mutClick() {
  clickText(win, tMut);
  mutSeen += 2;
  const m = await waitFor(new RegExp(`LOG MUT ${mutSeen}\\b`), `mutation ${mutSeen}`, 8000);
  await sleep(150); // coalesced reconvert + reformat + invalidate
  return !!m;
}

// --- probe 1: three click-driven re-boxes ---
for (let i = 1; i <= 3; i++) {
  if (!(await mutClick())) record(`mutation click ${i} ran`, false, 'handler never fired');
}
const f1 = await captureFrame(win);
record('3 re-boxes: mutated status repainted', !!textAt(f1, `S${mutSeen}`));
record('3 re-boxes: input value survives gadget re-bind', !!textAt(f1, 'hello'));
record('3 re-boxes: select still renders DOM-selected option', !!textAt(f1, 'two'));
record('3 re-boxes: trigger rows still hit-testable (same geometry)',
  JSON.stringify(textAt(f1, 'MUTATE')) === JSON.stringify(tMut));

// --- probe 2: radio group interaction AFTER re-boxes ---
clickText(win, bbbb, -12, -5); // the radio circle sits left of the label
const rb = await waitFor(/RBCLICK checked=(true|false)/, 'radio click handler', 8000);
record('radio B click after re-boxes reaches gadget + JS (group iteration over rebound gadgets)',
  !!rb && rb[1] === 'true' && !exited, rb ? `checked=${rb[1]}` : 'handler never fired');

// --- probe 3: JS sets input.value, then re-box, repaint shows it ---
clickText(win, tVal);
await waitFor(/LOG VALSET/, 'value-set handler', 8000);
await sleep(80);
await mutClick(); // force a re-box
const f2 = await captureFrame(win);
record('JS-set input.value survives the NEXT re-box (DOM is source of truth)',
  !!textAt(f2, 'world'), textAt(f2, 'world') ? '' : 'world not plotted');

// --- probe 4: text selection across a re-box ---
send(`WINDOW CLICK WIN ${win} X ${selp.x + 20} Y ${selp.y - 5} BUTTON LEFT KIND TRIPLE`);
await sleep(150);
const selMutOk = await mutClick(); // re-box with a live selection
const f3 = await captureFrame(win);
record('selection then re-box: no crash, still renders',
  selMutOk && !!f3 && !exited && !!textAt(f3, `S${mutSeen}`),
  exited ? `DIED ${JSON.stringify(exited)}` : '');

// --- probe 5: imagemap click-through after re-boxes ---
const cx = +bmp[1] + 32, cy = +bmp[2] + 32;
send(`WINDOW CLICK WIN ${win} X ${cx} Y ${cy} BUTTON LEFT KIND SINGLE`);
const nav = await waitFor(/area-hit\.html/, 'imagemap navigation', 8000);
record('imagemap routes clicks after re-boxes (re-extract works)', !!nav && !exited);

// --- probe 6 (LAST, expected-hazard): hide checked radio row, click other ---
await sleep(500); // let the failed navigation settle
send(`WINDOW GO ${win} ${url}`);
await waitFor(new RegExp(`START_THROBBER WIN ${win}`), 'reload start', 8000);
await waitFor(new RegExp(`STOP_THROBBER WIN ${win}`), 'reload complete', 8000);
await sleep(150);
const f4 = await captureFrame(win);
const tHide2 = textAt(f4, 'HIDEROW');
const bbbb2 = textAt(f4, 'BBBB');
if (tHide2 && bbbb2) {
  clickText(win, tHide2);
  await waitFor(/LOG HID/, 'hide handler', 8000);
  await sleep(200); // re-box: checked radio A loses its box
  // the hidden row above BBBB shifted the layout — recapture geometry
  const f5 = await captureFrame(win);
  const bbbb3 = textAt(f5, 'BBBB') || bbbb2;
  clickText(win, bbbb3, -12, -5);
  await sleep(500);
  if (exited) {
    record('display:none checked radio + group click (KNOWN NULL-box hazard in form_radio_set)',
      false, `process died: ${JSON.stringify(exited)} — needs a NULL guard (2-line full-lane fix)`);
  } else {
    const rb2 = await waitFor(/RBCLICK checked=true/, 'radio B post-hide', 5000);
    record('display:none checked radio + group click (KNOWN NULL-box hazard in form_radio_set)',
      !!rb2 && !exited, rb2 ? 'survived' : 'no handler fired (click missed?)');
  }
} else {
  record('probe 6 setup (reload + geometry)', false, 'HIDEROW/BBBB not found after reload');
}

// --- clean shutdown ---
if (!exited) {
  send('QUIT');
  const t0 = Date.now();
  while (!exited && Date.now() - t0 < 10_000) await sleep(50);
}
record('clean exit', !!exited && exited.code === 0, JSON.stringify(exited));
clearTimeout(killTimer);
finish(null);
