#!/usr/bin/env node
// os-drive — boot the OS page once and DRIVE it (todos/0171).
//
// The committed replacement for the throwaway boot-type-probe scripts every
// browser-flake investigation hand-builds (and the rakes they step on: a
// forgotten VT switch, a waitOut needle matching its own typed echo, a
// waitForServer too short to survive an image rebake). This is a driving
// layer, not a test tier: no assertions, no runner integration — os-*.mjs
// sweep files stay the acceptance surface.
//
//   node tools/os-drive.mjs                        REPL: poke the live OS
//   node tools/os-drive.mjs <script.mjs> [args…]   scripted: the .mjs default-
//                                                  exports async (drive, args)
// Flags (anywhere on the command line):
//   --port=N          static server port (default 3399)
//   --under-load[=N]  spawn N busy-loop generators (default: one per core) —
//                     the flake-gate contention, toggleable at runtime too
//   --headed          headed Chromium (watch the session live)
//
// The session handle (`drive`) exposes:
//   page/browser/server   raw Playwright + child handles
//   vt(n)                  switch VT (1 tty / 2 desktop) — tracks current
//   type(text, delay)      raw typing into the page (current VT), no Enter
//   sh(cmd)                VT1-aware: switch to VT1 and type cmd + Enter
//   run(cmd, {timeout})    sh(cmd) + a unique split-needle end marker; waits
//                          for it and returns the __osOut delta
//   waitOut(needle, ms)    wait for a tty-mirror needle (throws on timeout)
//   split(marker)          the split-string trick: 'RUN-1' -> 'R""UN-1', so a
//                          typed needle can't satisfy its own wait
//   out(n)                 tail n chars of __osOut (default 2000)
//   sample(x,y)/shot(file) composited pixel / PNG of the desktop canvas
//                          (drawImage read-back — page.screenshot can't see
//                          the worker's WebGPU OffscreenCanvas)
//   wmctl(args, opts)      run('wmctl ' + args) passthrough
//   pause(ms)              plain sleep (diagnostics may pace; tests must not)
//   load(n)/loadStop()     start/stop the busy-loop generators
//   close()                tear down browser + server + load
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { openOsSession } from '../tests/browser/lib/os-harness.mjs';
import { assertSameTree } from '../tests/lib/tree-guard.js';

// Cross-tree preflight (todos/0341, extended by #142): drives its OWN tree's
// serve.js/boot stack (and their bakes). Screenshot writes are caller-path
// relative, but the driven stack is not. Hand-run only — no harness spawns.
assertSameTree(path.dirname(fileURLToPath(import.meta.url)),
  { label: 'tools/os-drive.mjs' });

// ---- CLI ----
const argv = process.argv.slice(2);
let port = 3399, underLoad = 0, headed = false, script = null;
const scriptArgs = [];
for (const a of argv) {
  if (a.startsWith('--port=')) port = parseInt(a.slice(7), 10);
  else if (a === '--under-load') underLoad = -1;
  else if (a.startsWith('--under-load=')) underLoad = parseInt(a.slice(13), 10);
  else if (a === '--headed') headed = true;
  else if (!script) script = a;
  else scriptArgs.push(a);
}

// ---- load generators (the suite-runner/flake-gate pattern: real arithmetic
// so V8 can't fold it, self-healing on orphaning via the ppid check) ----
const loadProcs = new Set();
function load(n) {
  const count = n && n > 0 ? n : os.cpus().length;
  const src = 'const pp=process.ppid,end=Date.now()+3600000;let x=0;' +
    'while(Date.now()<end){for(let i=0;i<2e6;i++)x+=Math.sqrt(i)*1.0000001;if(process.ppid!==pp)break;}' +
    'if(x===Infinity)console.log(x);';
  for (let i = 0; i < count; i++) {
    const p = spawn(process.execPath, ['-e', src], { detached: true, stdio: 'ignore' });
    loadProcs.add(p);
    p.on('exit', () => loadProcs.delete(p));
  }
  console.log(`[drive] load: ${count} generators`);
}
function loadStop() {
  for (const p of loadProcs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } }
  loadProcs.clear();
  console.log('[drive] load: stopped');
}

