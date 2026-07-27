#!/usr/bin/env node
// In-process parallel test runner (PoC).
//
// Equivalent to `python3 tests/run.py --types=unit` but runs each test
// in a worker_threads worker that calls compiler/host functions directly,
// avoiding ~500 node-process spawns.
//
// Usage:
//   node tests/run.js               # default: unit tests
//   node tests/run.js -v            # per-test PASS/FAIL
//   node tests/run.js --filter=...  # substring filter on test name
//   node tests/run.js -j 8          # set worker count (default: cpu count)

'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
// Cross-tree preflight (todos/0341) — every path below hangs off ROOT, which is
// this file's own location, not the cwd. Guard the launch, not the 127 sites.
if (isMainThread) require('./lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/run-unit.js' });
const UNIT_DIR = path.join(__dirname, 'unit');
const BUILD_DIR = path.join(ROOT, 'build');
const TEST_TMPDIR = path.join(BUILD_DIR, 'tmp');

// ---------- Test discovery (matches run.py:collect_tests) ----------

function collectTests(dir, filter) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const entries = fs.readdirSync(dir);
  const subdirs = entries.filter(e => fs.statSync(path.join(dir, e)).isDirectory()).sort();
  const cFiles = entries.filter(e => e.endsWith('.c'));
  if (cFiles.length && subdirs.length) {
    process.stderr.write(`  ERROR  ${dir}: has both .c files and subdirectories\n`);
    process.exit(1);
  }
  if (subdirs.length) {
    const out = [];
    for (const d of subdirs) out.push(...collectTests(path.join(dir, d), filter));
    return out;
  }
  if (cFiles.length) {
    if (filter && !dir.includes(filter)) return [];
    return [dir];
  }
  return [];
}

