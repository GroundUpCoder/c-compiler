#!/usr/bin/env node
// NetSurf vendored-tree JavaScript smoke: the Lane A gate (todos/NETSURF-JS.md).
//
// Builds the monkey frontend (same wasm as smoke.mjs — JS is compiled in
// unconditionally now; `enable_javascript` is what turns it on) and drives the
// three demo pages the JS ladder's Lane A can satisfy, over the real monkey
// protocol on stdio:
//
//   1. demos/hello-js.html  script executes, console.log reaches the frontend,
//                           parse-time document.write lands in the layout
//   2. demos/counter.html   a real DOM click listener fires EXACTLY ONCE per
//                           click and its input.value write REPAINTS
//   3. demos/sketch.html    canvas getImageData/putImageData + setInterval —
//                           content-driven repaint with ZERO user input
//   4. runaway script       the 10 s execution watchdog bounds `while(true){}`
//                           and the browser is still alive afterwards
//   5. Choices off-switch   `enable_javascript:0` in the Choices file keeps
//                           scripts from running at all
//
//   node vendor/netsurf/smoke-js.mjs             build + run + assert
//   node vendor/netsurf/smoke-js.mjs --reuse     reuse build/netsurf-smoke's
//                                                wasm if it is not stale
//   node vendor/netsurf/smoke-js.mjs --build     build only
//   node vendor/netsurf/smoke-js.mjs --leg 2     run one leg (repeatable)
//
// Every wait is on a MARKER (a console line, a load-complete throbber, a
// REDRAW STOP, an INVALIDATE_AREA), never on a fixed sleep, and a wait that
// cannot be satisfied FAILS LOUD instead of napping out its clock.  Leg 4 is
// the one exception that has to watch a clock, because bounding a 10 s
// watchdog is the thing being tested.

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
const DEMOS = path.join(HERE, 'demos');

const argv = process.argv.slice(2);
const REUSE = argv.includes('--reuse');
const BUILD_ONLY = argv.includes('--build');
const ONLY = argv.reduce((acc, a, i) => (a === '--leg' ? acc.concat(Number(argv[i + 1])) : acc), []);

// ---- build ------------------------------------------------------------
// --reuse is for iterating, so it has to prove the wasm is not stale rather
// than trust it: a stale binary passing this gate is exactly the silent
// symptom the estate's test rules forbid.
function newestInput() {
  // Everything that is actually LINKED, and nothing else: demo pages, the
  // harnesses and the vendor-pipeline scripts are not build inputs, and
  // treating them as such would rebuild for 60 s on every edit to this file.
  const NOT_LINKED = new Set([
    'demos', 'test', 'patches', '.git', 'README.md', 'UPSTREAM.json',
    'smoke.mjs', 'smoke-js.mjs', 'relativize.mjs', 'genjs-sources.mjs',
    'update.sh', 'regen-js-bindings.sh',
  ]);
  const roots = [HERE, path.join(ROOT, 'compiler.js'), path.join(ROOT, 'host.js'),
    path.join(ROOT, 'os', 'os-common.js'), path.join(ROOT, 'vendor', 'zlib'),
    path.join(ROOT, 'vendor', 'libpng'), path.join(ROOT, 'vendor', 'freetype')];
  let newest = 0;
  const walk = (p, top) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) {
        if (top && NOT_LINKED.has(e)) continue;
        walk(path.join(p, e), false);
      }
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  for (const r of roots) { if (fs.existsSync(r)) walk(r, r === HERE); }
  return newest;
}

