'use strict';
// Shared engine for file-granular test suites (todos/0081).
//
// A "suite" here is a list of standalone test FILES, each an executable that
// exits 0/nonzero (the tests/kernel/*.js and tests/browser/os-*.mjs shape —
// contrast tests/run-unit.js, which runs per-TEST workers in-process). The
// engine owns everything the old dumb serial loops didn't:
//
//   - a worker pool (`jobs`) with longest-first scheduling from the previous
//     run's timings; `serial: true` entries run alone after the pool drains
//   - per-file timeout with process-GROUP kill (tests spawn os/boot.js
//     children; killing just the test process would orphan them)
//   - per-file logs under the artifact dir + an incrementally checkpointed
//     summary.json (atomic rename after EVERY completion), so an interrupted
//     session still leaves a usable partial verdict
//   - --resume (skip files that passed in the previous summary), --filter,
//     --fail-fast, --timeout, -j, --list
//
// Interrupt semantics (audited 2026-07-10): SIGINT/SIGTERM kill every
// in-flight process group and keep the checkpoint; a SIGKILL of the runner
// (untrappable) still leaves a valid partial summary but ORPHANS in-flight
// children — they self-exit when their test completes, so the only true
// leak is a SIGKILLed runner whose test was itself hung. `pkill -f
// tests/kernel` cleans up after that rare case.
//
// Callers provide the file table and defaults; see tests/kernel/run.js and
// tests/browser/os-sweep.mjs.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// A filter is a comma-separated OR of substrings — `--filter=wm,term` selects
// any file whose name contains "wm" OR "term". The flake gate (todos/0147)
// relies on this to pick the tripwire SET in one invocation (so the files
// contend against each other), not one substring at a time.
function matchesFilter(name, filter) {
  if (!filter) return true;
  return filter.split(',').map(s => s.trim()).filter(Boolean).some(s => name.includes(s));
}

function parseSuiteArgs(argv, defaults) {
  const opts = Object.assign({
    jobs: 1, timeoutMs: 600000, filter: null, failFast: false,
    resume: false, list: false, repeat: 1, underLoad: 0,
  }, defaults);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-j') opts.jobs = parseInt(argv[++i], 10);
    else if (a.startsWith('-j')) opts.jobs = parseInt(a.slice(2), 10);
    else if (a === '--filter') opts.filter = argv[++i];
    else if (a.startsWith('--filter=')) opts.filter = a.slice(9);
    else if (a === '--timeout') opts.timeoutMs = parseInt(argv[++i], 10);
    else if (a.startsWith('--timeout=')) opts.timeoutMs = parseInt(a.slice(10), 10);
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--serial') opts.jobs = 1;
    else if (a === '--repeat') opts.repeat = parseInt(argv[++i], 10);
    else if (a.startsWith('--repeat=')) opts.repeat = parseInt(a.slice(9), 10);
    // --under-load with no value saturates every core; --under-load=N pins N.
    else if (a === '--under-load') opts.underLoad = -1;
    else if (a.startsWith('--under-load=')) opts.underLoad = parseInt(a.slice(13), 10);
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else { process.stderr.write(`unknown arg: ${a}\n`); process.exit(2); }
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1) opts.jobs = 1;
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) opts.repeat = 1;
  // -1 = the "flag with no value" sentinel → one busy loop per core.
  if (opts.underLoad === -1) opts.underLoad = Math.max(1, os.cpus().length);
  if (!Number.isInteger(opts.underLoad) || opts.underLoad < 0) opts.underLoad = 0;
  return opts;
}

function usage(name, defaults) {
  return `Usage: node ${name} [-j N] [--filter=SUBSTR] [--timeout=MS] [--fail-fast] [--resume] [--list] [--repeat N] [--under-load[=N]]

  -j N          run N test files in parallel (default ${defaults.jobs})
  --serial      alias for -j 1
  --filter=S    only files whose name contains S (comma = OR: "wm,term")
  --timeout=MS  per-file deadline (default ${defaults.timeoutMs}ms); a file that
                exceeds it is SIGKILLed (whole process group) and reported
                as "timeout". Per-file override in the suite table.
  --fail-fast   stop scheduling new files after the first failure
  --resume      skip files that PASSED in the previous run (summary.json)
  --list        print the (filtered) file list and exit
  --repeat N    run each selected file N times; report a per-file flake rate
                (a non-flaky file is N/N green). Disables --resume. (0147)
  --under-load[=N]  run under CPU contention: N busy-loop generators steal
                cores for the duration (bare flag = one per core). Surfaces
                sleep/timing regressions the idle box hides. (0147)

Artifacts: <artifactDir>/summary.json (checkpointed after every file) and
<artifactDir>/<file>.log (combined stdout+stderr per file).
`;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function fmtSecs(ms) { return (ms / 1000).toFixed(1) + 's'; }

function logTail(logPath, maxBytes) {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - (maxBytes || 4096));
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let s = buf.toString('utf-8');
    if (start > 0) s = '…' + s.slice(s.indexOf('\n') + 1);
    return s;
  } catch { return '(no log)'; }
}