// ---- boot ----
console.log(`[drive] booting os.html on :${port}${headed ? ' (headed)' : ''}…`);
const t0 = Date.now();
const session = await openOsSession({
  port,
  readyLabel: 'boot: ready',
  // Rebake-tolerant: a stale image means serve.js re-runs mkimage BEFORE
  // listening — up to a few minutes on first run after a host.js touch.
  serverTries: 600, serverInterval: 500,
  browserOpts: headed ? { headless: false } : {},
});
const { page } = session;
console.log(`[drive] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (underLoad !== 0) load(underLoad === -1 ? 0 : underLoad);

// ---- the drive handle ----
let curVt = 2;                       // a healthy boot lands on VT2 (0070)
let markSeq = 0;
const outAll = () => page.evaluate(() => window.__osOut || '');

const drive = {
  page, browser: session.browser, server: session.server,
  helpers: session.helpers,
  split: (s) => s.length > 1 ? s[0] + '""' + s.slice(1) : s,
  vt: async (n) => { await session.setVt(n); curVt = n; },
  type: async (text, delay = 40) => { await page.keyboard.type(text, { delay }); },
  sh: async (cmd, delay = 40) => {
    if (curVt !== 1) await drive.vt(1);
    await page.keyboard.type(cmd + '\r', { delay });
  },
  waitOut: async (needle, ms) => { await session.waitOut(needle, ms); },
  run: async (cmd, { timeout = 20000 } = {}) => {
    const mark = `DRV-${markSeq++}-EOT`;
    const start = (await outAll()).length;
    await drive.sh(`${cmd} ; echo ${drive.split(mark)}`);
    await session.waitOut(mark, timeout);
    const delta = (await outAll()).slice(start);
    return delta.slice(0, delta.indexOf(mark));
  },
  wmctl: (args, opts) => drive.run('wmctl ' + args, opts),
  out: async (n = 2000) => (await outAll()).slice(-n),
  sample: session.sample,
  waitPixel: session.waitPixel,
  waitScreen: session.waitScreen,
  shot: async (file) => {
    const dataUrl = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      const t = document.createElement('canvas');
      t.width = Math.round(r.width); t.height = Math.round(r.height);
      t.getContext('2d').drawImage(c, 0, 0);
      return t.toDataURL('image/png');
    });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`[drive] shot -> ${file}`);
  },
  pause: (ms) => new Promise(r => setTimeout(r, ms)),
  load, loadStop,
  close: async () => { loadStop(); await session.close(); },
};

// ---- scripted mode ----
if (script) {
  const mod = await import(pathToFileURL(path.resolve(script)).href);
  if (typeof mod.default !== 'function') {
    console.error(`[drive] ${script} must default-export async (drive, args) => {}`);
    await drive.close(); process.exit(2);
  }
  let code = 0;
  try { await mod.default(drive, scriptArgs); }
  catch (e) { console.error('[drive] script failed: ' + (e && e.stack || e)); code = 1; }
  await drive.close();
  process.exit(code);
}

// ---- REPL mode ----
// Plain text is typed as a VT1 shell line; ':' commands drive the session.
// New tty-mirror output streams to stdout live (prefixless, raw).
console.log(`[drive] REPL — plain text = VT1 shell line; :help for commands`);
let mirrored = (await outAll()).length;
const mirror = setInterval(async () => {
  try {
    const o = await outAll();
    if (o.length > mirrored) { process.stdout.write(o.slice(mirrored)); mirrored = o.length; }
  } catch {}
}, 300);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const HELP = `  :vt N            switch VT (1 tty / 2 desktop)
  :type TEXT       raw typing on the current VT (no Enter)
  :key KEY         page.keyboard.press (e.g. Escape, Enter, F2)
  :out [N]         dump the last N chars of __osOut (default 2000)
  :sample X Y      composited pixel at (X,Y)
  :shot FILE       PNG of the desktop canvas
  :split MARKER    print the split-needle typed form
  :load [N]        start N busy-loop generators (default: per core)
  :noload          stop them
  :q               quit`;
rl.on('line', async (lineIn) => {
  const line = lineIn.trim();
  try {
    if (!line) return;
    if (!line.startsWith(':')) { await drive.sh(line); return; }
    const [c, ...rest] = line.slice(1).split(/\s+/);
    if (c === 'q' || c === 'quit') { rl.close(); return; }
    else if (c === 'help') console.log(HELP);
    else if (c === 'vt') await drive.vt(parseInt(rest[0], 10));
    else if (c === 'type') await drive.type(lineIn.trim().slice(6));
    else if (c === 'key') await page.keyboard.press(rest[0]);
    else if (c === 'out') { console.log(await drive.out(rest[0] ? parseInt(rest[0], 10) : 2000)); }
    else if (c === 'sample') console.log(await drive.sample(parseInt(rest[0], 10), parseInt(rest[1], 10)));
    else if (c === 'shot') await drive.shot(rest[0] || '/tmp/os-drive-shot.png');
    else if (c === 'split') console.log(drive.split(rest.join(' ')));
    else if (c === 'load') load(rest[0] ? parseInt(rest[0], 10) : 0);
    else if (c === 'noload') loadStop();
    else console.log('unknown command; :help');
  } catch (e) { console.error('[drive] ' + (e && e.message)); }
});
rl.on('close', async () => {
  clearInterval(mirror);
  await drive.close();
  process.exit(0);
});