let built = false;
if (REUSE && fs.existsSync(WASM) && fs.statSync(WASM).mtimeMs >= newestInput()) {
  console.log(`reusing ${WASM} (${(fs.statSync(WASM).size / 1024 / 1024).toFixed(1)} MB, newer than every build input)`);
} else {
  if (REUSE) console.log('--reuse: wasm missing or older than a build input — rebuilding');
  console.log('building vendor/netsurf/bin.json (817-TU class link, JS on)…');
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
  built = true;
  console.log(`built ${WASM} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${bytes.length} B) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
if (BUILD_ONLY) process.exit(0);

// ---- runtime resources ------------------------------------------------
// Same assembly as smoke.mjs (the engine needs its resource: stylesheets and
// Messages to finish a load), plus a second tree carrying a Choices file that
// turns JS off — leg 5's whole point.
function makeRes(name, choices) {
  const RES = path.join(OUT_DIR, name);
  fs.mkdirSync(RES, { recursive: true });
  const RSRC = path.join(HERE, 'netsurf', 'resources');
  for (const f of ['default.css', 'quirks.css', 'internal.css', 'adblock.css']) {
    fs.copyFileSync(path.join(RSRC, f), path.join(RES, f));
  }
  fs.copyFileSync(path.join(RSRC, 'Messages.en'), path.join(RES, 'Messages'));
  if (choices) fs.writeFileSync(path.join(RES, 'Choices'), choices);
  else fs.rmSync(path.join(RES, 'Choices'), { force: true });
  return RES + '/';
}
const RES_ON = makeRes('res', null);
const RES_JS_OFF = makeRes('res-jsoff', 'enable_javascript:0\n');

// ---- the monkey driver ------------------------------------------------
class Monkey {
  constructor(res, { js = true } = {}) {
    const args = [path.join(ROOT, 'host.js'), WASM];
    if (js) args.push('--enable_javascript=1');
    this.child = spawn(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NETSURFRES: res },
    });
    this.out = '';
    this.err = '';
    this.exited = null;
    this.waiters = [];
    this.child.stdout.on('data', (b) => { this.out += b.toString(); this._pump(); });
    this.child.stderr.on('data', (b) => { this.err += b.toString(); });
    this.child.on('exit', (code) => { this.exited = code; this._pump(); });
  }

  _pump() {
    for (const w of this.waiters.slice()) {
      const m = this.out.slice(w.from).match(w.re);
      if (m) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      } else if (this.exited !== null) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.reject(new Error(`browser exited (${this.exited}) while waiting for ${w.label}`));
      }
    }
  }

  send(line) {
    if (this.exited !== null) throw new Error(`send("${line}") after exit ${this.exited}`);
    this.child.stdin.write(line + '\n');
  }

  mark() { return this.out.length; }

  /* Wait for a marker.  A wait that cannot be satisfied must fail loud, never
   * burn its clock and let a later assertion carry the test. */
  wait(re, { label = String(re), from = 0, timeout = 25_000 } = {}) {
    return new Promise((resolve, reject) => {
      const w = { re, label, from, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out after ${timeout}ms waiting for ${label}\n--- last output ---\n${this.out.slice(-1500)}`));
      }, timeout);
      this.waiters.push(w);
      this._pump();
    });
  }

  async open(file) {
    const from = this.mark();
    this.send(`WINDOW NEW file://${file}`);
    const m = await this.wait(/WINDOW NEW WIN (\d+)/, { label: 'window creation', from });
    this.win = m[1];
    // Load complete = a STOP_THROBBER that follows the load's START_THROBBER
    // (the throbber also stops once at window creation).
    await this.wait(new RegExp(`START_THROBBER WIN ${this.win}[\\s\\S]*?STOP_THROBBER WIN ${this.win}`),
      { label: `load of ${path.basename(file)}`, from });
    return this.win;
  }

  /* Force a full repaint and return ONLY that frame's plot stream. */
  async redraw() {
    const from = this.mark();
    this.send(`WINDOW REDRAW ${this.win}`);
    await this.wait(new RegExp(`REDRAW WIN ${this.win} STOP`), { label: 'redraw frame', from });
    return this.out.slice(from);
  }

  /* Click a labelled control by the position its own text was plotted at:
   * font-metric derived, so it survives a font change (a hardcoded pixel
   * coordinate would not). */
  clickText(frame, label) {
    const re = new RegExp(`PLOT TEXT X (\\d+) Y (\\d+) STR ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
    const m = frame.match(re);
    if (!m) throw new Error(`no plotted text "${label}" to click in this frame`);
    const x = Number(m[1]) + 2;
    const y = Number(m[2]) - 4;   // PLOT TEXT y is the baseline; go into the glyph box
    this.send(`WINDOW CLICK WIN ${this.win} X ${x} Y ${y} BUTTON LEFT KIND SINGLE`);
    return { x, y };
  }

  consoleLines() {
    return [...this.out.matchAll(/^WINDOW CONSOLE_LOG WIN \d+ SOURCE \S+ \S+ LOG (.*)$/gm)].map((m) => m[1]);
  }

  async quit() {
    if (this.exited !== null) return this.exited;
    const p = new Promise((res) => this.child.on('exit', res));
    this.send('QUIT');
    const t = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    const code = await p;
    clearTimeout(t);
    return code;
  }

  kill() { if (this.exited === null) this.child.kill('SIGKILL'); }
}

// ---- assertions -------------------------------------------------------
const fails = [];
function ok(cond, what, detail = '') {
  if (cond) console.log(`  ok   ${what}`);
  else { console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`); fails.push(what); }
  return !!cond;
}
const demo = (n) => path.join(DEMOS, n);

