#!/usr/bin/env node
// os-drive-headless — boot the OS headless (os/boot.js) and DRIVE the live
// session (ticket #421; the headless-node investigation's Stage 1, report
// meta/gucos/notes/headless-node-architecture-2026-08-02.md §3).
//
// The headless sibling of tools/os-drive.mjs: the same "driving layer, not a
// test tier" contract — no assertions, no runner integration; the kernel
// e2es (tests/kernel/lib/drive.js driveBoot) stay the acceptance surface.
// Where driveBoot is a BATCH driver (one script in, one transcript out, one
// process per session), this is a SESSION driver: one live boot.js child,
// commands interleaved with reads, screenshots and file transfer on the
// running OS — what every investigation/dogfood round hand-rolls otherwise.
//
//   node tools/os-drive-headless.mjs                      REPL on a live OS
//   node tools/os-drive-headless.mjs <script.mjs> [args…] scripted: the .mjs
//                                                default-exports async (drive, args)
// Flags (anywhere on the command line; everything after `--` goes to boot.js):
//   --image=PATH      reuse/persist this system image (the warm-boot path —
//                     ~150ms vs seconds for a fresh install). Default: a fresh
//                     throwaway image in an owned tmpdir, removed at exit.
//   --keep-image      keep the throwaway image dir and print its path
//   --timeout=MS      default run() timeout (default 20000)
//   --under-load[=N]  spawn N busy-loop generators (default: one per core)
//   --boot=ARG        extra boot.js flag, repeatable (e.g. --boot=--screen=800x500)
//
// The session handle (`drive`) exposes:
//   child/image            raw child process + the image path in use
//   sh(cmd)                write one shell line (fire and forget)
//   type(text)             raw bytes to the tty, no newline
//   run(cmd, {timeout, allowWaitTimeout}) -> {out, status}
//                          marker-synced: waits for completion, returns the
//                          stdout delta and the command's exit status
//   wmctl(args, opts)      run('wmctl ' + args) passthrough
//   waitOut/waitErr(needle, ms)  wait for a needle in stdout/stderr
//   out(n)/err(n)          tail n chars of accumulated stdout/stderr
//   readFile(osPath)       -> Buffer: exact bytes of an in-OS file (byte-count
//                          verified; base64 transport under --tty-out)
//   putFile(osPath, data)  write a Buffer/string INTO the OS (base64 chunks
//                          through the tty; byte-count verified)
//   screen()               -> {w, h, rgb}: the CPU-composited desktop
//                          (wmctl shot screen — a fresh composite per call)
//   shot(file, {target})   PNG (or raw .ppm) of the screen or one surface SID
//   sample(x, y)           -> {r, g, b} of one composited screen pixel
//   pause(ms)              plain sleep (diagnostics may pace; tests must not)
//   load(n)/loadStop()     start/stop the busy-loop generators
//   waitExit(ms)/close()   wait for / trigger session end (EOF -> init exit)
//
// Deliberately ABSENT vs the Playwright sibling (API honesty — these are
// browser semantics with no headless truth to expose, per the report §1.2/§2-D):
//   - vt(n): headless has no VTs. The tty IS stdio; VT2 is the only screen.
//   - page/browser/server, waitPixel/waitScreen on a live canvas: no page.
//     sample()/screen() composite on demand instead (bit-exact, but a full
//     wmScreenshotScreen per call — poll sparingly).
//   - Compositor furniture (shadows/corners/glass/animations) never appears
//     in headless composites; that is the standing wmScreenshotScreen scope.
//
// Programmatic use (what dogfood rounds should reach for):
//   import { openHeadlessSession } from '../tools/os-drive-headless.mjs';
//   const drive = await openHeadlessSession({ image, bootArgs: ['--screen=800x500'] });
//   try { ... } finally { await drive.close(); }
//
// boot.js joins the machine-wide heavy-test lock (todos/0342): when another
// heavy job owns the host this exits 3 and names the holder — that is a
// refusal, not a failure. Pass --boot=--wait-lock to wait loudly instead.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT = path.join(ROOT, 'os/boot.js');
const { parsePpm, encodePng } = require(path.join(ROOT, 'tests/lib/png.js'));
const { mkdtempOwned, untrack } = require(path.join(ROOT, 'tests/lib/harness-temp.js'));