function loadExpected(testDir, name) {
  const p = path.join(testDir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

function buildTestDescriptor(testDir) {
  const name = path.relative(__dirname, testDir);
  const cFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.c')).sort()
    .map(f => path.join(testDir, f));
  let config = {};
  const cfg = path.join(testDir, 'config.json');
  if (fs.existsSync(cfg)) config = JSON.parse(fs.readFileSync(cfg, 'utf-8'));

  const expected = {
    compilerStderr: loadExpected(testDir, 'expected.compiler.stderr'),
    compilerExitCode: 0,
    stdout: loadExpected(testDir, 'expected.stdout'),
    stderr: loadExpected(testDir, 'expected.stderr'),
    exitcode: (config.expected && config.expected.exitcode) || 0,
  };
  const ce = path.join(testDir, 'expected.compiler.exitcode');
  if (fs.existsSync(ce)) expected.compilerExitCode = parseInt(fs.readFileSync(ce, 'utf-8').trim(), 10);
  const ex = path.join(testDir, 'expected.exitcode');
  if (fs.existsSync(ex)) expected.exitcode = parseInt(fs.readFileSync(ex, 'utf-8').trim(), 10);

  return { name, testDir, cFiles, config, expected };
}

// ---------- Worker logic ----------

class ExitOverride extends Error {
  constructor(code) { super('exit'); this.code = code | 0; }
}

// Tests known to need process.chdir(), which is not supported inside
// worker_threads. Run these via `python3 tests/run.py --filter=...` if you
// need them.
const WORKER_CHDIR_INCOMPATIBLE = new Set([
  'unit/stdlib/posix_dir',
]);

function workerMain() {
  // Override process.exit so compiler internals don't kill the worker.
  process.exit = (code) => { throw new ExitOverride(code || 0); };

  // Suppress accidental writes to real stdout/stderr from compiler internals
  // that don't accept a writeErr hook. We restore them when calling host's
  // runModule (which has its own writeOut/writeErr).
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  let captureStdout = null;
  let captureStderr = null;
  process.stdout.write = (chunk, ...rest) => {
    if (captureStdout) { captureStdout.push(toBuf(chunk)); return true; }
    return realStdoutWrite(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    if (captureStderr) { captureStderr.push(toBuf(chunk)); return true; }
    return realStderrWrite(chunk, ...rest);
  };

  function toBuf(c) {
    if (Buffer.isBuffer(c)) return c;
    if (typeof c === 'string') return Buffer.from(c, 'utf-8');
    return Buffer.from(c);
  }
  function flush(arr) { return Buffer.concat(arr).toString('utf-8'); }

  const compiler = require(path.join(ROOT, 'compiler.js'));
  const runModule = require(path.join(ROOT, 'host.js'));
  const BLOCK_FS = runModule.BLOCK_FS;

  // --wast-inline differential mode (todos/0214): mutate the pass
  // defaults once per worker, before any compile.
  const wastMode = workerData && workerData.wastInline;
  if (wastMode === 'off') {
    compiler.WAST.inlineDefaults.enabled = false;
    compiler.WAST.shakeDefaults.enabled = false;
  } else if (wastMode === 'max') {
    compiler.WAST.inlineDefaults.calleeCap = 2048;
    compiler.WAST.inlineDefaults.hintCalleeCap = 2048;
    compiler.WAST.inlineDefaults.callerGrowth = 16000;
  }

  function configureCompilerArgs(args, pp, compilerOptions, warningFlags) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-D')) {
        const def = a.substring(2);
        const eq = def.indexOf('=');
        if (eq >= 0) pp.defines.set(def.substring(0, eq), def.substring(eq + 1));
        else pp.defines.set(def, '1');
      } else if (a.startsWith('-I')) {
        pp.includePaths.push(a.substring(2));
      } else if (a === '-g' || a === '-g1') {
        compilerOptions.emitNames = true;
      } else if (a === '-g2') {
        compilerOptions.emitNames = true; compilerOptions.embedSources = true;
      } else if (a.startsWith('-W')) {
        const w = a.substring(2);
        if (w === 'pointer-decay') warningFlags.pointerDecay = true;
        else if (w === 'no-pointer-decay') warningFlags.pointerDecay = false;
        else if (w === 'circular-dependency') warningFlags.circularDependency = true;
        else if (w === 'no-circular-dependency') warningFlags.circularDependency = false;
        else if (w === 'large-stack-frame') warningFlags.largeStackFrame = true;
        else if (w === 'no-large-stack-frame') warningFlags.largeStackFrame = false;
      } else if (a === '--no-reuse-locals') compilerOptions.noReuseLocals = true;
      else if (a === '--compiler-debug-switch') compilerOptions.debugSwitch = true;
      else if (a === '--allow-implicit-int') compilerOptions.allowImplicitInt = true;
      else if (a === '--allow-empty-params') compilerOptions.allowEmptyParams = true;
      else if (a === '--allow-knr-definitions') compilerOptions.allowKnRDefinitions = true;
      else if (a === '--allow-implicit-function-decl') compilerOptions.allowImplicitFunctionDecl = true;
      else if (a === '--allow-undefined') compilerOptions.allowUndefined = true;
      else if (a === '--allow-zero-length-arrays') compilerOptions.allowZeroLengthArrays = true;
      else if (a === '--allow-old-c') {
        compilerOptions.allowImplicitInt = true;
        compilerOptions.allowEmptyParams = true;
        compilerOptions.allowKnRDefinitions = true;
        compilerOptions.allowImplicitFunctionDecl = true;
      }
      else if (a === '--gc-sections') compilerOptions.gcSections = true;
      else if (a === '--gc-no-export-roots') compilerOptions.gcNoExportRoots = true;
      else if (a === '--no-undefined') compilerOptions.noUndefined = true;
      else if (a === '--no-irreducible-lowering') compilerOptions.noIrreducibleLowering = true;
      else if (a === '--force-dispatch-loop') compilerOptions.forceIrreducibleLowering = true;
      else if (a === '--gc-spill-locals') compilerOptions.gcSpillLocals = true;
      else if (a === '--trapping-float-conversions') compilerOptions.trappingFloatConversions = true;
      else if (a === '--dedup-literals' || a === '-fmerge-constants') compilerOptions.dedupLiterals = true;
      else if (a === '--no-dedup-literals' || a === '-fno-merge-constants') compilerOptions.dedupLiterals = false;
      else if (a === '--require-source') compilerOptions.requireSources.push(args[++i]);
      // silently ignore other unknown -* args (matches main())
    }
  }

  async function runOne(td) {
    // Skips tagged `fallback: true` are things the in-process runner
    // can't handle, but a subprocess-based runner (tests/run.py's
    // run_single_test) can — the orchestrator can pick them back up.
    if (td.config.events) {
      return { name: td.name, status: 'skip', fallback: true,
               msg: 'stdin events need subprocess scheduling' };
    }
    // Tests that assert on real process-level stdio (e.g. isatty on piped
    // std fds) can't run in-process — the worker shares the parent's
    // streams, which may or may not be a TTY.
    if (td.config.subprocess) {
      return { name: td.name, status: 'skip', fallback: true,
               msg: 'requires subprocess stdio' };
    }
    // process.chdir() isn't allowed in worker_threads, so any test that
    // exercises chdir cannot run in-process.
    if (WORKER_CHDIR_INCOMPATIBLE.has(td.name)) {
      return { name: td.name, status: 'skip', fallback: true,
               msg: 'uses chdir (worker_thread limitation)' };
    }

    // ---- Compile ----
    const compilerStderrBuf = [];
    const writeCompilerErr = (s) => { compilerStderrBuf.push(toBuf(s)); };
    // Compiler internals (codegen --compiler-debug-switch, fatal errors,
    // etc.) sometimes go straight to process.stderr instead of writeErr.
    // Route those to the same buffer for the duration of compilation.
    captureStderr = compilerStderrBuf;

    const pp = compiler.createDefaultPPRegistry();
    pp.fileReader = (filePath) => {
      try { return fs.readFileSync(filePath, 'utf-8'); }
      catch { return null; }
    };
    pp.defines.set('TEST_TMPDIR', `"${TEST_TMPDIR}/"`);

    const compilerOptions = {
      debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
      allowKnRDefinitions: false, allowImplicitFunctionDecl: false,
      allowUndefined: false, gcSections: false, gcNoExportRoots: false,
      noUndefined: false, requireSources: [], backend: 'default',
    };
    const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: true };
    configureCompilerArgs(td.config.compilerArgs || [], pp, compilerOptions, warningFlags);

    // Use relative paths matching python runner (errors report paths the same way)
    const relCFiles = td.cFiles.map(f => path.relative(ROOT, f));

    let wasmBinary = null;
    let compilerExitCode = 0;
    try {
      const units = compiler.parseAllUnits(fs, pp, relCFiles, {
        warningFlags, compilerOptions, writeErr: writeCompilerErr,
      });
      const linkResult = compiler.linkTranslationUnits(units, compilerOptions);
      if (linkResult.errors.length > 0) {
        writeCompilerErr(`Got ${linkResult.errors.length} link errors.\n`);
        for (const err of linkResult.errors) {
          writeCompilerErr(`Link error: ${err.message}\n`);
          if (err.locations) for (const loc of err.locations) {
            if (loc && loc.filename) writeCompilerErr(`  at ${loc.filename}:${loc.line}\n`);
          }
        }
        compilerExitCode = 1;
      } else {
        if (compilerOptions.allowUndefined) {
          for (const unit of units) {
            const kept = [];
            for (const func of unit.declaredFunctions) {
              if (func.storageClass === compiler.Types.StorageClass.IMPORT) {
                unit.importedFunctions.push(func);
              } else { kept.push(func); }
            }
            unit.declaredFunctions = kept;
          }
        }
        if (compilerOptions.gcSections) compiler.gcSectionsPass(units, compilerOptions);
        wasmBinary = compiler.generateCode(units, 'test.wasm', { compilerOptions, warningFlags, writeErr: writeCompilerErr });
      }
    } catch (e) {
      if (e instanceof ExitOverride) {
        compilerExitCode = e.code || 1;
      } else if (e && e.compilationFailed) {
        // parseAllUnits with writeErr injected: diagnostics already flowed
        // through writeCompilerErr; the throw just carries the exit status.
        compilerExitCode = 1;
      } else {
        writeCompilerErr(`Compiler threw: ${e.message}\n${e.stack || ''}\n`);
        compilerExitCode = 1;
      }
    }

    captureStderr = null;
    const compilerStderr = flush(compilerStderrBuf);
    const errors = [];
    if (td.expected.compilerStderr != null && compilerStderr !== td.expected.compilerStderr) {
      errors.push(
        `Compiler stderr mismatch:\n--- expected ---\n${td.expected.compilerStderr}` +
        `--- got ---\n${compilerStderr}`
      );
    }
    if (td.expected.compilerExitCode !== 0) {
      if (compilerExitCode !== td.expected.compilerExitCode) {
        errors.push(`Compiler exit code: got ${compilerExitCode}, expected ${td.expected.compilerExitCode}`);
      }
      return { name: td.name, status: errors.length ? 'fail' : 'pass', msg: errors.join('\n') };
    }
    if (compilerExitCode !== 0) {
      return { name: td.name, status: 'fail',
               msg: `Compilation failed (exit ${compilerExitCode}):\n${compilerStderr}` };
    }
    if (errors.length) {
      return { name: td.name, status: 'fail', msg: errors.join('\n') };
    }

    // ---- Run ----
    // Block-FS tests run against BOTH v4 (the live format the app uses) and v3
    // (legacy), verifying identical functional behavior on each. Non-block-FS
    // tests run once against the Node fs. argv[0] is shaped to match the python
    // tempfile path some tests were written against (alloca/stack-address output).
    const fakeArgv0 = `${os.tmpdir()}/tmpXXXXXXXX.wasm`;
    const mounts = td.config.blockFs
      ? [['v4', (s) => BLOCK_FS.createV4(s)], ['v3', (s) => BLOCK_FS.create(s)]]
      : [[null, null]];
    const runErrors = [];
    for (const [fmtLabel, mountFn] of mounts) {
      const stdoutBuf = [];
      const stderrBuf = [];
      let runExitCode;
      captureStdout = stdoutBuf;
      captureStderr = stderrBuf;
      try {
        const runOpts = {
          bytes: wasmBinary,
          args: [fakeArgv0, ...(td.config.args || [])],
          writeOut: (b) => stdoutBuf.push(toBuf(b)),
          writeErr: (b) => stderrBuf.push(toBuf(b)),
        };
        if (mountFn) {
          const blockStore = new BLOCK_FS.MemoryByteStore(64 * 1024 * 1024);
          const blockFS = mountFn(blockStore);
          runOpts.blockFsFactory = async function (ctx) { return { c: blockFS.toWasmEnv(ctx) }; };
        } else {
          runOpts.fs = fs;
        }
        runExitCode = await runModule(runOpts);
      } catch (e) {
        stderrBuf.push(toBuf(`${e.stack || e.message}\n`));
        runExitCode = 1;
      }
      captureStdout = null; captureStderr = null;
      if (runExitCode == null) runExitCode = 0;

      const runStdout = flush(stdoutBuf);
      const runStderr = flush(stderrBuf);
      const tag = fmtLabel ? `[${fmtLabel}] ` : '';
      if (runExitCode !== td.expected.exitcode) {
        let msg = `${tag}Exit code: got ${runExitCode}, expected ${td.expected.exitcode}`;
        if (td.expected.exitcode === 0 && runExitCode !== 0) {
          if (runStdout) msg += `\n--- stdout ---\n${runStdout}`;
          if (runStderr) msg += `\n--- stderr ---\n${runStderr}`;
        }
        runErrors.push(msg);
      }
      if (td.expected.stdout != null && runStdout !== td.expected.stdout) {
        runErrors.push(`${tag}Stdout mismatch:\n--- expected ---\n${td.expected.stdout}--- got ---\n${runStdout}`);
      }
      if (td.expected.stderr != null && runStderr !== td.expected.stderr) {
        runErrors.push(`${tag}Stderr mismatch:\n--- expected ---\n${td.expected.stderr}--- got ---\n${runStderr}`);
      }
    }
    return { name: td.name, status: runErrors.length ? 'fail' : 'pass', msg: runErrors.join('\n') };
  }

  // Known-bug / expected-fail (xfail) transform. A test tagged
  // `"knownBug": "NNNN"` in its config.json pins a CONFIRMED-but-unfixed
  // compiler bug: its expected.stdout encodes the CORRECT (clang) answer, so
  // it currently FAILS. We still compile+run+diff it (real proof, recorded in
  // the msg), but a pinned failure is reported as `xfail` — GREEN, so the
  // suite is not permanently red (the fakegit/0183 anti-pattern). If the test
  // unexpectedly PASSES the bug is fixed: that's `xpass`, a LOUD failure
  // telling the fixer to drop the tag and convert this into a hard regression
  // guard.
  function applyKnownBug(td, result) {
    if (!result || (result.status !== 'fail' && result.status !== 'pass')) return result;
    const id = td.config.knownBug;
    if (result.status === 'fail') {
      return { name: td.name, status: 'xfail', knownBug: id,
               msg: `XFAIL KNOWN-BUG ${id} (todos/${id}) — pinned; expected-vs-actual below:\n${result.msg || ''}` };
    }
    return { name: td.name, status: 'xpass', knownBug: id,
             msg: `XPASS: KNOWN-BUG ${id} now PASSES — the bug appears FIXED. Remove ` +
                  `"knownBug" from ${td.name}/config.json to convert this into a permanent ` +
                  `regression guard (todos/${id}).` };
  }

  parentPort.on('message', async (td) => {
    let result;
    try {
      result = await runOne(td);
    } catch (e) {
      result = { name: td.name, status: 'fail', msg: `Runner error: ${e.message}\n${e.stack || ''}` };
    }
    if (td.config && td.config.knownBug) result = applyKnownBug(td, result);
    parentPort.postMessage(result);
  });
}