// ---- leg 1: hello-js.html --------------------------------------------
async function leg1() {
  console.log('\nleg 1 — demos/hello-js.html: script executes, console + document.write');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('hello-js.html'));
    const logs = mk.consoleLines();
    ok(logs.includes('hello from JavaScript'), 'console.log reached the frontend',
      `console lines: ${JSON.stringify(logs)}`);
    ok(logs.includes('engine reached the end of the script'),
      'the whole script ran (no mid-script abort)');
    const frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR .*doubled: 1, 2, 4, 8/.test(frame),
      'document.write output was parsed and laid out');
    ok(/PLOT TEXT X \d+ Y \d+ STR .*sum 15/.test(frame),
      'the written text was COMPUTED by the script (sum 15)');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 2: counter.html --------------------------------------------
async function leg2() {
  console.log('\nleg 2 — demos/counter.html: click dispatch + repainting value write');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('counter.html'));
    ok(mk.consoleLines().includes('counter ready'), 'page script ran');

    let frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR Add one$/m.test(frame), 'the buttons laid out');

    // One click -> exactly one increment.  This is the regression guard for the
    // libdom double-dispatch fix (patches/libdom.diff): before it, a listener
    // on the click target ran twice — at-target AND again on the bubble walk
    // back over the target — so one click counted 2.
    let from = mk.mark();
    mk.clickText(frame, 'Add one');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint request after click', from });
    frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR 1$/m.test(frame),
      'one click = exactly ONE increment, and the new value REPAINTED',
      `plotted values: ${JSON.stringify([...frame.matchAll(/PLOT TEXT X \d+ Y \d+ STR (-?\d+)$/gm)].map((m) => m[1]))}`);

    for (let i = 0; i < 2; i++) {
      from = mk.mark();
      mk.clickText(frame, 'Add one');
      await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: `repaint after click ${i + 2}`, from });
      frame = await mk.redraw();
    }
    ok(/PLOT TEXT X \d+ Y \d+ STR 3$/m.test(frame), 'three clicks = 3');

    from = mk.mark();
    mk.clickText(frame, 'Take one');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after decrement', from });
    frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR 2$/m.test(frame), 'a second listener works too (2)');

    from = mk.mark();
    mk.clickText(frame, 'Reset');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after reset', from });
    frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR 0$/m.test(frame), 'reset writes 0');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 3: sketch.html ---------------------------------------------
async function leg3() {
  console.log('\nleg 3 — demos/sketch.html: canvas ImageData + timer-driven repaint');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('sketch.html'));
    ok(mk.consoleLines().includes('sketch ready'), 'canvas page script ran');

    // No input from here on: the ONLY thing that can ask for a repaint is the
    // page's own setInterval tick calling putImageData.
    const from = mk.mark();
    await mk.wait(/INVALIDATE_AREA WIN \d+[\s\S]*?INVALIDATE_AREA WIN \d+/,
      { label: 'two timer-driven repaint requests (no input at all)', from });
    ok(true, 'setInterval + putImageData request repaints with ZERO user input');

    let frame = await mk.redraw();
    ok(/PLOT BITMAP X \d+ Y \d+ WIDTH 128 HEIGHT 96/.test(frame),
      'the 128x96 canvas is plotted as a bitmap');
    const nframes = frame.match(/PLOT TEXT X \d+ Y \d+ STR (\d+) frames$/m);
    ok(nframes && Number(nframes[1]) >= 2,
      'the frame counter advanced on its own', `counter read: ${nframes ? nframes[1] : 'not plotted'}`);

    const before = mk.mark();
    mk.clickText(frame, 'Next pattern');
    await mk.wait(/LOG sketch pattern 1$/m, { label: 'pattern-change click', from: before });
    ok(true, 'clicking through to the canvas handler works');

    const stopFrom = mk.mark();
    frame = await mk.redraw();
    mk.clickText(frame, 'Stop / go');
    await mk.wait(/LOG sketch stopped$/m, { label: 'clearInterval click', from: stopFrom });
    ok(true, 'clearInterval stops the animation');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 4: the 10 s execution watchdog ------------------------------