/* ---- helpers ---- */
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// The split-needle trick ('==RD-1' -> '==R""D-1'): under --tty-out the typed
// line is echoed, so a marker literal in the command would satisfy its own
// wait. hush concatenates the quoted halves; the echo shows the split form.
const split = (s) => s.length > 1 ? s[0] + '""' + s.slice(1) : s;
const WAIT_TIMEOUT_RE = /wmctl: wait .* timed out after \d+ms/g;

// Accumulating byte buffer with lazy flatten + ASCII needle search.
class OutBuf {
  constructor() { this.chunks = []; this.len = 0; this._flat = null; }
  push(b) { this.chunks.push(b); this.len += b.length; this._flat = null; }
  flat() {
    if (!this._flat) this._flat = this.chunks.length === 1
      ? this.chunks[0] : Buffer.concat(this.chunks);
    return this._flat;
  }
  indexOf(needle, from = 0) { return this.len ? this.flat().indexOf(needle, from) : -1; }
  slice(a, b) { return this.flat().subarray(a, b); }
  tail(n) { return this.flat().toString('latin1', Math.max(0, this.len - n)); }
}

/* ---- the session ---- */
// opts: image, bootArgs=[], readyTimeout=300000 (a cold image installs or even
// bakes before the first prompt), runTimeout=20000, keepImage=false,
// echoOutput=false (mirror child stdout/stderr to ours as it streams).
export async function openHeadlessSession(opts = {}) {
  const bootArgs = opts.bootArgs || [];
  const ttyOut = bootArgs.includes('--tty-out');
  const runTimeout = opts.runTimeout || 20000;
  let imageDir = null, image = opts.image;
  if (!image) {
    imageDir = mkdtempOwned('os-drive-');
    image = path.join(imageDir, 'os.img');
    if (opts.keepImage) untrack(imageDir);
  }

  const child = spawn('node', [BOOT, '--image=' + image, '--quiet', ...bootArgs],
                      { stdio: ['pipe', 'pipe', 'pipe'] });
  const sout = new OutBuf(), serr = new OutBuf();
  const waiters = new Set();
  let exited = null;          // {code, signal} once the child is gone
  let errScanned = 0;         // stderr offset already checked for wait-timeouts
  let seq = 0;

  const checkWaiters = () => {
    for (const w of [...waiters]) {
      const r = w.predicate();
      if (r !== false) { waiters.delete(w); clearTimeout(w.timer); w.resolve(r); }
    }
  };
  const failWaiters = (err) => {
    for (const w of [...waiters]) { waiters.delete(w); clearTimeout(w.timer); w.reject(err); }
  };
  child.stdout.on('data', (b) => {
    sout.push(b);
    if (opts.echoOutput) process.stdout.write(b);
    checkWaiters();
  });
  child.stderr.on('data', (b) => {
    serr.push(b);
    if (opts.echoOutput) process.stderr.write(b);
    checkWaiters();
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    // Late data may still be buffered; settle pending waiters on the next tick
    // so their error can carry the final stderr tail. Waiters whose predicate
    // is satisfied by the exit itself (waitExit) resolve, the rest reject.
    setImmediate(() => {
      checkWaiters();
      failWaiters(sessionError(
        `boot.js exited (code=${code} signal=${signal}) with waits pending`));
    });
  });
  child.on('error', (e) => failWaiters(e));

  const sessionError = (msg) => new Error(
    `os-drive-headless: ${msg}\n--- stdout tail ---\n${sout.tail(1500)}` +
    `\n--- stderr tail ---\n${serr.tail(1500)}`);

  // One waiter: resolve when predicate() !== false, reject after ms. The
  // predicate is evaluated FIRST so an already-satisfied wait (waitExit on a
  // dead child, a needle already in the buffer) resolves even post-exit.
  const await_ = (predicate, ms, label) => new Promise((resolve, reject) => {
    const first = predicate();
    if (first !== false) return resolve(first);
    if (exited) return reject(sessionError(
      `${label}: session already exited (code=${exited.code} signal=${exited.signal})`));
    const w = { predicate, resolve, reject };
    w.timer = setTimeout(() => {
      waiters.delete(w);
      reject(sessionError(`${label}: timed out after ${ms}ms`));
    }, ms);
    waiters.add(w);
  });

  // The loud-symptom gate (todos/0171, driveBoot parity): a `wmctl wait` that
  // burns its clock prints to stderr and sails on — surface it as a throw.
  const scanWaitTimeouts = (allow) => {
    const fresh = serr.slice(errScanned).toString('latin1');
    errScanned = serr.len;
    const hits = fresh.match(WAIT_TIMEOUT_RE);
    if (hits && !allow) {
      throw sessionError('wmctl wait timed out (a wait on an unreachable ' +
        'condition — root-cause it, do not lengthen the timeout):\n  ' +
        Array.from(new Set(hits)).join('\n  '));
    }
  };

  // stdin writes with backpressure (putFile pushes megabytes of base64).
  const write = (data) => new Promise((resolve, reject) => {
    if (exited) return reject(sessionError('write: session already exited'));
    if (child.stdin.write(data)) resolve();
    else child.stdin.once('drain', resolve);
  });

  // The tty is ONE serial channel — interleaved marker exchanges would read
  // each other's output, so every synced op goes through this queue.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  const drive = {
    child, image, ttyOut,
    get exited() { return exited; },

    out: (n = 2000) => sout.tail(n),
    err: (n = 2000) => serr.tail(n),
    type: (text) => write(text),
    sh: (cmd) => write(cmd + '\n'),
    pause: (ms) => new Promise((r) => setTimeout(r, ms)),

    waitOut: (needle, ms = runTimeout) =>
      await_(() => sout.indexOf(needle) >= 0 || false, ms, `waitOut(${JSON.stringify(needle)})`),
    waitErr: (needle, ms = runTimeout) =>
      await_(() => serr.indexOf(needle) >= 0 || false, ms, `waitErr(${JSON.stringify(needle)})`),

    // Marker-synced command: returns {out, status}. `out` is the stdout delta
    // from send to completion — on a shared tty it also carries any late
    // output of earlier fire-and-forget sh() lines (inherent to a session).
    run: (cmd, { timeout = runTimeout, allowWaitTimeout = false } = {}) => serial(async () => {
      const mark = `DRV-${seq++}-EOT:`;
      const from = sout.len;
      await write(`${cmd}; echo ${split(mark)}$?\n`);
      const at = await await_(() => {
        const i = sout.indexOf(mark, from);
        if (i < 0) return false;
        const nl = sout.indexOf('\n', i);        // status digits still in flight?
        return nl < 0 ? false : { i, nl };
      }, timeout, `run(${JSON.stringify(cmd)})`);
      const status = parseInt(sout.slice(at.i + mark.length, at.nl).toString(), 10);
      scanWaitTimeouts(allowWaitTimeout);
      return { out: sout.slice(from, at.i).toString('latin1'), status };
    }),
    wmctl: (args, o) => drive.run('wmctl ' + args, o),

    // Exact bytes of an in-OS file. Clean mode (default): raw `cat` between a
    // start marker and a byte-count-computed end marker — the end marker is
    // VERIFIED at offset, never searched, so binary content can't fake it.
    // --tty-out mode: fd 1 is tty-kind (ONLCR mangles binary), so transport is
    // `base64` text, whitespace-stripped, still byte-count verified.
    readFile: (osPath, { timeout = 60000 } = {}) => serial(async () => {
      const wc = await rawRun(`wc -c < ${sq(osPath)}`, timeout);
      if (wc.status !== 0) throw sessionError(
        `readFile(${osPath}): wc failed (status ${wc.status}): ${wc.out.trim()}`);
      const n = parseInt(wc.out, 10);
      if (!Number.isFinite(n) || n < 0) throw sessionError(
        `readFile(${osPath}): bad size ${JSON.stringify(wc.out.trim())}`);
      const k = seq++;
      const m1 = `==RB${k}`, m2 = `==RE${k}`;
      const from = sout.len;
      await write(`echo ${split(m1)}; ` +
        (ttyOut ? 'base64 ' : 'cat ') + sq(osPath) +
        `; echo ${split(m2)}\n`);
      // Data starts after the m1 LINE — its ending is \n (byte-clean) or the
      // ONLCR \r\n (--tty-out), so anchor on the marker and skip to past '\n'.
      const dataAt = () => {
        const i = sout.indexOf(m1, from);
        if (i < 0) return -1;
        const nl = sout.indexOf('\n', i);
        return nl < 0 ? -1 : nl + 1;
      };
      if (!ttyOut) {
        const got = await await_(() => {
          const data = dataAt();
          if (data < 0) return false;
          return sout.len >= data + n + m2.length ? { data } : false;
        }, timeout, `readFile(${osPath})`);
        const end = sout.slice(got.data + n, got.data + n + m2.length).toString('latin1');
        if (end !== m2) throw sessionError(
          `readFile(${osPath}): end marker not at byte ${n} (file changed mid-read?)`);
        return Buffer.from(sout.slice(got.data, got.data + n));
      }
      const got = await await_(() => {
        const data = dataAt();
        if (data < 0) return false;
        const j = sout.indexOf(m2, data);
        return j < 0 ? false : { data, j };
      }, timeout, `readFile(${osPath})`);
      const bytes = Buffer.from(
        sout.slice(got.data, got.j).toString('latin1').replace(/\s+/g, ''), 'base64');
      if (bytes.length !== n) throw sessionError(
        `readFile(${osPath}): decoded ${bytes.length} bytes, expected ${n}`);
      return bytes;
    }),

    // Write data INTO the OS: base64 in line-sized chunks appended by hush's
    // printf builtin, decoded in-OS, byte-count verified. (The transport every
    // dogfood round hand-rolls; the standalone printf applet is not baked —
    // CONFIG_HUSH_PRINTF is.)
    putFile: (osPath, data, { timeout = 60000 } = {}) => serial(async () => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const b64 = buf.toString('base64');
      const tmp = osPath + '.b64~';
      let script = `: > ${sq(tmp)}\n`;   // truncate-create: a 0-byte put stays valid
      for (let i = 0; i < b64.length; i += 4096)
        script += `printf %s ${sq(b64.slice(i, i + 4096))} >> ${sq(tmp)}\n`;
      await write(script);
      const r = await rawRun(
        `base64 -d < ${sq(tmp)} > ${sq(osPath)} && rm -f ${sq(tmp)} && wc -c < ${sq(osPath)}`,
        timeout);
      if (r.status !== 0) throw sessionError(
        `putFile(${osPath}): decode failed (status ${r.status}): ${r.out.trim()}`);
      const n = parseInt(r.out, 10);
      if (n !== buf.length) throw sessionError(
        `putFile(${osPath}): landed ${n} bytes, expected ${buf.length}`);
    }),

    // The CPU-composited screen (kernel wmScreenshotScreen — bit-exact, no
    // compositor furniture). Each call is a fresh composite.
    screen: (o = {}) => drive.shotPpm('screen', o).then(parsePpm),
    sample: async (x, y, o = {}) => {
      const { w, h, rgb } = await drive.screen(o);
      if (x < 0 || y < 0 || x >= w || y >= h)
        throw new Error(`sample(${x},${y}): outside ${w}x${h}`);
      const i = (y * w + x) * 3;
      return { r: rgb[i], g: rgb[i + 1], b: rgb[i + 2] };
    },
    shotPpm: async (target = 'screen', { timeout = 60000 } = {}) => {
      const tmp = `/tmp/.osdrive-${seq++}.ppm`;
      const r = await drive.wmctl(`shot ${target} ${tmp}`, { timeout });
      if (r.status !== 0) throw sessionError(
        `shot ${target}: wmctl failed (status ${r.status}): ${r.out.trim()}`);
      const ppm = await drive.readFile(tmp, { timeout });
      await drive.sh(`rm -f ${sq(tmp)}`);
      return ppm;
    },
    // PNG to `file` (raw P6 when `file` ends .ppm); target 'screen' or a SID.
    shot: async (file, { target = 'screen', timeout = 60000 } = {}) => {
      const ppm = await drive.shotPpm(target, { timeout });
      const { w, h, rgb } = parsePpm(ppm);
      fs.writeFileSync(file, file.endsWith('.ppm') ? ppm : encodePng(w, h, rgb));
      return { w, h };
    },

    load, loadStop,
    waitExit: (ms = 30000) => await_(() => exited || false, ms, 'waitExit'),
    close: async ({ timeout = 30000 } = {}) => {
      loadStop();
      if (!exited) {
        try { child.stdin.end(); } catch {}       // tty EOF -> init exits -> halt
        try { await drive.waitExit(timeout); }
        catch (e) {
          process.stderr.write(`[drive] close: no clean exit in ${timeout}ms — SIGKILL\n`);
          child.kill('SIGKILL');
          await new Promise((r) => child.once('exit', r));
        }
      }
      if (imageDir && !opts.keepImage)
        fs.rmSync(imageDir, { recursive: true, force: true });
      return exited;
    },
  };

  // run() without the serial queue — for composed ops already inside it.
  const rawRun = async (cmd, timeout) => {
    const mark = `DRV-${seq++}-EOT:`;
    const from = sout.len;
    await write(`${cmd}; echo ${split(mark)}$?\n`);
    const at = await await_(() => {
      const i = sout.indexOf(mark, from);
      if (i < 0) return false;
      const nl = sout.indexOf('\n', i);
      return nl < 0 ? false : { i, nl };
    }, timeout, `run(${JSON.stringify(cmd)})`);
    return { out: sout.slice(from, at.i).toString('latin1'),
             status: parseInt(sout.slice(at.i + mark.length, at.nl).toString(), 10) };
  };

  // Ready = the shell answered one round-trip. A cold image may install a
  // fixture (seconds) or bake from source (minutes) first; boot.js's heavy-
  // lock refusal (exit 3 + '[heavy-lock]' on stderr) surfaces here verbatim.
  try {
    await drive.run(':', { timeout: opts.readyTimeout || 300000 });
  } catch (e) {
    if (exited && exited.code === 3 && serr.tail(4000).includes('[heavy-lock]')) {
      const err = new Error('os-drive-headless: boot refused — heavy-test lock held:\n' +
        serr.tail(2000));
      err.heavyLock = true;
      throw err;
    }
    try { child.kill('SIGKILL'); } catch {}
    throw e;
  }
  return drive;
}

