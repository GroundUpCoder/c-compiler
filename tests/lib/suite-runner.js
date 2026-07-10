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

function parseSuiteArgs(argv, defaults) {
  const opts = Object.assign({
    jobs: 1, timeoutMs: 600000, filter: null, failFast: false,
    resume: false, list: false,
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
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else { process.stderr.write(`unknown arg: ${a}\n`); process.exit(2); }
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1) opts.jobs = 1;
  return opts;
}

function usage(name, defaults) {
  return `Usage: node ${name} [-j N] [--filter=SUBSTR] [--timeout=MS] [--fail-fast] [--resume] [--list]

  -j N          run N test files in parallel (default ${defaults.jobs})
  --serial      alias for -j 1
  --filter=S    only files whose name contains S
  --timeout=MS  per-file deadline (default ${defaults.timeoutMs}ms); a file that
                exceeds it is SIGKILLed (whole process group) and reported
                as "timeout". Per-file override in the suite table.
  --fail-fast   stop scheduling new files after the first failure
  --resume      skip files that PASSED in the previous run (summary.json)
  --list        print the (filtered) file list and exit

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
  let files = entries.filter(e => !opts.filter || e.file.includes(opts.filter));
  if (opts.list) {
    for (const e of files) process.stdout.write(e.file + (e.serial ? '  [serial]' : '') + '\n');
    return { passed: 0, failed: 0, skipped: 0, ranNothing: true };
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

  function checkpoint(done) {
    writeJsonAtomic(summaryPath, {
      suite: opts.name, startedAt, node: process.version, jobs: opts.jobs,
      done: !!done, elapsedMs: Date.now() - t0,
      results: resumed.map(r => Object.assign({}, r, { resumed: true })).concat(results),
    });
  }

  function report(entry, status, ms, logPath, extra) {
    const r = { file: entry.file, status, ms, log: path.relative(process.cwd(), logPath) };
    if (extra) Object.assign(r, extra);
    results.push(r);
    if (status === 'pass') { passed++; process.stdout.write(`ok   ${entry.file}  ${fmtSecs(ms)}\n`); }
    else {
      failed++;
      process.stdout.write(`FAIL ${entry.file}  ${fmtSecs(ms)}${status === 'timeout' ? '  (TIMED OUT)' : ''}  → ${r.log}\n`);
      const tail = logTail(logPath, 4096).split('\n').slice(-25).join('\n');
      for (const line of tail.split('\n')) process.stdout.write(`     | ${line}\n`);
      if (opts.failFast) bailed = true;
    }
    checkpoint(false);
  }

  function runOne(entry) {
    return new Promise((resolve) => {
      const logPath = path.join(opts.artifactDir, entry.file.replace(/[\/\\]/g, '_') + '.log');
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

  // On interrupt: kill every in-flight process group, checkpoint, and exit —
  // the summary keeps the partial verdict.
  let interrupted = false;
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    for (const c of inflight) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
    checkpoint(false);
    process.stdout.write(`\ninterrupted — partial summary at ${summaryPath}\n`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const banner = `--- ${opts.name} (${files.length} files` +
    (resumed.length ? `, ${resumed.length} resumed-pass skipped` : '') +
    `, ${opts.jobs} jobs) ---`;
  process.stdout.write(banner + '\n');

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

  checkpoint(true);
  const elapsed = fmtSecs(Date.now() - t0);
  const parts = [`${passed} passed`, `${failed} failed`];
  if (resumed.length) parts.push(`${resumed.length} resumed`);
  if (bailed) parts.push('(fail-fast: remaining files not run)');
  process.stdout.write(`\n${opts.name}: ${parts.join(', ')}  (${elapsed})  summary: ${path.relative(process.cwd(), summaryPath)}\n`);
  return { passed, failed, resumed: resumed.length, bailed };
}

module.exports = { runSuite, parseSuiteArgs, usage };