async function leg4() {
  console.log('\nleg 4 — runaway script: the 10 s execution watchdog (JS_EXEC_TIMEOUT_MS)');
  const page = path.join(OUT_DIR, 'runaway.html');
  fs.writeFileSync(page,
    '<!DOCTYPE html><html><head><title>runaway</title></head><body>\n' +
    '<p>spin</p>\n' +
    '<script>console.log("runaway starting"); var i=0; while (true) { i++; }' +
    'console.log("NEVER REACHED");</script>\n' +
    '</body></html>\n');
  const mk = new Monkey(RES_ON);
  try {
    const t0 = Date.now();
    const from = mk.mark();
    mk.send(`WINDOW NEW file://${page}`);
    const m = await mk.wait(/WINDOW NEW WIN (\d+)/, { label: 'window creation', from });
    mk.win = m[1];
    // Wait for the script's own marker: the spin starts DURING the load, so
    // "did it start" cannot be read off the window-creation line.
    await mk.wait(/LOG runaway starting$/m, { label: 'the runaway script starting', from });
    ok(true, 'the runaway script started');
    // The watchdog is the thing under test, so this leg does have to watch a
    // clock: wait for the load to complete and check WHEN it did.
    await mk.wait(new RegExp(`START_THROBBER WIN ${mk.win}[\\s\\S]*?STOP_THROBBER WIN ${mk.win}`),
      { label: 'load completing (watchdog aborting the script)', from, timeout: 40_000 });
    const secs = (Date.now() - t0) / 1000;
    ok(secs >= 8 && secs <= 25, `the watchdog cut the script off (took ${secs.toFixed(1)}s, want ~10s)`);
    ok(!mk.consoleLines().includes('NEVER REACHED'),
      'the script did NOT resume past the abort');
    // Alive afterwards: the browser must still answer, not be a zombie.
    const frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR spin$/m.test(frame), 'the browser still renders after the abort');
    ok(await mk.quit() === 0, 'clean exit after a runaway script');
  } finally { mk.kill(); }
}

// ---- leg 5: the Choices off-switch -----------------------------------
async function leg5() {
  console.log('\nleg 5 — Choices `enable_javascript:0` is still the off-switch');
  // No --enable_javascript on the command line here: the Choices file is the
  // only thing speaking, exactly as an admin would use it.
  const mk = new Monkey(RES_JS_OFF, { js: false });
  try {
    await mk.open(demo('hello-js.html'));
    const logs = mk.consoleLines();
    ok(logs.length === 0, 'no script output at all with JS off',
      `console lines: ${JSON.stringify(logs)}`);
    const frame = await mk.redraw();
    ok(!/doubled: 1, 2, 4, 8/.test(frame), 'document.write output is absent with JS off');
    ok(/PLOT TEXT X \d+ Y \d+ STR Hello JavaScript$/m.test(frame),
      'the page itself still renders (JS off is not a broken page)');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- run --------------------------------------------------------------
const LEGS = [leg1, leg2, leg3, leg4, leg5];
const t0 = Date.now();
for (let i = 0; i < LEGS.length; i++) {
  if (ONLY.length && !ONLY.includes(i + 1)) continue;
  try {
    await LEGS[i]();
  } catch (e) {
    console.log(`  FAIL leg ${i + 1} threw: ${e.message}`);
    fails.push(`leg ${i + 1}: ${e.message.split('\n')[0]}`);
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (fails.length === 0) {
  console.log(`\nSMOKE-JS PASS: JavaScript executes, dispatches clicks and repaints (${secs}s${built ? ', fresh build' : ''})`);
  process.exit(0);
}
console.error(`\nSMOKE-JS FAIL (${secs}s): ${fails.length} assertion(s)\n  - ${fails.join('\n  - ')}`);
process.exit(1);
