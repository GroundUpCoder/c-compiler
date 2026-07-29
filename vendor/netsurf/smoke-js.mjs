#!/usr/bin/env node
// NetSurf vendored-tree JavaScript smoke: the Lane A gate (todos/NETSURF-JS.md).
//
// Builds the monkey frontend (same wasm as smoke.mjs — JS is compiled in
// unconditionally now; `enable_javascript` is what turns it on) and drives the
// three demo pages the JS ladder's Lane A can satisfy, over the real monkey
// protocol on stdio:
//
//   0. contract + subresources  every shipped demo folder keeps the promises
//                           in demos/demos.js (own folder, EXTERNAL
//                           stylesheet, EXTERNAL script, linked from the
//                           landing page), every demo has a leg below, and
//                           each page's subresources really load: its
//                           "stylesheet did not load" notice is hidden and
//                           its "script ran" pill text is present
//   1. hello-js/index.html  script executes, console.log reaches the frontend,
//                           parse-time document.write lands in the layout
//   2. counter/index.html   a real DOM click listener fires EXACTLY ONCE per
//                           click and its input.value write REPAINTS
//   3. sketch/index.html    canvas getImageData/putImageData + setInterval —
//                           content-driven repaint with ZERO user input
//   4. runaway script       the 10 s execution watchdog bounds `while(true){}`
//                           and the browser is still alive afterwards
//   5. Choices off-switch   `enable_javascript:0` in the Choices file keeps
//                           scripts from running at all
//
// …and the Lane B legs, which need the mutation→re-box→reflow→repaint bridge:
//
//   6. stopwatch/index.html a setInterval writing a <div>'s textContent moves
//                           the visible number, and Lap inserts a real row
//   7. todo/index.html      removeChild unpaints a row and the counter's text
//                           and class both re-render
//   8. A/B baseline         the SAME two pages, rebuilt with the bridge
//                           compiled out (-DNETSURF_NO_LIVE_RECONVERT), must
//                           plot NOTHING changing — a demo that passes with
//                           and without the change proves nothing
//
// …and the Lane C legs (todos/0289), which need UI event coverage:
//
//   9. paint/index.html     mousedown/mousemove/mouseup exist AND carry
//                           coordinates: every coordinate the page reports
//                           back is the one that was injected, and the
//                           canvas pixel under it really changed
//  10. events/index.html    capture fires BEFORE bubble across a three-deep
//                           propagation path; keydown lands on the FOCUSED
//                           element with a real event.key for Enter; keyup,
//                           input, change, focus/blur, a cancelable submit
//                           and window.addEventListener("load")
//  11. A/B baseline         the SAME two pages, rebuilt with Lane C
//                           compiled out (-DNETSURF_NO_UI_EVENTS): the
//                           scripts still run, and NOTHING they listen for
//                           ever arrives
//
// …and the headline canvas demo:
//
//  12. plasma/index.html    a 320x200 ImageData plasma animating from
//                           setInterval alone, with a MEASURED frame rate
//                           printed (not guessed), palette switching and
//                           a clean stop
//
// …and the pointer-path legs (todos/0419 + todos/0420; the kill-switch
// convention restored by todos/0431).  These drive test/ pages, not demos —
// the full pointer semantics are the in-OS test_netsurf_pointer_e2e.js;
// these legs exist to anchor the A/B:
//
//  13. test/ptr-click.html  preventDefault() on a link click stops the
//                           navigation, and an uncancelled click on the
//                           SAME page still navigates (the honest control)
//  14. test/ptr-hover.html  a `:hover` / `:active` rule really applies:
//                           each transition repaints, and the rule's
//                           geometry change moves a marker text below it
//                           (the plot stream carries no colours)
//  15. A/B baseline         ptr-click, rebuilt with the cancelled-click
//                           patch compiled out (-DNETSURF_NO_CLICK_CANCEL):
//                           the listener still runs and still cancels, and
//                           the navigation happens ANYWAY
//  16. A/B baseline         ptr-hover, rebuilt with the dynamic
//                           pseudo-classes compiled out
//                           (-DNETSURF_NO_DYNAMIC_PSEUDO): the same moves
//                           and press repaint NOTHING and move NOTHING
//
// Every demo now lives in its own folder under demos/pages/ with its markup,
// its stylesheet and its script in separate files — which is also what the
// `netsurf-demos` package seeds onto the desktop.  Nothing here enumerates
// them: demos/demos.js derives the set from the tree.
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
const DEMOS = require(path.join(HERE, 'demos', 'demos.js'));

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

/* Build the monkey binary, optionally with extra -D flags folded into
 * bin.json on the way past.  The read callback is the only seam needed:
 * buildProject asks for every source through it, so the variant build is
 * the SAME tree with one define, not a second checkout. */
function buildWasm(outPath, extraArgs, label) {
  const t0 = Date.now();
  const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const CompilerJS = require(path.join(ROOT, 'compiler.js'));
  const bytes = OS_COMMON.buildProject(
    CompilerJS,
    'vendor/netsurf/bin.json',
    (p) => {
      const txt = fs.readFileSync(path.join(ROOT, p), 'utf-8');
      if (extraArgs.length && p.replace(/\\/g, '/').endsWith('vendor/netsurf/bin.json')) {
        const j = JSON.parse(txt);
        j.compilerArgs = (j.compilerArgs || []).concat(extraArgs);
        return JSON.stringify(j);
      }
      return txt;
    },
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, bytes);
  console.log(`built ${outPath} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${bytes.length} B) in ${((Date.now() - t0) / 1000).toFixed(1)}s${label ? ` — ${label}` : ''}`);
  return bytes.length;
}

let built = false;
if (REUSE && fs.existsSync(WASM) && fs.statSync(WASM).mtimeMs >= newestInput()) {
  console.log(`reusing ${WASM} (${(fs.statSync(WASM).size / 1024 / 1024).toFixed(1)} MB, newer than every build input)`);
} else {
  if (REUSE) console.log('--reuse: wasm missing or older than a build input — rebuilding');
  console.log('building vendor/netsurf/bin.json (817-TU class link, JS on)…');
  buildWasm(WASM, [], 'the product build');
  built = true;
}
if (BUILD_ONLY) process.exit(0);