// ---------- Main ----------

function parseArgs(argv) {
  const opts = { verbose: false, quiet: false, jsonl: false, filter: null, jobs: os.cpus().length, timeoutMs: 30000, wastInline: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '-q' || a === '--quiet') opts.quiet = true;
    else if (a === '--jsonl') opts.jsonl = true;
    else if (a === '--filter') opts.filter = argv[++i];
    else if (a.startsWith('--filter=')) opts.filter = a.substring('--filter='.length);
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (a.startsWith('--timeout=')) opts.timeoutMs = parseInt(a.substring('--timeout='.length), 10);
    else if (a === '-j') opts.jobs = parseInt(argv[++i], 10);
    else if (a.startsWith('-j')) opts.jobs = parseInt(a.substring(2), 10);
    else if (a.startsWith('--wast-inline=')) {
      opts.wastInline = a.substring('--wast-inline='.length);
      if (!['off', 'on', 'max'].includes(opts.wastInline)) {
        process.stderr.write(`--wast-inline: expected off|on|max, got '${opts.wastInline}'\n`);
        process.exit(2);
      }
    }
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'Usage: node tests/run-unit.js [-v] [--jsonl] [--filter=<substr>] [-j N] [--timeout=MS] [--wast-inline=off|on|max]\n' +
        '\n' +
        '  --timeout Per-test deadline in ms (default 30000). A test that\n' +
        '            exceeds it fails with "Timed out" and its worker is\n' +
        '            replaced, so hangs cannot stall the suite. Per-test\n' +
        '            override: "timeoutMs" in the test\'s config.json.\n' +
        '\n' +
        '  --jsonl   Emit one JSON line per test result to stdout. Suppresses\n' +
        '            human-readable banners and the trailing summary. Intended\n' +
        '            for consumption by other tools (e.g. tests/run.py).\n' +
        '\n' +
        '  --wast-inline=off|on|max\n' +
        '            The WAST inliner+tree-shake differential knob\n' +
        '            (todos/0201/0214): off = both passes disabled, on = the\n' +
        '            shipped defaults (same as omitting the flag), max =\n' +
        '            aggressive budgets (calleeCap/hintCalleeCap 2048,\n' +
        '            callerGrowth 16000). The corpus must be green under all\n' +
        '            three — any divergence is an inliner/shake miscompile.\n'
      );
      process.exit(0);
    }
  }
  return opts;
}

