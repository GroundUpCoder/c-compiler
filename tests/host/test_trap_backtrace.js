#!/usr/bin/env node
'use strict';
// #759 (design: #732) — a wasm trap must deliver a legible, symbolicated
// backtrace to the PROCESS'S OWN fd 2.
//
// This file is written against #759's ACCEPTANCE TEXT, not against the
// implementation. Concretely, that discipline means:
//
//   * Every expected function name and every expected source LINE NUMBER is
//     DERIVED FROM THE FIXTURE SOURCE at run time (by locating a marker
//     comment), never hard-coded and never read back out of the produced
//     output. If the compiler's line attribution regressed, these assertions
//     would fail — which is the point. A test that harvested its expectations
//     from the thing under test would confirm the implementation instead of
//     the rule.
//   * Assertions are on SEMANTIC properties the acceptance names (this name
//     appears; this file:line appears; no source location appears when there
//     is no source map) rather than on exact layout, so reformatting the
//     renderer does not force a test edit and cannot mask a real regression.
//
// The acceptance clauses, and the leg that pins each:
//
//   1. `cc -g` + trap -> symbolicated backtrace (function name + file:line per
//      frame) on the process's OWN fd 2, capturable by an ordinary `2>`
//      redirection.                                        -> legs A1, A2
//   2. No `-g` -> indices and offsets plus an explicit note naming `cc -g` as
//      the fix; NO invented names, NO invented locations.   -> leg B
//   3. Red-then-green, positive-controlled.                 -> leg E (a clean
//      program must produce NO backtrace, so this file cannot pass vacuously)
//   4. Negatives: a module that fails to INSTANTIATE, and any non-trap
//      rejection, produce NO backtrace.                     -> legs C1, C2
//   5. Exit status and the kernel-facing failure are UNCHANGED — strictly
//      additive.                                            -> leg D
//   6. The frame limit is raised so a deep chain still reaches main().
//                                                           -> leg F
//   7. Browser flavour: NOT covered here. host.js is shared by both flavours
//      and this suite is Node-only; the browser leg is owed separately and is
//      recorded as such in #759.
//
// Run: node tests/host/test_trap_backtrace.js

var assert = require('assert');
var path = require('path');
var ROOT = path.resolve(__dirname, '..', '..');
var CC = require(path.join(ROOT, 'compiler.js'));
var HOST = require(path.join(ROOT, 'host.js'));
var COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
var runModule = HOST;                    // host.js exports runModule itself
var BLOCK_FS = HOST.BLOCK_FS;

var O_WRONLY = 0x1, O_CREAT = 0x40, O_TRUNC = 0x200, O_RDONLY = 0x0;

// The most recent harness fs, so a leg whose run never settles (H) can still
// read what the process wrote before it hung.
var lastKfs = null;

/* Leg H deliberately exercises a path whose promise NEVER SETTLES: a trap in
 * the animation-frame callback rethrows from an unobserved async `doFrame`.
 * Under Node's default that unhandled rejection KILLS THE PROCESS, so without
 * this handler the leg cannot run at all.
 *
 * 🔴 This is NOT a blanket suppressor. Every rejection captured here is
 * accounted for at the end of the file: anything that is not the trap leg H
 * expects fails the run. When the separately-filed lifecycle defect is fixed
 * (the frame loop should settle instead of rejecting into the void), this
 * handler and its accounting come out. */
var unhandled = [];
process.on('unhandledRejection', function (e) { unhandled.push(e); });

var failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '\n         ' + extra : '')); failures++; }
}

// ---- the fixture -----------------------------------------------------------
// Marker comments carry the line's identity; the EXPECTED line numbers are
// looked up from this text, so the assertions track the source rather than
// duplicating it. noinline is deliberate: the acceptance speaks of "per frame",
// and frames the optimiser erased are not frames. The inlined case has its own
// leg (G) asserting the limitation is DECLARED rather than papered over.
var FIXTURE = [
  '#include <stdio.h>',
  '',
  '__attribute__((noinline)) static int depth3(int *p) {',
  '  return *p;                     /* MARK_FAULT */',
  '}',
  '',
  '__attribute__((noinline)) static int depth2(int *p) {',
  '  return depth3(p) + 1;          /* MARK_D2 */',
  '}',
  '',
  '__attribute__((noinline)) static int depth1(int n) {',
  '  int *bad = (int *)(0x7ffffff0 + n);',
  '  return depth2(bad);            /* MARK_D1 */',
  '}',
  '',
  'int main(void) {',
  '  printf("before\\n");',
  '  fflush(stdout);',
  '  return depth1(4);              /* MARK_MAIN */',
  '}',
  '',
].join('\n');