/* The A/B baseline (leg 8): the same sources with the live re-conversion
 * bridge compiled out.  Built lazily — legs 1-7 do not need it. */
let noBridgeWasm = null;
function baselineWasm() {
  if (noBridgeWasm) return noBridgeWasm;
  const out = path.join(OUT_DIR, 'nsmonkey-nobridge.wasm');
  if (REUSE && fs.existsSync(out) && fs.statSync(out).mtimeMs >= newestInput()) {
    console.log(`  reusing baseline ${path.basename(out)}`);
  } else {
    console.log('  building the -DNETSURF_NO_LIVE_RECONVERT baseline…');
    const n = buildWasm(out, ['-DNETSURF_NO_LIVE_RECONVERT'], 'Lane B compiled OUT');
    /* A baseline that is byte-identical to the product build would make
     * leg 8 a tautology, so say so loudly rather than pass. */
    if (n === fs.statSync(WASM).size) {
      throw new Error('baseline wasm is the same size as the product build — the kill switch did not take effect');
    }
  }
  noBridgeWasm = out;
  return out;
}

/* The Lane C baseline (leg 11): the same sources with the UI event
 * coverage compiled out.  Built lazily — legs 0-10 do not need it. */
let noEventsWasmPath = null;
function noEventsWasm() {
  if (noEventsWasmPath) return noEventsWasmPath;
  const out = path.join(OUT_DIR, 'nsmonkey-noevents.wasm');
  if (REUSE && fs.existsSync(out) && fs.statSync(out).mtimeMs >= newestInput()) {
    console.log(`  reusing baseline ${path.basename(out)}`);
  } else {
    console.log('  building the -DNETSURF_NO_UI_EVENTS baseline…');
    const n = buildWasm(out, ['-DNETSURF_NO_UI_EVENTS'], 'Lane C compiled OUT');
    /* A baseline byte-identical to the product build would make leg 11 a
     * tautology, so say so loudly rather than pass. */
    if (n === fs.statSync(WASM).size) {
      throw new Error('baseline wasm is the same size as the product build — the kill switch did not take effect');
    }
  }
  noEventsWasmPath = out;
  return out;
}

/* The pointer-path baselines (legs 15 and 16): one wasm per switch, so
 * each switch is proven to build — and to change behaviour — ALONE. */
function pointerBaselineWasm(cache, file, define, label) {
  if (cache.path) return cache.path;
  const out = path.join(OUT_DIR, file);
  if (REUSE && fs.existsSync(out) && fs.statSync(out).mtimeMs >= newestInput()) {
    console.log(`  reusing baseline ${path.basename(out)}`);
  } else {
    console.log(`  building the -D${define} baseline…`);
    const n = buildWasm(out, [`-D${define}`], label);
    /* A baseline byte-identical to the product build would make the leg a
     * tautology, so say so loudly rather than pass. */
    if (n === fs.statSync(WASM).size) {
      throw new Error('baseline wasm is the same size as the product build — the kill switch did not take effect');
    }
  }
  cache.path = out;
  return out;
}
const noClickCancel = {};
const noClickCancelWasm = () => pointerBaselineWasm(noClickCancel,
  'nsmonkey-noclickcancel.wasm', 'NETSURF_NO_CLICK_CANCEL', '0419 compiled OUT');