// entries: [{ file, args?, timeoutMs?, serial? }]
// opts: { name, dir, artifactDir, jobs, timeoutMs, filter, failFast, resume,
//         env? } — `dir` is both the file root and the spawn cwd.
async function runSuite(entries, opts) {
  const repeat = Math.max(1, opts.repeat || 1);
  const underLoad = Math.max(0, opts.underLoad || 0);
  let files = entries.filter(e => matchesFilter(e.file, opts.filter));
  if (opts.list) {
    for (const e of files) process.stdout.write(e.file + (e.serial ? '  [serial]' : '') + '\n');
    return { passed: 0, failed: 0, skipped: 0, ranNothing: true };
  }

  // --repeat: fan each selected file into N runs, each with its own log, and
  // aggregate a per-file flake rate at the end. Repeat and --resume conflict
  // (resume would skip a file the flake gate wants to hammer) — repeat wins.
  if (repeat > 1) {
    opts = Object.assign({}, opts, { resume: false });
    files = files.flatMap(e => Array.from({ length: repeat }, (_, k) => Object.assign({}, e, {
      repeatOf: e.file, repeatIdx: k + 1,
      logName: `${e.file}.rep${k + 1}`,
    })));
  }

  fs.mkdirSync(opts.artifactDir, { recursive: true });
  const summaryPath = path.join(opts.artifactDir, 'summary.json');
  const prev = readJsonSafe(summaryPath);
  const prevByFile = new Map(((prev && prev.results) || []).map(r => [r.file, r]));

  const results = [];
  const resumed = [];
  if (opts.resume) {
    files = files.filter(e => {
      const r = prevByFile.get(e.file);
      if (r && r.status === 'pass') { resumed.push(r); return false; }
      return true;
    });
  }

  // Longest-first from the previous run's timings improves makespan; files
  // with no history run first (unknown cost = schedule early).
  const known = f => { const r = prevByFile.get(f); return r && r.ms != null ? r.ms : Infinity; };
  const parallel = files.filter(e => !e.serial).sort((a, b) => known(b.file) - known(a.file));
  const serial = files.filter(e => e.serial);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let failed = 0, passed = 0;
  let bailed = false;
  const inflight = new Set();

  let flake = null;
  function checkpoint(done) {
    writeJsonAtomic(summaryPath, {
      suite: opts.name, startedAt, node: process.version, jobs: opts.jobs,
      repeat, underLoad, done: !!done, elapsedMs: Date.now() - t0,
      results: resumed.map(r => Object.assign({}, r, { resumed: true })).concat(results),
      ...(flake ? { flake } : {}),
    });
  }

  function report(entry, status, ms, logPath, extra) {
    const label = entry.repeatIdx ? `${entry.file} #${entry.repeatIdx}` : entry.file;
    const r = { file: entry.file, status, ms, log: path.relative(process.cwd(), logPath) };
    if (entry.repeatIdx) r.repeatIdx = entry.repeatIdx;
    if (extra) Object.assign(r, extra);
    results.push(r);
    if (status === 'pass') { passed++; process.stdout.write(`ok   ${label}  ${fmtSecs(ms)}\n`); }
    else {
      failed++;
      process.stdout.write(`FAIL ${label}  ${fmtSecs(ms)}${status === 'timeout' ? '  (TIMED OUT)' : ''}  → ${r.log}\n`);
      const tail = logTail(logPath, 4096).split('\n').slice(-25).join('\n');
      for (const line of tail.split('\n')) process.stdout.write(`     | ${line}\n`);
      if (opts.failFast) bailed = true;
    }
    checkpoint(false);
  }

  function runOne(entry) {
    return new Promise((resolve) => {
      const logPath = path.join(opts.artifactDir, (entry.logName || entry.file).replace(/[\/\\]/g, '_') + '.log');
      const out = fs.createWriteStream(logPath);
      const t = Date.now();
      const child = spawn(process.execPath, [path.join(opts.dir, entry.file), ...(entry.args || [])], {
        cwd: opts.dir, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, opts.env || {}),
      });
      inflight.add(child);
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      let timedOut = false;
      const deadline = entry.timeoutMs || opts.timeoutMs;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      }, deadline);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        inflight.delete(child);
        out.end(() => {
          const ms = Date.now() - t;
          if (timedOut) report(entry, 'timeout', ms, logPath, { deadline });
          else if (code === 0) report(entry, 'pass', ms, logPath);
          else report(entry, 'fail', ms, logPath, { code, signal });
          resolve();
        });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        inflight.delete(child);
        out.end();
        report(entry, 'fail', Date.now() - t, logPath, { error: e.message });
        resolve();
      });
    });
  }

  // --under-load: spawn N busy-loop generators that peg cores for the whole
  // run, then die. Each is a detached node one-liner doing real arithmetic
  // (so V8 can't fold it away) until a far deadline; we SIGKILL the group when
  // the suite finishes. This is the deterministic contention the flake gate
  // (todos/0147) uses to surface sleep/timing regressions an idle box hides.
  const loadProcs = new Set();
  function startLoad() {
    if (underLoad <= 0) return;
    // Self-heals if orphaned: when the runner dies, the OS reparents this to
    // the init/subreaper (ppid changes), and the next batch check exits — so
    // a SIGKILL of the runner can't leave a core pegged (the 3600s deadline is
    // only a last-ditch backstop).
    const src = 'const pp=process.ppid,end=Date.now()+3600000;let x=0;' +
      'while(Date.now()<end){for(let i=0;i<2e6;i++)x+=Math.sqrt(i)*1.0000001;if(process.ppid!==pp)break;}' +
      'if(x===Infinity)console.log(x);';
    for (let i = 0; i < underLoad; i++) {
      const p = spawn(process.execPath, ['-e', src], { detached: true, stdio: 'ignore' });
      loadProcs.add(p);
      p.on('exit', () => loadProcs.delete(p));
    }
  }
  function stopLoad() {
    for (const p of loadProcs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } }
    loadProcs.clear();
  }

  // On interrupt: kill every in-flight process group + load generators,
  // checkpoint, and exit — the summary keeps the partial verdict.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    for (const c of inflight) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
    stopLoad();
    checkpoint(false);
    process.stdout.write(`\ninterrupted — partial summary at ${summaryPath}\n`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const banner = `--- ${opts.name} (${files.length} ${repeat > 1 ? 'runs' : 'files'}` +
    (repeat > 1 ? ` = ${files.length / repeat}×${repeat} repeat` : '') +
    (resumed.length ? `, ${resumed.length} resumed-pass skipped` : '') +
    (underLoad > 0 ? `, UNDER LOAD ×${underLoad}` : '') +
    `, ${opts.jobs} jobs) ---`;
  process.stdout.write(banner + '\n');
  startLoad();

  let next = 0;
  async function pump() {
    while (next < parallel.length && !bailed) {
      const entry = parallel[next++];
      await runOne(entry);
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.jobs, parallel.length || 1) }, pump));
  for (const entry of serial) {
    if (bailed) break;
    await runOne(entry);
  }

  stopLoad();

  // --repeat: aggregate the N runs of each file into a flake verdict.
  if (repeat > 1) {
    const byFile = new Map();
    for (const r of results) {
      const g = byFile.get(r.file) || { pass: 0, total: 0 };
      g.total++; if (r.status === 'pass') g.pass++;
      byFile.set(r.file, g);
    }
    flake = [...byFile.entries()].map(([file, g]) => ({
      file, pass: g.pass, total: g.total, flaky: g.pass !== g.total,
    }));
    process.stdout.write(`\nflake report (${repeat}× each` +
      (underLoad > 0 ? `, under load ×${underLoad}` : '') + `):\n`);
    for (const f of flake.sort((a, b) => Number(b.flaky) - Number(a.flaky))) {
      const rate = Math.round((f.total - f.pass) / f.total * 100);
      const tag = f.flaky ? '\x1b[31mFLAKY \x1b[0m' : '\x1b[32mstable\x1b[0m';
      process.stdout.write(`  ${tag} ${f.file}  ${f.pass}/${f.total} passed  (flake ${rate}%)\n`);
    }
    const flakyN = flake.filter(f => f.flaky).length;
    process.stdout.write(flakyN
      ? `\n  \x1b[31m${flakyN} flaky file(s) — a timing/sleep regression is live.\x1b[0m\n`
      : `\n  \x1b[32mall ${flake.length} file(s) stable across ${repeat} runs.\x1b[0m\n`);
  }

  checkpoint(true);
  const elapsed = fmtSecs(Date.now() - t0);
  const parts = [`${passed} passed`, `${failed} failed`];
  if (resumed.length) parts.push(`${resumed.length} resumed`);
  if (bailed) parts.push('(fail-fast: remaining files not run)');
  process.stdout.write(`\n${opts.name}: ${parts.join(', ')}  (${elapsed})  summary: ${path.relative(process.cwd(), summaryPath)}\n`);
  return { passed, failed, resumed: resumed.length, bailed, flake };
}

module.exports = { runSuite, parseSuiteArgs, usage, matchesFilter };