/* ---- load generators (the flake-gate pattern: real arithmetic so V8 can't
 * fold it, self-healing on orphaning via the ppid check) ---- */
const loadProcs = new Set();
export function load(n) {
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
export function loadStop() {
  if (!loadProcs.size) return;
  for (const p of loadProcs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } }
  loadProcs.clear();
  console.log('[drive] load: stopped');
}

/* ---- CLI ---- */
async function main() {
  const argv = process.argv.slice(2);
  let image = null, keepImage = false, underLoad = 0, runTimeout = 20000, script = null;
  const bootArgs = [], scriptArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { bootArgs.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('--image=')) image = path.resolve(a.slice(8));
    else if (a === '--keep-image') keepImage = true;
    else if (a === '--under-load') underLoad = -1;
    else if (a.startsWith('--under-load=')) underLoad = parseInt(a.slice(13), 10);
    else if (a.startsWith('--timeout=')) runTimeout = parseInt(a.slice(10), 10);
    else if (a.startsWith('--boot=')) bootArgs.push(a.slice(7));
    else if (a.startsWith('--') && !script) {
      console.error(`os-drive-headless: unknown option ${a} (boot.js flags go via --boot= or after --)`);
      process.exit(2);
    }
    else if (!script) script = a;
    else scriptArgs.push(a);
  }

  console.log(`[drive] booting os/boot.js headless${image ? ` on ${image}` : ''}…`);
  const t0 = Date.now();
  let drive;
  try {
    drive = await openHeadlessSession({
      image, keepImage, bootArgs, runTimeout,
      echoOutput: !script,           // REPL streams the tty live; scripts read deltas
    });
  } catch (e) {
    process.stderr.write((e && e.message || String(e)) + '\n');
    process.exit(e && e.heavyLock ? 3 : 1);
  }
  console.log(`[drive] ready in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
    ` (image: ${drive.image}${keepImage ? ', kept' : ''})`);
  if (underLoad !== 0) load(underLoad === -1 ? 0 : underLoad);

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

  // REPL: plain text = one shell line on the live tty; ':' commands drive the
  // session. Child stdout/stderr stream through as they arrive.
  console.log('[drive] REPL — plain text = shell line; :help for commands');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  drive.child.on('exit', (code, signal) =>
    console.log(`\n[drive] boot.js exited (code=${code} signal=${signal}) — :q to leave`));
  const HELP = `  :run CMD         marker-synced run; prints the delta + exit status
  :out [N] / :err [N]   dump the last N chars of stdout/stderr (default 2000)
  :shot FILE [SID] PNG (or .ppm) of the screen / surface SID
  :read OS LOCAL   copy a file out of the OS
  :put LOCAL OS    copy a host file into the OS
  :sample X Y      composited screen pixel at (X,Y)
  :load [N] / :noload   start/stop busy-loop generators
  :q               quit (EOF -> init exits)`;
  rl.on('line', async (lineIn) => {
    const line = lineIn.trim();
    try {
      if (!line) return;
      if (!line.startsWith(':')) { await drive.sh(line); return; }
      const [c, ...rest] = line.slice(1).split(/\s+/);
      if (c === 'q' || c === 'quit') { rl.close(); return; }
      else if (c === 'help') console.log(HELP);
      else if (c === 'run') {
        const r = await drive.run(lineIn.trim().slice(5));
        console.log(r.out + `[status ${r.status}]`);
      }
      else if (c === 'out') console.log(drive.out(rest[0] ? parseInt(rest[0], 10) : 2000));
      else if (c === 'err') console.log(drive.err(rest[0] ? parseInt(rest[0], 10) : 2000));
      else if (c === 'shot') {
        const { w, h } = await drive.shot(rest[0] || '/tmp/os-drive-shot.png',
                                          rest[1] ? { target: rest[1] } : {});
        console.log(`[drive] shot ${w}x${h} -> ${rest[0] || '/tmp/os-drive-shot.png'}`);
      }
      else if (c === 'read') {
        fs.writeFileSync(rest[1], await drive.readFile(rest[0]));
        console.log(`[drive] ${rest[0]} -> ${rest[1]}`);
      }
      else if (c === 'put') {
        await drive.putFile(rest[1], fs.readFileSync(rest[0]));
        console.log(`[drive] ${rest[0]} -> OS ${rest[1]}`);
      }
      else if (c === 'sample') console.log(await drive.sample(parseInt(rest[0], 10), parseInt(rest[1], 10)));
      else if (c === 'load') load(rest[0] ? parseInt(rest[0], 10) : 0);
      else if (c === 'noload') loadStop();
      else console.log('unknown command; :help');
    } catch (e) { console.error('[drive] ' + (e && e.message)); }
  });
  rl.on('close', async () => {
    const r = await drive.close();
    console.log(`[drive] session ended (code=${r && r.code} signal=${r && r.signal})`);
    process.exit(0);
  });
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