const noDynPseudo = {};
const noDynPseudoWasm = () => pointerBaselineWasm(noDynPseudo,
  'nsmonkey-nodynpseudo.wasm', 'NETSURF_NO_DYNAMIC_PSEUDO', '0420 compiled OUT');

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
  constructor(res, { js = true, wasm = WASM } = {}) {
    const args = [path.join(ROOT, 'host.js'), wasm];
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
  clickTextAt(frame, label) {
    const re = new RegExp(`PLOT TEXT X (\\d+) Y (\\d+) STR ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
    const m = frame.match(re);
    if (!m) throw new Error(`no plotted text "${label}" to click in this frame`);
    return { x: Number(m[1]) + 2, y: Number(m[2]) - 4 };
  }

  clickText(frame, label) {
    // PLOT TEXT y is the baseline; clickTextAt goes into the glyph box
    const at = this.clickTextAt(frame, label);
    this.send(`WINDOW CLICK WIN ${this.win} X ${at.x} Y ${at.y} BUTTON LEFT KIND SINGLE`);
    return at;
  }

  /* Compose any browser_mouse_state the core understands.  WINDOW CLICK
   * can only ever say "a click happened"; press / hold / move / release —
   * i.e. everything mousedown/mousemove/mouseup are made of — needs this. */
  mouse(kind, x, y, ...states) {
    this.send(`WINDOW MOUSE WIN ${this.win} X ${x} Y ${y} KIND ${kind}` +
      (states.length ? ` STATE ${states.join(' ')}` : ''));
  }

  /* One press-drag-release gesture, as the core sees one: the press, the
   * drag-start notification at the press point (which is what makes the
   * content treat what follows as a drag), the moves, and the release. */
  drag(from, to, steps = 3) {
    this.mouse('CLICK', from.x, from.y, 'PRESS_1');
    this.mouse('CLICK', from.x, from.y, 'DRAG_1');
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
      const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
      this.mouse('TRACK', x, y, 'DRAG_ON', 'HOLDING_1');
    }
    this.mouse('TRACK', to.x, to.y);   // buttons released: the mouseup
  }

  /* Click a labelled control the way a pointer really does it: press,
   * then click.  WINDOW CLICK sends the CLICK alone, and a text field
   * places its caret (and so takes focus) on the PRESS — so a
   * click-without-press never focuses one. */
  pressText(frame, label) {
    const at = this.clickTextAt(frame, label);
    this.mouse('CLICK', at.x, at.y, 'PRESS_1');
    this.mouse('CLICK', at.x, at.y, 'CLICK_1');
    return at;
  }

  key(code, kind = 'DOWN') {
    this.send(`WINDOW KEY WIN ${this.win} CODE ${code} KIND ${kind}`);
  }

  /* A whole keystroke, as a front end delivers one. */
  async type(code) {
    this.key(code, 'DOWN');
    this.key(code, 'UP');
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
/* A demo's entry page, by folder name — the only spelling of a demo path in
 * this file.  demos.js is the set; nothing here re-lists it. */
const demo = (n) => path.join(DEMOS.PAGES_DIR, n, 'index.html');
/* A harness page under test/ — NOT a demo: nothing ships it, so it owes the
 * demo contract nothing (the smoke.mjs squares.html precedent). */
const testPage = (n) => path.join(HERE, 'test', n);

/* Every demo declares, on the page, whether its two subresources arrived:
 * the external stylesheet hides a "stylesheet did not load" notice that IS
 * in the markup, and the external script rewrites the pill next to it.  Both
 * are readable straight off the plot stream, so this is one assertion pair
 * that works for every demo without a per-demo table. */
function checkSubresources(frame, name) {
  ok(!/STR stylesheet did not load/.test(frame),
    `${name}: the EXTERNAL stylesheet loaded (its display:none hid the notice)`,
    'the "stylesheet did not load" notice is still plotted');
  ok(/PLOT TEXT X \d+ Y \d+ STR script ran$/m.test(frame),
    `${name}: the EXTERNAL script ran (it rewrote the load-check pill)`,
    `pill text plotted: ${JSON.stringify((frame.match(/STR script [a-z ]+$/m) || ['none'])[0])}`);
}

/* Which demos this file actually drives.  The coverage check in leg 0 is
 * what makes adding a demo without a leg a LOUD failure instead of a
 * silently untested page. */
const COVERED = new Set(['hello-js', 'counter', 'sketch', 'stopwatch', 'todo',
  'paint', 'events', 'plasma']);

// ---- leg 0: the shipped demo set ------------------------------------
/* The set is derived from the tree, so this leg is what stops a demo from
 * shipping half-wired (no stylesheet, not on the landing page) or untested
 * (no leg below).  It also opens the landing page, which is the only page
 * whose links are hand-written. */
async function leg0() {
  console.log('\nleg 0 — the shipped demo set: contract, coverage, landing page');
  let names = [];
  try {
    names = DEMOS.checkContract();
    ok(true, `every shipped demo keeps the folder/stylesheet/script contract (${names.join(', ')})`);
  } catch (e) {
    ok(false, 'the shipped demo tree keeps its contract', e.message);
    names = DEMOS.demoNames();
  }
  const uncovered = names.filter((n) => !COVERED.has(n));
  const stale = [...COVERED].filter((n) => !names.includes(n));
  ok(uncovered.length === 0, 'every shipped demo has a leg in this file',
    `no leg drives: ${uncovered.join(', ')} — add one (do not ship an undriven demo)`);
  ok(stale.length === 0, 'no leg names a demo that is not shipped',
    `legs claim missing demos: ${stale.join(', ')}`);

  const mk = new Monkey(RES_ON);
  try {
    await mk.open(path.join(DEMOS.PAGES_DIR, 'index.html'));
    const frame = await mk.redraw();
    checkSubresources(frame, 'index');
    for (const d of DEMOS.demos()) {
      ok(new RegExp(`PLOT TEXT X \\d+ Y \\d+ STR ${d.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(frame),
        `the landing page lists "${d.title}"`);
    }
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 1: hello-js ------------------------------------------------
async function leg1() {
  console.log('\nleg 1 — hello-js/index.html: script executes, console + document.write');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('hello-js'));
    const logs = mk.consoleLines();
    ok(logs.includes('hello from JavaScript'), 'console.log reached the frontend',
      `console lines: ${JSON.stringify(logs)}`);
    ok(logs.includes('engine reached the end of the script'),
      'the whole script ran (no mid-script abort)');
    const frame = await mk.redraw();
    checkSubresources(frame, 'hello-js');
    ok(/PLOT TEXT X \d+ Y \d+ STR .*doubled: 1, 2, 4, 8/.test(frame),
      'document.write output was parsed and laid out');
    ok(/PLOT TEXT X \d+ Y \d+ STR .*sum 15/.test(frame),
      'the written text was COMPUTED by the script (sum 15)');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 2: counter.html --------------------------------------------
async function leg2() {
  console.log('\nleg 2 — counter/index.html: click dispatch + repainting value write');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('counter'));
    ok(mk.consoleLines().includes('counter ready'), 'page script ran');

    let frame = await mk.redraw();
    checkSubresources(frame, 'counter');
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
  console.log('\nleg 3 — sketch/index.html: canvas ImageData + timer-driven repaint');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('sketch'));
    ok(mk.consoleLines().includes('sketch ready'), 'canvas page script ran');

    // No input from here on: the ONLY thing that can ask for a repaint is the
    // page's own setInterval tick calling putImageData.
    const from = mk.mark();
    await mk.wait(/INVALIDATE_AREA WIN \d+[\s\S]*?INVALIDATE_AREA WIN \d+/,
      { label: 'two timer-driven repaint requests (no input at all)', from });
    ok(true, 'setInterval + putImageData request repaints with ZERO user input');

    let frame = await mk.redraw();
    checkSubresources(frame, 'sketch');
    ok(/PLOT BITMAP X \d+ Y \d+ WIDTH 256 HEIGHT 192/.test(frame),
      'the 256x192 canvas is plotted as a bitmap');
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
    await mk.open(demo('hello-js'));
    const logs = mk.consoleLines();
    ok(logs.length === 0, 'no script output at all with JS off',
      `console lines: ${JSON.stringify(logs)}`);
    const frame = await mk.redraw();
    ok(!/doubled: 1, 2, 4, 8/.test(frame), 'document.write output is absent with JS off');
    ok(/PLOT TEXT X \d+ Y \d+ STR Hello JavaScript$/m.test(frame),
      'the page itself still renders (JS off is not a broken page)');
    // The two subresource kinds are independent: CSS is not scripting, so the
    // external stylesheet must still load and hide its notice, while the pill
    // must still read "did not run" — which is also the honest thing for a
    // JS-off user to see.
    ok(!/STR stylesheet did not load/.test(frame),
      'the EXTERNAL stylesheet still loads with JS off');
    ok(/PLOT TEXT X \d+ Y \d+ STR script did not run$/m.test(frame),
      'the load-check pill reports, truthfully, that no script ran');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 6: stopwatch.html (Lane B, timer + insertion) ---------------
/* The elapsed readout is the ONLY thing on the page that plots as a bare
 * "<digits>.<digit>" run — the lap rows all carry a " s" suffix. */
const elapsedOf = (frame) => {
  const m = frame.match(/^PLOT TEXT X \d+ Y \d+ STR (\d+\.\d)$/m);
  return m ? Number(m[1]) : null;
};
const lapsOf = (frame) => [...frame.matchAll(/^PLOT TEXT X \d+ Y \d+ STR (\d+\.\d) s$/gm)].map((m) => m[1]);

async function leg6() {
  console.log('\nleg 6 — stopwatch/index.html: a <div> textContent tick REPAINTS (the bridge)');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('stopwatch'));
    ok(mk.consoleLines().includes('stopwatch ready'), 'page script ran');

    let frame = await mk.redraw();
    checkSubresources(frame, 'stopwatch');
    const first = elapsedOf(frame);
    ok(first !== null, 'the elapsed readout laid out',
      `numeric runs: ${JSON.stringify([...frame.matchAll(/STR ([\d.]+)$/gm)].map((m) => m[1]))}`);
    ok(/PLOT TEXT X \d+ Y \d+ STR running$/m.test(frame), 'the watch is running at load');

    // No input at all from here: only the page's own setInterval can move
    // the number, and only a re-box can make the move visible.  Redraw in a
    // bounded loop until the PLOTTED value changes — a condition poll, not a
    // fixed sleep, and it gives up loudly rather than napping out its clock.
    let later = first;
    for (let i = 0; i < 60 && later === first; i++) {
      await new Promise((r) => setTimeout(r, 100));
      frame = await mk.redraw();
      later = elapsedOf(frame);
    }
    ok(later !== null && later > first,
      'the readout ADVANCED with zero user input — mutation reached the screen',
      `${first} -> ${later}`);

    // Structural insertion, the other mutation class.
    ok(lapsOf(frame).length === 0, 'no lap rows yet');
    let mark = mk.mark();
    mk.clickText(frame, 'Lap');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after Lap', from: mark });
    frame = await mk.redraw();
    ok(lapsOf(frame).length === 1, 'createElement + appendChild produced a VISIBLE row',
      `lap rows plotted: ${JSON.stringify(lapsOf(frame))}`);

    mark = mk.mark();
    mk.clickText(frame, 'Lap');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after second Lap', from: mark });
    frame = await mk.redraw();
    ok(lapsOf(frame).length === 2, 'a second insertion lands too',
      `lap rows plotted: ${JSON.stringify(lapsOf(frame))}`);

    // Stop, and prove the readout then holds still: this is what makes the
    // "it advanced" assertion above mean the TIMER moved it, not noise.
    mark = mk.mark();
    mk.clickText(frame, 'Stop');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after Stop', from: mark });
    frame = await mk.redraw();
    ok(/PLOT TEXT X \d+ Y \d+ STR stopped$/m.test(frame), 'the button relabelled itself and the state text changed');
    const held = elapsedOf(frame);
    await new Promise((r) => setTimeout(r, 600));   // stopped: no marker to wait on
    frame = await mk.redraw();
    ok(elapsedOf(frame) === held, 'a stopped watch does NOT drift', `${held} -> ${elapsedOf(frame)}`);

    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 7: todo.html (Lane B, removal + attribute restyle) ----------
const countOf = (frame) => {
  const m = frame.match(/^PLOT TEXT X \d+ Y \d+ STR (nothing to do|\d+ things? to do)$/m);
  return m ? m[1] : null;
};

async function leg7() {
  console.log('\nleg 7 — todo/index.html: removeChild + a class change REPAINT');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('todo'));
    ok(mk.consoleLines().includes('todo ready'), 'page script ran');

    let frame = await mk.redraw();
    checkSubresources(frame, 'todo');
    // The two seed rows are added while the parser is still live, so they
    // arrive through the NORMAL conversion — they are the control, not the
    // proof.  Everything after this point is post-load and is the proof.
    ok(/STR read the design doc$/m.test(frame) && /STR re-box the document$/m.test(frame),
      'the seed rows laid out (via the normal load-time conversion)');
    ok(countOf(frame) === '2 things to do', 'the counter starts at 2', `counter: ${countOf(frame)}`);

    let mark = mk.mark();
    mk.clickText(frame, 'Done read the design doc');
    await mk.wait(/LOG todo removed read the design doc$/m, { label: 'the remove handler running', from: mark });
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after removeChild', from: mark });
    frame = await mk.redraw();
    ok(!/STR read the design doc$/m.test(frame),
      'removeChild made the row DISAPPEAR from the layout');
    ok(/STR re-box the document$/m.test(frame), 'the other row survived');
    ok(countOf(frame) === '1 thing to do', 'the counter text re-rendered', `counter: ${countOf(frame)}`);

    mark = mk.mark();
    mk.clickText(frame, 'Done re-box the document');
    await mk.wait(/LOG todo removed re-box the document$/m, { label: 'the second remove handler', from: mark });
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'repaint after the second removeChild', from: mark });
    frame = await mk.redraw();
    ok(!/STR re-box the document$/m.test(frame), 'the list emptied');
    ok(countOf(frame) === 'nothing to do', 'the empty-state text is showing', `counter: ${countOf(frame)}`);
    // The class flipped to .empty too; monkey's plot stream carries no
    // colour, so the RESTYLE half of that is asserted by the kernel e2e's
    // pixel probe (grey #888 vs green #063), not here.

    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 8: the A/B baseline — with the bridge OFF, nothing moves -----