// 1-based line number of the line bearing `marker`.
function lineOf(src, marker) {
  var lines = src.split('\n');
  for (var i = 0; i < lines.length; i++) if (lines[i].indexOf(marker) >= 0) return i + 1;
  throw new Error('fixture lost its ' + marker + ' marker — the test can no longer state an expectation');
}

// ---- harness ---------------------------------------------------------------
// Compiles SRC with the in-OS cc driver (the compiler #759's acceptance names),
// then runs it over a real BlockFS. `redirectErr` dup2s a file onto fd 2 so the
// "capturable by an ordinary 2> redirection" clause is tested as written: the
// bytes must land in the FILE, and must NOT leak to the console writer.
function buildAndRun(opts) {
  var srcName = opts.srcName || '/fix.c';
  var store = new BLOCK_FS.MemoryByteStore(opts.storeSize || (8 * 1024 * 1024));
  var kfs = BLOCK_FS.create(store);
  var enc = new TextEncoder(), dec = new TextDecoder();

  var sfd = kfs.open(srcName, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  var sb = enc.encode(opts.src);
  kfs.write(sfd, sb, sb.length);
  kfs.close(sfd);

  var driver = COMMON.createCcDriver(CC, kfs);
  var argv = ['cc'].concat(opts.ccFlags || []).concat([srcName, '-o', '/a.wasm']);
  var built = driver(argv, '/');
  assert.strictEqual(built.exitCode, 0, 'fixture failed to compile: ' + built.stderr);

  var st = kfs.stat('/a.wasm');
  var wfd = kfs.open('/a.wasm', O_RDONLY);
  var bytes = new Uint8Array(st.size);
  kfs.read(wfd, bytes, st.size);
  kfs.close(wfd);

  var consoleOut = [], consoleErr = [];
  if (opts.patchBytes) bytes = opts.patchBytes(bytes);
  lastKfs = kfs;          // leg H needs this before the run can hang

  return runModule({
    bytes: bytes,
    args: ['/a.wasm'],   // a program is invoked by its binary name, not its source
    blockFsFactory: function (ctx) {
      var env = BLOCK_FS.BlockFS.prototype.toWasmEnv.call(kfs, ctx);
      if (opts.redirectErr) {
        var efd = kfs.open(opts.redirectErr, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
        kfs.dup2(efd, 2);
        kfs.close(efd);
      }
      if (opts.mutateEnv) opts.mutateEnv(env);
      if (opts.afterEnv) opts.afterEnv(kfs);
      return Promise.resolve({ c: env });
    },
    writeOut: function (b) { consoleOut.push(dec.decode(b instanceof Uint8Array ? b : new Uint8Array(b))); },
    writeErr: function (b) { consoleErr.push(dec.decode(b instanceof Uint8Array ? b : new Uint8Array(b))); },
  }).then(function (code) {
    return { settled: 'resolved', exitCode: code, consoleErr: consoleErr.join(''), consoleOut: consoleOut.join(''), kfs: kfs };
  }, function (err) {
    return { settled: 'rejected', error: err, consoleErr: consoleErr.join(''), consoleOut: consoleOut.join(''), kfs: kfs };
  });
}

function readFile(kfs, p) {
  var st = kfs.stat(p);
  if (!st) return null;
  var fd = kfs.open(p, O_RDONLY);
  var b = new Uint8Array(st.size);
  kfs.read(fd, b, st.size);
  kfs.close(fd);
  return new TextDecoder().decode(b);
}


// Rename ONE function import's field name in place (same length) so the host
// cannot supply it. The module still COMPILES and then fails to INSTANTIATE —
// which is #558's real cause reproduced exactly: an ABI change retired a host
// symbol that a prebuilt wasm still imports. Used by leg C1.
function breakOneImport(bytes) {
  var b = Uint8Array.from(bytes), i = 8;
  function u() { var v = 0, s = 0, x; do { x = b[i++]; v |= (x & 127) << s; s += 7; } while (x & 128); return v >>> 0; }
  while (i < b.length) {
    var id = b[i++], n = u(), end = i + n;
    if (id === 2) {
      var count = u();
      for (var k = 0; k < count; k++) {
        var mlen = u(); i += mlen;
        var flen = u(), fstart = i; i += flen;
        var kind = b[i++];
        if (kind === 0) u();
        else if (kind === 1) { i++; var fl = u(); u(); if (fl) u(); }
        else if (kind === 2) { var fl2 = b[i++]; u(); if (fl2 === 1) u(); }
        else if (kind === 3) { i++; i++; }
        if (kind === 0 && flen > 0) { b[fstart + flen - 1] = 0x5a; return b; }
      }
    }
    i = end;
  }
  throw new Error('fixture has no function import to break — leg C1 can no longer state its premise');
}

// A "source location" as the acceptance means it: <something>.c:<number>.
var LOC_RE = /[A-Za-z0-9_./-]+\.c:\d+/g;

async function main() {
  var FAULT = lineOf(FIXTURE, 'MARK_FAULT');
  var D2 = lineOf(FIXTURE, 'MARK_D2');
  var D1 = lineOf(FIXTURE, 'MARK_D1');
  var MAIN = lineOf(FIXTURE, 'MARK_MAIN');
  console.log('#759 trap backtrace — expectations derived from the fixture: ' +
              'fault@' + FAULT + ' d2@' + D2 + ' d1@' + D1 + ' main@' + MAIN);

  // ---- A1: cc -g, fd 2 REDIRECTED — the acceptance's headline clause -------
  console.log('\nA1. cc -g, fd 2 redirected to a file (the `2> err.log` clause)');
  var a1 = await buildAndRun({ src: FIXTURE, ccFlags: ['-g'], redirectErr: '/err.log' });
  var errFile = readFile(a1.kfs, '/err.log');
  check('the program really trapped (harness sanity)', a1.settled === 'rejected',
        'settled=' + a1.settled + ' exit=' + a1.exitCode);
  check('/err.log exists and is non-empty', !!errFile && errFile.length > 0,
        'got ' + JSON.stringify(errFile));
  errFile = errFile || '';
  ['depth3', 'depth2', 'depth1', 'main'].forEach(function (fn) {
    check('fd 2 names the frame `' + fn + '`', new RegExp('\\b' + fn + '\\b').test(errFile));
  });
  [['fault', FAULT], ['depth2 call', D2], ['depth1 call', D1], ['main call', MAIN]].forEach(function (pair) {
    check('fd 2 carries the ' + pair[0] + ' location fix.c:' + pair[1],
          new RegExp('fix\\.c:' + pair[1] + '\\b').test(errFile));
  });
  check('the redirect was respected — nothing leaked to the console writer',
        a1.consoleErr.indexOf('depth3') < 0, 'consoleErr=' + JSON.stringify(a1.consoleErr.slice(0, 200)));

  // ---- A2: cc -g, default fd 2 --------------------------------------------
  console.log('\nA2. cc -g, default (unredirected) fd 2');
  var a2 = await buildAndRun({ src: FIXTURE, ccFlags: ['-g'] });
  check('an unredirected trap still reports on stderr', /depth3/.test(a2.consoleErr),
        'consoleErr=' + JSON.stringify(a2.consoleErr.slice(0, 200)));
  check('and it carries the faulting line fix.c:' + FAULT,
        new RegExp('fix\\.c:' + FAULT + '\\b').test(a2.consoleErr));

  // ---- B: no -g — honest degradation, nothing invented ---------------------
  console.log('\nB. built WITHOUT -g: indices + offsets + a note naming the fix, nothing invented');
  var b = await buildAndRun({ src: FIXTURE, ccFlags: [], redirectErr: '/err.log' });
  var bTxt = readFile(b.kfs, '/err.log') || '';
  check('a stripped binary still produces a report on fd 2', bTxt.length > 0);
  check('it identifies the frame by index', /\b\d+\b/.test(bTxt) && /func|function/i.test(bTxt),
        JSON.stringify(bTxt.slice(0, 200)));
  check('it names `cc -g` as the fix', /cc -g/.test(bTxt), JSON.stringify(bTxt.slice(0, 300)));
  check('NO INVENTED NAMES: no fixture function name appears', !/\bdepth3\b|\bdepth2\b|\bdepth1\b/.test(bTxt),
        JSON.stringify(bTxt.slice(0, 300)));
  check('NO INVENTED LOCATIONS: no file:line appears', (bTxt.match(LOC_RE) || []).length === 0,
        'found ' + JSON.stringify(bTxt.match(LOC_RE)));

  // ---- C1: a module that never INSTANTIATES must produce no backtrace ------
  console.log('\nC1. instantiation failure (#558/#752 territory) — must stay silent');
  var c1 = await buildAndRun({
    src: FIXTURE, ccFlags: ['-g'], redirectErr: '/err.log',
    // The module compiles but cannot LINK, so it never executes an
    // instruction. A backtrace here would be a lie about a process that never
    // ran (#752's finding, #558's failure class).
    patchBytes: breakOneImport,
  });
  var c1Txt = readFile(c1.kfs, '/err.log') || '';
  check('instantiation really failed with a LinkError (leg premise)',
        c1.settled === 'rejected' && c1.error instanceof WebAssembly.LinkError,
        'settled=' + c1.settled + ' err=' + (c1.error && c1.error.constructor.name) +
        ': ' + (c1.error && String(c1.error.message).slice(0, 120)));
  check('a LinkError is NOT a RuntimeError (the discriminator this rests on)',
        !(c1.error instanceof WebAssembly.RuntimeError));
  check('NO backtrace for a process that never ran',
        !/wasm-function|backtrace/i.test(c1Txt), JSON.stringify(c1Txt.slice(0, 300)));

  // ---- C2: a non-trap rejection must produce no backtrace ------------------
  console.log('\nC2. a non-trap failure — must stay silent');
  var c2 = await buildAndRun({
    src: FIXTURE, ccFlags: ['-g'], redirectErr: '/err.log',
    mutateEnv: function (env) {
      var orig = env.write;
      env.write = function () { throw new TypeError('injected non-trap host failure'); };
      void orig;
    },
  });
  var c2Txt = readFile(c2.kfs, '/err.log') || '';
  check('the injected non-trap failure really happened (leg premise)',
        c2.settled === 'rejected' && !(c2.error instanceof WebAssembly.RuntimeError),
        'settled=' + c2.settled + ' err=' + (c2.error && c2.error.constructor.name));
  check('a non-RuntimeError rejection produces no backtrace',
        !/wasm-function|backtrace/i.test(c2Txt), JSON.stringify(c2Txt.slice(0, 300)));

  // ---- D: strictly additive — HALF of acceptance clause 5 -----------------
  //
  // 🔴 SCOPE OF THIS LEG, stated because the first version of it overclaimed.
  // Clause 5 is written in EXTERNALLY OBSERVABLE terms: "exit status is
  // unchanged (139 / W_TERMSIG(SIG.SEGV)), and the `crashed` message to the
  // kernel is unchanged". This suite is host-only: there is no kernel here,
  // no process worker, and no wait status, so it CANNOT observe any of those.
  // What it can pin is the mechanism's near end — that runModule still rejects
  // with the ORIGINAL error object, which is what os/process-worker.js turns
  // into the `crashed` message.
  //
  // The far end — `crashed` -> W_TERMSIG(SIG.SEGV) -> a parent observing
  // 139 — is pinned by tests/kernel/test_trap_report_delivery.js, and the two
  // are tied end-to-end by tests/kernel/test_trap_backtrace_e2e.js, which
  // asserts a literal `exit=139` from inside the guest.
  //
  // Saying "this is half the clause, and here is where the other half lives"
  // is the point: the first version of this leg asserted the mechanism while
  // claiming the observable, which is a proxy standing in for a requirement.
  console.log('\nD. strictly additive (near end of clause 5; far end is in the kernel suite)');
  check('runModule still REJECTS on a trap (what process-worker.js turns into `crashed`)',
        a1.settled === 'rejected');
  check('and it rejects with the original WebAssembly.RuntimeError, not a wrapper',
        a1.error instanceof WebAssembly.RuntimeError,
        'got ' + (a1.error && a1.error.constructor.name) + ': ' + (a1.error && a1.error.message));
  check('the trap message survives verbatim on that error',
        /memory access out of bounds/.test(String(a1.error && a1.error.message)),
        String(a1.error && a1.error.message));

  // ---- E: POSITIVE CONTROL — a clean program produces NO backtrace ---------
  // Without this leg every assertion above could be satisfied by an
  // implementation that dumped a backtrace unconditionally.
  console.log('\nE. positive control: a program that does NOT trap emits no backtrace');
  var e = await buildAndRun({
    src: '#include <stdio.h>\nint main(void){ printf("clean\\n"); return 0; }\n',
    ccFlags: ['-g'], redirectErr: '/err.log',
  });
  var eTxt = readFile(e.kfs, '/err.log') || '';
  check('the clean program exited normally', e.settled === 'resolved' && e.exitCode === 0,
        'settled=' + e.settled + ' exit=' + e.exitCode);
  check('and wrote NOTHING to fd 2', eTxt.length === 0, JSON.stringify(eTxt.slice(0, 200)));

  // ---- F: a deep chain must still reach main() ----------------------------
  // V8's default Error.stackTraceLimit is 10; a chain deeper than that must not
  // silently lose its origin.
  console.log('\nF. a chain deeper than V8\'s default frame limit still reaches main()');
  var DEEP = [
    '#include <stdio.h>',
    '__attribute__((noinline)) static int rec(int n, int *p) {',
    '  if (n == 0) return *p;',
    '  return rec(n - 1, p) + 1;',
    '}',
    'int main(void) {',
    '  printf("go\\n"); fflush(stdout);',
    '  return rec(20, (int *)0x7ffffff0);   /* MARK_DEEP_MAIN */',
    '}',
    '',
  ].join('\n');
  var DEEP_MAIN = lineOf(DEEP, 'MARK_DEEP_MAIN');
  var f = await buildAndRun({ src: DEEP, srcName: '/deep.c', ccFlags: ['-g'], redirectErr: '/err.log' });
  var fTxt = readFile(f.kfs, '/err.log') || '';
  check('the deep fixture trapped', f.settled === 'rejected', 'settled=' + f.settled);
  check('more than V8\'s default 10 frames are reported',
        (fTxt.match(/deep\.c:\d+/g) || []).length > 10,
        'locations found: ' + (fTxt.match(/deep\.c:\d+/g) || []).length);
  check('the outermost frame main() is still present',
        /\bmain\b/.test(fTxt) && new RegExp('deep\\.c:' + DEEP_MAIN + '\\b').test(fTxt),
        JSON.stringify(fTxt.slice(-300)));

  // ---- G: the inliner limitation is DECLARED, not silently wrong -----------
  // With the inliner on (the default; there is no switch to disable it) a fault
  // several calls deep collapses to ONE frame attributed to the call site.
  // PRINCIPLES.md: a documented limitation is honest, a silently-wrong location
  // is not. So the report must SAY so.
  console.log('\nG. inlining collapses frames — the report must declare it');
  var INLINED = FIXTURE.replace(/__attribute__\(\(noinline\)\) /g, '');
  var g = await buildAndRun({ src: INLINED, srcName: '/inl.c', ccFlags: ['-g'], redirectErr: '/err.log' });
  var gTxt = readFile(g.kfs, '/err.log') || '';
  check('the inlined fixture trapped', g.settled === 'rejected', 'settled=' + g.settled);
  check('the report warns that inlined frames are not shown', /inlin/i.test(gTxt),
        JSON.stringify(gTxt.slice(0, 400)));

  // ---- H: a trap in the ANIMATION-FRAME callback (the gamedev main path) --
  //
  // Initialisation succeeds, the game runs frames, and then a frame traps.
  // That is the principal gamedev execution model and it reaches a DIFFERENT
  // catch from main(): `doFrame`'s. The first cut of #759 reported only at the
  // main-entry catch, so this case produced NOTHING AT ALL.
  //
  // NB the enclosing promise does not settle on a frame trap (a pre-existing
  // lifecycle defect, filed separately and NOT fixed here), so this leg races
  // the run against a deadline and asserts on what reached fd 2 — never on the
  // promise, which would hang the suite.
  console.log('\nH. a trap in the animation-frame callback still reports');
  const FRAME_SRC = [
    '#include <stdio.h>',
    '#include <emscripten.h>',
    'static int tick = 0;',
    '__attribute__((noinline)) static int boom(int *p) { return *p; }   /* MARK_FBOOM */',
    'static void onframe(void) {',
    '  if (++tick < 2) { printf("f\\n"); fflush(stdout); return; }',
    '  boom((int *)0x7ffffff0);                                          /* MARK_FCALL */',
    '}',
    'int main(void) { printf("init\\n"); fflush(stdout); emscripten_set_main_loop(onframe, 0, 1); return 0; }',
    '',
  ].join('\n');
  const FBOOM = lineOf(FRAME_SRC, 'MARK_FBOOM'), FCALL = lineOf(FRAME_SRC, 'MARK_FCALL');
  const beforeH = unhandled.length;
  const hRun = buildAndRun({ src: FRAME_SRC, srcName: '/frame.c', ccFlags: ['-g'], redirectErr: '/err.log' });
  const hKfs = lastKfs;                       // captured before the run can hang
  hRun.then(() => {}, () => {});
  /* A DEADLINE, not a sync primitive: this run may never settle by design, so
     there is no marker to wait on. Poll for the artifact instead and stop as
     soon as it appears, so the leg is fast when healthy and bounded when not. */
  for (let i = 0; i < 160; i++) {
    if (/backtrace/i.test(readFile(hKfs, '/err.log') || '')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const hTxt = readFile(hKfs, '/err.log') || '';
  check('the frame trap produced a backtrace on fd 2 (blocker: it produced NOTHING)',
        /backtrace/i.test(hTxt), JSON.stringify(hTxt.slice(0, 300)));
  check('it names the faulting frame `boom` at frame.c:' + FBOOM,
        /\bboom\b/.test(hTxt) && new RegExp('frame\\.c:' + FBOOM + '\\b').test(hTxt),
        JSON.stringify(hTxt.slice(0, 300)));
  check('and the frame callback that called it, at frame.c:' + FCALL,
        /\bonframe\b/.test(hTxt) && new RegExp('frame\\.c:' + FCALL + '\\b').test(hTxt),
        JSON.stringify(hTxt.slice(0, 300)));
  // Account for what the handler swallowed, so it cannot mask anything else.
  const hRejects = unhandled.slice(beforeH);
  check('the swallowed rejection is EXACTLY the frame trap (handler is scoped, not blanket)',
        hRejects.length >= 1 && hRejects.every((e) => e instanceof WebAssembly.RuntimeError),
        hRejects.map((e) => e && e.constructor && e.constructor.name).join(','));
  check('RECORDED (separately filed, not fixed here): the frame loop never settled',
        true, 'the run is still pending — reporting the fault does not terminate it');

  // ---- I: a CLOSED fd 2 must not be treated as an unredirected console ----
  //
  // A program may dup2 fd 2 and then close() it; close() leaves that slot
  // empty. An empty slot is NOT the same as a default console fd: the process
  // has no stderr at all, so putting the diagnostic on the host console would
  // report successful delivery through a channel the process does not own.
  console.log('\nI. a program that CLOSED its own fd 2 gets no console spill');
  const iRun = await buildAndRun({
    src: FIXTURE, srcName: '/closed.c', ccFlags: ['-g'],
    // Redirect first (so the slot is a real entry), then close it — the
    // sequence that leaves fd 2 empty rather than console-marked.
    redirectErr: '/gone.log',
    mutateEnv: function () {},
    afterEnv: function (kfs) { kfs.close(2); },
  });
  check('the closed-fd fixture still trapped (leg premise)', iRun.settled === 'rejected',
        'settled=' + iRun.settled);
  check('READ BACK: fd 2 really is absent, not console (the premise this rests on)',
        iRun.kfs.fdSink(2) === 'absent', 'fdSink(2)=' + iRun.kfs.fdSink(2));
  check('NOTHING was written to the host console writer',
        !/backtrace|wasm-function/i.test(iRun.consoleErr),
        JSON.stringify(iRun.consoleErr.slice(0, 300)));
  check('and nothing was written to the pre-close redirect target either',
        !/backtrace/i.test(readFile(iRun.kfs, '/gone.log') || ''),
        JSON.stringify(readFile(iRun.kfs, '/gone.log')));

  console.log('\nJ. accounting: nothing was silently swallowed');
  check('every unhandled rejection in this run was an expected wasm trap',
        unhandled.every((e) => e instanceof WebAssembly.RuntimeError),
        unhandled.map((e) => e && e.constructor && e.constructor.name).join(','));

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
}

main().catch(function (e) { console.error('test crashed: ' + (e && e.stack || e)); process.exit(1); });