async function mainMain() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(TEST_TMPDIR, { recursive: true });

  const start = Date.now();
  const testDirs = collectTests(UNIT_DIR, opts.filter);
  const descriptors = testDirs.map(buildTestDescriptor).filter(t => t.cFiles.length);
  if (!opts.jsonl && !opts.quiet) {
    process.stdout.write(`--- unit (${descriptors.length} tests, ${opts.jobs} workers) ---\n`);
  }

  const queue = descriptors.slice();
  let nextIdx = 0;
  let passed = 0, failed = 0, skipped = 0, xfailed = 0;
  const failures = [];

  function reportJsonl(result) {
    // One self-delimited JSON object per line — easy to stream-parse from
    // Python, robust against embedded newlines in `msg`.
    process.stdout.write(JSON.stringify(result) + '\n');
  }

  function reportHuman(result) {
    if (result.status === 'pass') {
      if (opts.verbose) process.stdout.write(`  PASS  ${result.name}\n`);
      else if (!opts.quiet) process.stdout.write('.');
    } else if (result.status === 'xfail') {
      if (opts.verbose) process.stdout.write(`  XFAIL ${result.name}${result.msg ? ' — ' + result.msg : ''}\n`);
      else if (!opts.quiet) process.stdout.write('x');
    } else if (result.status === 'skip') {
      if (opts.verbose) process.stdout.write(`  SKIP  ${result.name}${result.msg ? ' — ' + result.msg : ''}\n`);
    } else {
      if (opts.verbose) {
        process.stdout.write(`  FAIL  ${result.name}\n`);
        for (const line of (result.msg || '').split('\n')) {
          process.stdout.write(`        ${line}\n`);
        }
      } else if (!opts.quiet) {
        process.stdout.write('F');
      }
    }
  }

  async function spawnWorker() {
    return new Promise((resolveDone, rejectDone) => {
      // Each in-flight test gets a deadline. A test that blows it (e.g. a
      // miscompiled infinite loop) is reported as a failure and its worker
      // terminated and replaced, so a hang can never stall the suite.
      let w = null;
      let timer = null;
      let currentTd = null;

      function report(result) {
        if (result.status === 'pass') passed++;
        else if (result.status === 'xfail') xfailed++;
        else if (result.status === 'skip') skipped++;
        else { failed++; failures.push(result); }  // 'fail' and 'xpass' both fail loud

        if (opts.jsonl) reportJsonl(result);
        else reportHuman(result);
      }

      function takeNext() {
        if (nextIdx >= queue.length) { w.terminate(); resolveDone(); return; }
        currentTd = queue[nextIdx++];
        timer = setTimeout(onTimeout, currentTd.config.timeoutMs || opts.timeoutMs);
        w.postMessage(currentTd);
      }

      function onTimeout() {
        const td = currentTd;
        currentTd = null;
        timer = null;
        report({ name: td.name, status: 'fail',
                 msg: `Timed out after ${td.config.timeoutMs || opts.timeoutMs}ms (hang?)` });
        const old = w;
        old.removeAllListeners();
        old.terminate();
        startWorker(); // replace the killed worker and keep draining the queue
        takeNext();
      }

      function startWorker() {
        w = new Worker(__filename, { workerData: { wastInline: opts.wastInline } });
        w.on('message', (result) => {
          clearTimeout(timer);
          timer = null;
          currentTd = null;
          report(result);
          takeNext();
        });
        w.on('error', (e) => { clearTimeout(timer); rejectDone(e); });
        w.on('exit', (code) => {
          if (code !== 0 && code !== 1) rejectDone(new Error(`Worker exited with ${code}`));
        });
      }

      startWorker();
      takeNext();
    });
  }

  await Promise.all(Array.from({ length: Math.min(opts.jobs, queue.length || 1) }, spawnWorker));

  if (!opts.jsonl) {
    const elapsed = (Date.now() - start) / 1000;
    if (!opts.quiet && !opts.verbose) process.stdout.write('\n');
    if (!opts.verbose) {
      for (const f of failures) {
        process.stdout.write(`\n  FAIL  ${f.name}\n`);
        for (const line of (f.msg || '').split('\n')) {
          process.stdout.write(`        ${line}\n`);
        }
      }
    }
    const parts = [`${passed} passed`, `${failed} failed`];
    if (xfailed) parts.push(`${xfailed} xfailed`);
    if (skipped) parts.push(`${skipped} skipped`);
    process.stdout.write(`\n${parts.join(', ')}  (${elapsed.toFixed(1)}s)\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (isMainThread) {
  mainMain().catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
} else {
  workerMain();
}