async function leg8() {
  console.log('\nleg 8 — A/B baseline: the SAME pages with the bridge compiled out must NOT change');
  const wasm = baselineWasm();

  const mk = new Monkey(RES_ON, { wasm });
  try {
    await mk.open(demo('stopwatch'));
    ok(mk.consoleLines().includes('stopwatch ready'), 'the page script still runs with the bridge off');

    let frame = await mk.redraw();
    const first = elapsedOf(frame);
    ok(first !== null, 'the readout laid out at load');

    // Give the 100 ms ticker plenty of turns.  There is no marker to wait
    // on here BECAUSE the thing being asserted is that no repaint is ever
    // requested — so this leg, like leg 4, has to watch a clock.
    const from = mk.mark();
    await new Promise((r) => setTimeout(r, 2000));
    const invalidates = (mk.out.slice(from).match(/INVALIDATE_AREA WIN \d+/g) || []).length;
    frame = await mk.redraw();
    ok(elapsedOf(frame) === first,
      'STOPWATCH: 2 s and ~20 timer ticks later the readout is UNCHANGED',
      `${first} -> ${elapsedOf(frame)} (${invalidates} repaint requests)`);
    ok(mk.consoleLines().includes('stopwatch ready'), 'the timer was really running (script alive)');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }

  const mk2 = new Monkey(RES_ON, { wasm });
  try {
    await mk2.open(demo('todo'));
    let frame = await mk2.redraw();
    ok(countOf(frame) === '2 things to do', 'the load-time rows DO appear (they predate the bridge)');

    const from = mk2.mark();
    mk2.clickText(frame, 'Done read the design doc');
    // The handler must still RUN — the DOM really changes; it is only the
    // screen that does not follow.  That is the whole point of the A/B.
    await mk2.wait(/LOG todo removed read the design doc$/m,
      { label: 'the remove handler running with the bridge off', from });
    await new Promise((r) => setTimeout(r, 500));
    frame = await mk2.redraw();
    ok(/STR read the design doc$/m.test(frame),
      'TODO: the removed row is STILL PAINTED — the DOM changed, the screen did not');
    ok(countOf(frame) === '2 things to do',
      'the counter text is stale too', `counter: ${countOf(frame)}`);
    ok(await mk2.quit() === 0, 'clean exit');
  } finally { mk2.kill(); }
}


// ---- leg 9: paint.html (Lane C — mouse events WITH coordinates) --------
/* The demo that was withheld until this lane.  Two things are asserted and
 * neither is eyeballed: the coordinates the page reports are the ones this
 * file injected, and the canvas pixel under them really changed. */
async function leg9() {
  console.log('\nleg 9 — paint/index.html: mousedown/mousemove/mouseup, WITH coordinates');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('paint'));
    ok(mk.consoleLines().includes('paint ready 512x512'), 'page script ran',
      `console lines: ${JSON.stringify(mk.consoleLines().slice(0, 5))}`);
    ok(mk.consoleLines().includes('paint scene drawn'),
      'the opening scene rasterised at load');

    const frame = await mk.redraw();
    checkSubresources(frame, 'paint');
    ok(/PLOT BITMAP X \d+ Y \d+ WIDTH 512 HEIGHT 512/.test(frame),
      'the 512x512 pad is plotted as a bitmap');

    // A press at an EXACT document coordinate.  The canvas is pinned to the
    // document origin by paint.css, so this is also a canvas pixel.
    const DOWN = { x: 40, y: 30 };
    const UP = { x: 160, y: 90 };
    let from = mk.mark();
    mk.drag(DOWN, UP, 3);
    await mk.wait(/LOG paint stroke 1 done/, { label: 'the stroke completing', from });

    const said = [...mk.out.slice(from).matchAll(/LOG paint (down|move|up) page (-?\d+),(-?\d+) client (-?\d+),(-?\d+) buttons (\d+)$/gm)]
      .map((m) => ({ what: m[1], x: Number(m[2]), y: Number(m[3]),
                     cx: Number(m[4]), cy: Number(m[5]), buttons: Number(m[6]) }));

    const down = said.find((e) => e.what === 'down');
    ok(down !== undefined, 'a mousedown reached the page at all');
    // THE assertion of this lane: a real coordinate, not `undefined`, and
    // the exact one that was injected.
    ok(down && down.x === DOWN.x && down.y === DOWN.y,
      `the mousedown carried the coordinate it was given (${DOWN.x},${DOWN.y})`,
      `page reported: ${down ? `${down.x},${down.y}` : 'nothing'}`);
    ok(down && down.buttons === 1, 'mousedown reports the primary button held',
      `buttons: ${down ? down.buttons : 'none'}`);
    ok(down && down.cx === DOWN.x && down.cy === DOWN.y,
      'clientX/clientY match pageX/pageY on an unscrolled page',
      `client: ${down ? `${down.cx},${down.cy}` : 'nothing'}`);

    const moves = said.filter((e) => e.what === 'move');
    ok(moves.length >= 3, 'mousemove fires during the drag',
      `${moves.length} moves seen`);
    ok(moves.every((m) => m.buttons === 1),
      'a move during a drag reports the button still held',
      `buttons seen: ${JSON.stringify(moves.map((m) => m.buttons))}`);
    ok(moves.some((m) => m.x !== DOWN.x || m.y !== DOWN.y),
      'the moves carry DIFFERENT coordinates from the press (they track the pointer)',
      `coords: ${JSON.stringify(moves.map((m) => `${m.x},${m.y}`))}`);

    const up = said.find((e) => e.what === 'up');
    ok(up !== undefined, 'a mouseup reached the page at the end of the drag');
    ok(up && up.x === UP.x && up.y === UP.y,
      `the mouseup carried the release coordinate (${UP.x},${UP.y})`,
      `page reported: ${up ? `${up.x},${up.y}` : 'nothing'}`);
    ok(up && up.buttons === 0, 'mouseup reports no button held any more',
      `buttons: ${up ? up.buttons : 'none'}`);

    // …and the coordinates were USABLE.  WINDOW EXEC cannot be used to
    // probe a canvas pixel (it reports success and does nothing — see the
    // design doc §8.6), so the page's own readout is the channel: it is an
    // <input value=> the handler writes, which repaints.
    const readout = (await mk.redraw()).match(/PLOT TEXT X \d+ Y \d+ STR (up \d+,\d+)$/m);
    ok(readout !== null, 'the page shows the last coordinate it was given',
      `readout: ${readout ? readout[1] : 'not plotted'}`);
    ok(readout && readout[1] === `up ${UP.x},${UP.y}`,
      'and it is the release coordinate', `readout: ${readout ? readout[1] : 'none'}`);

    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 10: events.html (Lane C — ordering, keys, forms) -------------
/* The trail the page records is `id:phase id:phase …` in dispatch order.
 * Capture must run outer -> middle BEFORE the target, and bubble must come
 * back middle -> outer after it. */
const trailOf = (out, from) => {
  const m = [...out.slice(from).matchAll(/LOG events trail (.*)$/gm)];
  return m.length ? m[m.length - 1][1].trim().split(/\s+/) : null;
};

async function leg10() {
  console.log('\nleg 10 — events/index.html: capture BEFORE bubble, keys at the focused field');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('events'));
    ok(mk.consoleLines().includes('events ready'), 'page script ran');
    // window.addEventListener('load', …) registered a callback that could
    // never be invoked before this lane: the Window is not a node, so it is
    // not in libdom's propagation chain and nothing else looked at it.
    ok(mk.consoleLines().includes('events window load listener ran'),
      'window.addEventListener("load") FIRED',
      `console lines: ${JSON.stringify(mk.consoleLines())}`);

    let frame = await mk.redraw();
    checkSubresources(frame, 'events');

    let from = mk.mark();
    mk.clickText(frame, 'click me');
    await mk.wait(/LOG events trail /, { label: 'the click walking the tree', from });
    const trail = trailOf(mk.out, from);

    // The exact order, not "capture happened somewhere".  Each element
    // carries a capture AND a bubble listener — the pair that used to make
    // the element completely deaf.
    const want = ['outer:capture', 'middle:capture',
                  'inner:target', 'inner:target',
                  'middle:bubble', 'outer:bubble'];
    ok(JSON.stringify(trail) === JSON.stringify(want),
      'capture ran outer->middle BEFORE the target, then bubble ran middle->outer',
      `trail: ${JSON.stringify(trail)}\n       want: ${JSON.stringify(want)}`);

    const at = mk.out.slice(from).match(/LOG events click at (-?\d+),(-?\d+) detail (\d+)$/m);
    ok(at !== null && at[1] !== 'undefined',
      'the click itself carried coordinates (it is a MouseEvent now)',
      `reported: ${at ? at[0] : 'nothing'}`);
    ok(at && Number(at[3]) === 1, 'and a click count of 1',
      `detail: ${at ? at[3] : 'none'}`);

    // Keyboard: click INTO the text field first.  keydown is delivered to
    // the FOCUSED element now (it used to go to the document root
    // regardless), so the listener on the <input> only runs if focus
    // really moved there.
    from = mk.mark();
    frame = await mk.redraw();
    mk.pressText(frame, 'edit me');
    await mk.wait(/LOG events focus:text$/m,
      { label: 'the field taking focus', from });
    ok(true, 'clicking a text field fires focus at it');

    from = mk.mark();
    mk.key(0x61, 'DOWN');   // 'a'
    mk.key(0x61, 'UP');
    mk.key(13, 'DOWN');     // NS_KEY_CR
    mk.key(13, 'UP');
    await mk.wait(/LOG events keyup:Enter$/m,
      { label: 'Enter arriving with a key NAME', from });
    const keys = [...mk.out.slice(from).matchAll(/LOG events (key(?:down|up|input|change):\S*)$/gm)]
      .map((m) => m[1]);
    ok(keys.includes('keydown:a') && keys.includes('keyup:a'),
      'keydown AND keyup reached the focused field', `keys: ${JSON.stringify(keys)}`);
    ok(keys.includes('keydown:Enter') && keys.includes('keyup:Enter'),
      'Enter has a key name (it used to arrive as null)',
      `keys: ${JSON.stringify(keys)}`);
    ok(mk.out.slice(from).includes('LOG events input:'),
      'typing fired an `input` event', `keys: ${JSON.stringify(keys)}`);

    // Press somewhere that takes focus away from the field: `change` is
    // the commit-on-blur event, so it must wait for the blur and must
    // then carry the EDITED value.
    from = mk.mark();
    frame = await mk.redraw();
    mk.pressText(frame, 'outer');
    await mk.wait(/LOG events blur:text$/m,
      { label: 'the field losing focus', from });
    ok(true, 'clicking away fires `blur` at the field');
    const changed = mk.out.slice(from).match(/LOG events change:(.*)$/m);
    ok(changed !== null, 'and `change`, because the value was edited',
      `saw: ${JSON.stringify((mk.out.slice(from).match(/LOG events \S+/g) || []))}`);
    ok(changed && changed[1] !== 'edit me',
      'and it carries the edited value, not the original',
      `change: ${changed ? changed[1] : 'none'}`);

    // The submit button: a cancelable submit that preventDefault() stops.
    from = mk.mark();
    frame = await mk.redraw();
    mk.pressText(frame, 'Submit');
    await mk.wait(/LOG events submit$/m, { label: 'the submit handler', from });
    ok(true, 'a cancelable submit fired');
    ok(!/START_THROBBER/.test(mk.out.slice(from)),
      'the form did NOT navigate — preventDefault() really prevented it');

    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 11: the Lane C A/B baseline ---------------------------------
/* Compiled with -DNETSURF_NO_UI_EVENTS, the same two pages must receive
 * NOTHING, while their scripts still demonstrably run.  A demo that passes
 * with and without the change proves nothing. */
async function leg11() {
  console.log('\nleg 11 — A/B baseline: the SAME pages with Lane C compiled out receive nothing');
  const wasm = noEventsWasm();

  const mk = new Monkey(RES_ON, { wasm });
  try {
    await mk.open(demo('paint'));
    ok(mk.consoleLines().includes('paint ready 512x512'),
      'the page script still runs with the events compiled out');

    const from = mk.mark();
    mk.drag({ x: 40, y: 30 }, { x: 160, y: 90 }, 3);
    // Nothing to wait ON — the assertion IS that nothing arrives — so this
    // leg, like legs 4 and 8, has to watch a clock.
    await new Promise((r) => setTimeout(r, 800));
    const said = mk.out.slice(from).match(/LOG paint (down|move|up) /g) || [];
    ok(said.length === 0,
      'PAINT: not one mousedown/mousemove/mouseup was delivered',
      `delivered: ${JSON.stringify(said)}`);
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }

  const mk2 = new Monkey(RES_ON, { wasm });
  try {
    await mk2.open(demo('events'));
    ok(mk2.consoleLines().includes('events ready'), 'the events page script runs too');

    const from = mk2.mark();
    const frame = await mk2.redraw();
    mk2.clickText(frame, 'click me');
    await mk2.wait(/LOG events trail /, { label: 'the click still reaching bubble listeners', from });
    const trail = trailOf(mk2.out, from);
    // The click still bubbles — that always worked.  What must NOT be
    // there is any capture-phase step.
    ok(trail !== null && trail.every((t) => !t.endsWith(':capture')),
      'EVENTS: no capture-phase listener ran at all',
      `trail: ${JSON.stringify(trail)}`);

    const at = mk2.out.slice(from).match(/LOG events click at ([^ ]+),/m);
    ok(at !== null && at[1] === 'undefined',
      'and the click carried NO coordinates (a plain Event again)',
      `reported: ${at ? at[0] : 'nothing'}`);

    const before = mk2.mark();
    mk2.key(13, 'DOWN');
    mk2.key(13, 'UP');
    await new Promise((r) => setTimeout(r, 500));
    const keys = mk2.out.slice(before).match(/LOG events key(?:down|up):\S+/g) || [];
    ok(keys.length === 0,
      'and no keydown/keyup reached the field (keydown went to the root)',
      `delivered: ${JSON.stringify(keys)}`);
    ok(await mk2.quit() === 0, 'clean exit');
  } finally { mk2.kill(); }
}

// ---- leg 12: plasma (the headline canvas demo) -------------------------
/* Same machinery as sketch's leg 3 — a timer-driven ImageData animation —
 * plus an honest frame-rate measurement: the frames counter the page
 * plots is read twice across a measured wall-clock window, so the rate
 * this demo really achieves is a printed number, not a guess. */
async function leg12() {
  console.log('\nleg 12 — plasma/index.html: the animated plasma field');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(demo('plasma'));
    ok(mk.consoleLines().includes('plasma ready 320x200'), 'page script ran',
      `console lines: ${JSON.stringify(mk.consoleLines().slice(0, 5))}`);

    const from = mk.mark();
    await mk.wait(/INVALIDATE_AREA WIN \d+[\s\S]*?INVALIDATE_AREA WIN \d+/,
      { label: 'two timer-driven plasma repaints (no input at all)', from });
    ok(true, 'the plasma animates with ZERO user input');

    let frame = await mk.redraw();
    checkSubresources(frame, 'plasma');
    ok(/PLOT BITMAP X \d+ Y \d+ WIDTH 320 HEIGHT 200/.test(frame),
      'the 320x200 plasma canvas is plotted as a bitmap');

    /* The frame-rate measurement: counter at t0, counter at t0+3s. */
    const framesOf = (f) => {
      const m = f.match(/PLOT TEXT X \d+ Y \d+ STR (\d+) frames$/m);
      return m ? Number(m[1]) : null;
    };
    const n0 = framesOf(frame);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 3000));   // measurement window, not a sync sleep
    frame = await mk.redraw();
    const n1 = framesOf(frame);
    const secs = (Date.now() - t0) / 1000;
    const fps = n0 !== null && n1 !== null ? (n1 - n0) / secs : null;
    ok(fps !== null && fps > 1,
      `the plasma really animates (measured ${fps === null ? '?' : fps.toFixed(1)} fps over ${secs.toFixed(1)}s)`,
      `frame counter: ${n0} -> ${n1}`);

    const palFrom = mk.mark();
    mk.clickText(frame, 'Palette');
    await mk.wait(/LOG plasma palette 1$/m, { label: 'palette-switch click', from: palFrom });
    ok(true, 'clicking through to the palette handler works');

    const stopFrom = mk.mark();
    frame = await mk.redraw();
    mk.clickText(frame, 'Stop / go');
    await mk.wait(/LOG plasma stopped$/m, { label: 'clearInterval click', from: stopFrom });
    ok(true, 'clearInterval stops the animation');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- legs 13-16: the pointer path and its A/B baselines ---------------
/* The Y a labelled text was plotted at — the geometry probe the hover legs
 * are built on, since the plot stream carries no colours. */
function textYOf(frame, label) {
  const m = frame.match(new RegExp(`PLOT TEXT X \\d+ Y (\\d+) STR ${label}$`, 'm'));
  if (!m) throw new Error(`no plotted text "${label}" in this frame`);
  return Number(m[1]);
}

// ---- leg 13: ptr-click.html (0419 — a cancelled click stops the action)
async function leg13() {
  console.log('\nleg 13 — test/ptr-click.html: preventDefault() on a link click stops the navigation');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(testPage('ptr-click.html'));
    ok(mk.consoleLines().includes('ptr ready'), 'page script ran');

    let frame = await mk.redraw();
    let from = mk.mark();
    mk.pressText(frame, 'cancelled link');
    await mk.wait(/LOG ptr click cancelled$/m, { label: 'the cancelling listener', from });
    /* Nothing to wait ON — the assertion IS that no navigation starts —
     * so this half, like legs 4/8/11, has to watch a clock. */
    await new Promise((r) => setTimeout(r, 800));
    ok(!/START_THROBBER/.test(mk.out.slice(from)),
      '0419: the cancelled click did NOT navigate');
    frame = await mk.redraw();
    ok(/STR cancelled link$/m.test(frame), 'page A is still on screen');

    /* The control that keeps the fix honest: a listener that runs and does
     * not cancel must still navigate — a "fix" that dropped every
     * navigation would pass the half above. */
    from = mk.mark();
    mk.pressText(frame, 'plain link');
    await mk.wait(/LOG ptr click plain$/m, { label: 'the plain listener', from });
    await mk.wait(new RegExp(`START_THROBBER WIN ${mk.win}[\\s\\S]*?STOP_THROBBER WIN ${mk.win}`),
      { label: 'the uncancelled navigation', from });
    frame = await mk.redraw();
    ok(/STR page B landed$/m.test(frame), 'the uncancelled click reached page B');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 14: ptr-hover.html (0420 — :hover / :active really apply) ----
/* Both dynamic rules change geometry (`:hover { height: 180px }`), so the
 * proof is the "below marker" text moving by the rule's exact delta — and
 * every transition's INVALIDATE_AREA is the wait marker. */
async function leg14() {
  console.log('\nleg 14 — test/ptr-hover.html: :hover and :active apply, transitions repaint');
  const mk = new Monkey(RES_ON);
  try {
    await mk.open(testPage('ptr-hover.html'));
    let frame = await mk.redraw();
    const y0 = textYOf(frame, 'below marker');

    /* Park the pointer on a subject with no dynamic rule first, so the
     * next move is a pure enter transition.  Entering #far changes no
     * computed style, so it plots nothing to wait for — the following
     * commands are ordered behind it on stdin. */
    let at = mk.clickTextAt(frame, 'far corner');
    mk.mouse('TRACK', at.x, at.y);

    /* enter: the link grows by 80px and everything below it moves */
    let from = mk.mark();
    at = mk.clickTextAt(frame, 'hover me');
    mk.mouse('TRACK', at.x, at.y);
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'the hover-enter repaint', from });
    frame = await mk.redraw();
    ok(textYOf(frame, 'below marker') === y0 + 80,
      '0420 hover: a:hover applied (the marker moved by the rule\'s 80px)',
      `y ${y0} -> ${textYOf(frame, 'below marker')}`);

    /* leave: the base geometry comes BACK — the exit half of the delta */
    from = mk.mark();
    at = mk.clickTextAt(frame, 'far corner');
    mk.mouse('TRACK', at.x, at.y);
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'the hover-exit repaint', from });
    frame = await mk.redraw();
    ok(textYOf(frame, 'below marker') === y0,
      '0420 unhover: the base geometry came back when the pointer left');

    /* :active — armed by the press, held while the button is down */
    from = mk.mark();
    at = mk.clickTextAt(frame, 'press me');
    mk.mouse('CLICK', at.x, at.y, 'PRESS_1');
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'the :active repaint', from });
    frame = await mk.redraw();
    ok(textYOf(frame, 'below marker') === y0 + 60,
      '0420 active: #press:active applied while the button was held',
      `y ${y0} -> ${textYOf(frame, 'below marker')}`);

    /* release: cleared again */
    from = mk.mark();
    mk.mouse('TRACK', at.x, at.y);
    await mk.wait(/INVALIDATE_AREA WIN \d+/, { label: 'the release repaint', from });
    frame = await mk.redraw();
    ok(textYOf(frame, 'below marker') === y0,
      '0420 active: and cleared at the release');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 15: the 0419 A/B baseline ------------------------------------
/* Compiled with -DNETSURF_NO_CLICK_CANCEL, the SAME page's cancelling
 * listener still runs — and the navigation happens anyway, because the
 * dispatch result is thrown away again.  That is pristine upstream. */
async function leg15() {
  console.log('\nleg 15 — A/B baseline: with 0419 compiled out, the cancelled click navigates anyway');
  const wasm = noClickCancelWasm();
  const mk = new Monkey(RES_ON, { wasm });
  try {
    await mk.open(testPage('ptr-click.html'));
    ok(mk.consoleLines().includes('ptr ready'),
      'the page script still runs with the switch on');

    const frame = await mk.redraw();
    const from = mk.mark();
    mk.pressText(frame, 'cancelled link');
    await mk.wait(/LOG ptr click cancelled$/m,
      { label: 'the cancelling listener still running', from });
    await mk.wait(new RegExp(`START_THROBBER WIN ${mk.win}[\\s\\S]*?STOP_THROBBER WIN ${mk.win}`),
      { label: 'the navigation the cancel could not stop', from });
    const after = await mk.redraw();
    ok(/STR page B landed$/m.test(after),
      'BASELINE: preventDefault() was ignored — the link navigated to page B');
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- leg 16: the 0420 A/B baseline ------------------------------------
/* Compiled with -DNETSURF_NO_DYNAMIC_PSEUDO, the SAME moves and press must
 * repaint NOTHING and move NOTHING: node_is_hover answers "no match" the
 * way the upstream `\todo` stub did. */
async function leg16() {
  console.log('\nleg 16 — A/B baseline: with 0420 compiled out, :hover and :active never apply');
  const wasm = noDynPseudoWasm();
  const mk = new Monkey(RES_ON, { wasm });
  try {
    await mk.open(testPage('ptr-hover.html'));
    let frame = await mk.redraw();
    const y0 = textYOf(frame, 'below marker');

    const from = mk.mark();
    let at = mk.clickTextAt(frame, 'hover me');
    mk.mouse('TRACK', at.x, at.y);
    at = mk.clickTextAt(frame, 'press me');
    mk.mouse('CLICK', at.x, at.y, 'PRESS_1');
    /* Nothing to wait ON — the assertion IS that nothing repaints — so
     * this leg, like legs 4/8/11, has to watch a clock. */
    await new Promise((r) => setTimeout(r, 800));
    ok(!/INVALIDATE_AREA/.test(mk.out.slice(from)),
      'BASELINE: neither the hover move nor the press repainted anything');
    frame = await mk.redraw();
    ok(textYOf(frame, 'below marker') === y0,
      'BASELINE: and the geometry never moved (no rule ever applied)',
      `y ${y0} -> ${textYOf(frame, 'below marker')}`);
    mk.mouse('TRACK', at.x, at.y);   /* release before quitting */
    ok(await mk.quit() === 0, 'clean exit');
  } finally { mk.kill(); }
}

// ---- run --------------------------------------------------------------
// Index IS the leg number (leg 0 is the shipped-set gate), so `--leg 2`
// still means leg 2.
const LEGS = [leg0, leg1, leg2, leg3, leg4, leg5, leg6, leg7, leg8, leg9, leg10, leg11, leg12, leg13, leg14, leg15, leg16];
const t0 = Date.now();
for (let i = 0; i < LEGS.length; i++) {
  if (ONLY.length && !ONLY.includes(i)) continue;
  try {
    await LEGS[i]();
  } catch (e) {
    console.log(`  FAIL leg ${i} threw: ${e.message}`);
    fails.push(`leg ${i}: ${e.message.split('\n')[0]}`);
  }
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (fails.length === 0) {
  console.log(`\nSMOKE-JS PASS: JavaScript executes, dispatches clicks and repaints (${secs}s${built ? ', fresh build' : ''})`);
  process.exit(0);
}
console.error(`\nSMOKE-JS FAIL (${secs}s): ${fails.length} assertion(s)\n  - ${fails.join('\n  - ')}`);
process.exit(1);
