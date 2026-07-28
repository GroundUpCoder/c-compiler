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
//   - a summary that records its own SCOPE (todos/0339): `filter`, a `files`
//     block (total / selected / executed / carried / carriedFailed / recorded /
//     staleDropped) and a `runs` list, and results MERGED across runs so a
//     two-`--filter`-half sweep accounts for the whole suite instead of the
//     second half deleting the first. What `recorded == total` certifies — and
//     deliberately does not — is stated at the merge block in runSuite
//     (todos/0368); the carried-FAIL exit contract at the closing summary.
//
// Stale per-file logs are deliberately NOT cleared at suite start. Under the
// merge above, a carried result's `log` points at a log written by an earlier
// run; wiping the directory would leave the manifest citing files that no
// longer exist. The manifest is what makes the log dir interpretable — counting
// *.log OVERSTATES (repeat variants, prior runs), which is why the count that
// matters lives in summary.json's `files` block and not on the filesystem.
//
// Interrupt semantics (re-audited 2026-07-26). The three deaths and what
// covers each — the old note here said a SIGKILLed runner's orphans "self-exit
// when their test completes, so the only true leak is a hung test", and treated
// `pkill -f tests/kernel` as the answer. That was wrong in practice: it leaked
// 70 serve.js listeners onto the sweep's fixed ports in one round, and the next
// run then talked to those stale servers and reported reds that had nothing to
// do with the code under test.
//
//   clean exit ......... the test's own teardown; harness-temp.js rms fixtures.
//   per-file TIMEOUT ... we kill the whole process GROUP (killGroup below:
//                        SIGTERM, grace, SIGKILL). The child is detached, so it
//                        IS a group leader and the kill reaches its
//                        serve.js/Chromium grandchildren; the grace window lets
//                        a responsive child rm its own fixture dir first.
//   SIGINT/SIGTERM ..... onSignal killGroups every in-flight file, checkpoints,
//                        and exits 130 — the partial summary stays valid.
//   runner SIGKILLed ... no handler of ours can run, and the children are in a
//                        DIFFERENT group so nobody else's kill reaches them.
//                        Covered from INSIDE the child instead: every file is
//                        spawned with `-r tests/lib/parent-watch.js`, which
//                        polls its ppid and tears down its own group when we
//                        vanish. Whatever still escapes (or predates the fix)
//                        is reaped at the next run's startup by
//                        tests/lib/harness-leaks.js preflight().
//
// Callers provide the file table and defaults; see tests/kernel/run.js and
// tests/browser/os-sweep.mjs.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PARENT_WATCH = path.join(__dirname, 'parent-watch.js');

// How long a doomed process group gets to clean up after itself before we take
// it out for good. A test file killed outright runs no handler, so its ~150 MB
// fixture dir survives to be collected by the next run's reaper; SIGTERM first
// lets harness-temp.js rm it here and now instead. Deliberately short — a hung
// test cannot service the signal anyway (its loop is stuck, which is why it
// timed out), so this is a cheap upgrade for the responsive case and a 400ms
// tax on nothing else.
const KILL_GRACE_MS = 400;

// SIGTERM the whole group, then SIGKILL what is left. `-pid` is the group (the
// child is detached, so it leads one); the fallback covers a child that never
// became a leader. When `sync`, block for the grace window — the callers that
// pass it are exiting immediately after and have no later turn to run in.
function killGroup(child, { sync = false } = {}) {
  const send = (sig) => {
    try { process.kill(-child.pid, sig); }
    catch { try { child.kill(sig); } catch {} }
  };
  send('SIGTERM');
  if (sync) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KILL_GRACE_MS); } catch {}
    send('SIGKILL');
  } else {
    setTimeout(() => send('SIGKILL'), KILL_GRACE_MS).unref();
  }
}

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

// Cap a requested worker count so the pool can't exhaust RAM. For the heavy
// suites a job's real cost is MEMORY, not CPU: each kernel file boots a full
// OS and spawns a nested os/boot.js node, ~PER_JOB_GB resident. Sizing `jobs`
// off cpu count alone is what let 4 jobs ≈ 16.7 GB take down a 16 GB machine
// (2026-07-25 OOM → WindowServer watchdog kill; see tests/lib/heavy-lock.js).
// We keep the caller's number but clamp it to floor(usableRAM / perJobGb),
// usableRAM = totalmem × memFraction (headroom for the OS, the GUI, and the
// parent runner). Never below 1. Bypass with CC_NO_MEM_CAP=1 on a big/isolated
// host where the caller's count is deliberate.
function memoryCappedJobs(requested, perJobGb = 4, memFraction = 0.6) {
  if (process.env.CC_NO_MEM_CAP === '1') return Math.max(1, requested);
  const usableGb = (os.totalmem() / 2 ** 30) * memFraction;
  const ramCap = Math.max(1, Math.floor(usableGb / perJobGb));
  return Math.max(1, Math.min(requested, ramCap));
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

summary.json records the run's SCOPE (todos/0339): \`filter\`, a \`files\` block
(total / selected / executed / resumed / carried / carriedFailed / recorded /
staleDropped) and a \`runs\` list. Results are MERGED across runs — a suite
split into two --filter halves ends up with one record accounting for the whole
suite, with each half's results tagged by the run that measured them.
\`recorded\` == \`total\` is what "the whole suite was covered" looks like on
disk: every CURRENT suite file has a record (todos/0368 — a stale record for a
deleted/renamed file is dropped at merge, loudly, and cannot stand in). It does
not mean measured-now (see \`runs\`) or green (see \`carriedFailed\` — a carried
FAIL is red in the record but never fails a later run's exit).
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

  // ---- selection, as a recorded fact (todos/0339) ----
  //
  // A summary that does not say WHAT was selected cannot distinguish a full run
  // from a filtered one — and the full browser sweep exceeds a single tool call,
  // so in practice it is always run as two `--filter` halves. Both halves say
  // `pass`; before this, half 2 also overwrote half 1's results, so the artifact
  // of a complete 40-file sweep was byte-identical to the artifact of a lane
  // that ran only twenty files by mistake. Captured here, BEFORE --repeat fans
  // files out and BEFORE --resume filters them: these two numbers describe the
  // run's scope, not its schedule.
  const totalFiles = entries.length;
  const selectedSet = new Set(files.map(e => e.file));

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
  const prevResults = (prev && prev.results) || [];
  // --resume reads only the previous run's OWN results, never merged-in ones
  // (`carried`, below). Resuming off a carried result would let a file that
  // passed on Monday be skipped by Friday's "full" sweep and still be reported
  // green — the stale-scope failure this ticket exists to close, reintroduced
  // through the back door. Its own `resumed` chain stays eligible, so --resume
  // behaves exactly as it did before the merge landed.
  const prevByFile = new Map(prevResults.filter(r => !r.carried).map(r => [r.file, r]));

  // ---- merge, so half 2 cannot delete half 1 (todos/0339) ----
  //
  // THE `recorded == total` CONTRACT (todos/0368 — canonical statement).
  // `files.recorded == files.total` in summary.json certifies exactly this:
  //
  //   every file in the suite's CURRENT entry table has at least one result
  //   record in this summary — measured either by this run (fresh, or this
  //   run's own --resume chain) or by a prior merged run (tagged `carried`,
  //   stamped `carriedFrom`).
  //
  // It does NOT certify freshness (a carried record may be arbitrarily old —
  // the `runs` list says when each contributor ran; a consumer that needs
  // "measured now" must require executed + resumed == total) and it does NOT
  // certify greenness (`recorded` counts records, not passes — statuses live
  // on the records; see the carried-FAIL contract at the closing summary).
  //
  // Two rules keep the certificate honest:
  //   (a) a record counts only if its file is in the CURRENT entry table. A
  //       summary from before a delete/rename can hold a record for a file
  //       that no longer exists; carrying it would let that ghost offset a
  //       missing record for a current file (rename D→E, filter around E: the
  //       stale D record kept recorded == total while E was never measured).
  //       Stale records are dropped here — loudly (`staleDropped` + a warning
  //       line), never silently.
  //   (b) a file this run DID select is never carried — its fresh result
  //       replaces the old one, and if fail-fast stopped before it ran, the
  //       record simply lacks it.
  //
  // Results for current-but-unselected files are carried forward, tagged, and
  // stamped with the run that actually measured them. Merging must never make
  // a stale result look fresh: `carried` says it was not measured now, and
  // `carriedFrom` (plus the `runs` list) says exactly when it was.
  const currentSet = new Set(entries.map(e => e.file));
  const staleDropped = [...new Set(prevResults.filter(r => !currentSet.has(r.file)).map(r => r.file))];
  const carried = prevResults
    .filter(r => currentSet.has(r.file) && !selectedSet.has(r.file))
    .map(r => Object.assign({}, r, {
      carried: true,
      carriedFrom: r.carriedFrom || (prev && prev.startedAt) || null,
    }));
  // Prior run records, pruned to those still owning a carried result — so the
  // list self-limits: one unfiltered run selects everything, carries nothing,
  // and the record collapses back to a single run entry.
  const carriedRuns = new Set(carried.map(r => r.carriedFrom).filter(Boolean));
  const priorRuns = ((prev && Array.isArray(prev.runs) ? prev.runs
      : prev && prev.startedAt ? [{                       // pre-0339 summary
          startedAt: prev.startedAt, filter: prev.filter || null,
          total: null, selected: null, executed: null,
          jobs: prev.jobs, repeat: prev.repeat, underLoad: prev.underLoad,
          elapsedMs: prev.elapsedMs, done: prev.done,
        }]
      : []))
    .filter(r => carriedRuns.has(r.startedAt));

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
    const own = resumed.map(r => Object.assign({}, r, { resumed: true })).concat(results);
    const all = carried.concat(own);
    // `files` is the audit line. `selected`/`total` are this run's scope;
    // `recorded` is how many of the suite's files the ARTIFACT accounts for at
    // all, which is the number that answers "was the whole suite covered?".
    const thisRun = {
      startedAt, filter: opts.filter || null,
      total: totalFiles, selected: selectedSet.size,
      executed: new Set(results.map(r => r.file)).size,
      resumed: resumed.length,
      jobs: opts.jobs, repeat, underLoad,
      done: !!done, elapsedMs: Date.now() - t0,
    };
    writeJsonAtomic(summaryPath, {
      suite: opts.name, startedAt, node: process.version, jobs: opts.jobs,
      repeat, underLoad, done: !!done, elapsedMs: Date.now() - t0,
      filter: opts.filter || null,
      files: {
        total: totalFiles,
        selected: selectedSet.size,
        executed: thisRun.executed,
        resumed: resumed.length,
        carried: new Set(carried.map(r => r.file)).size,
        // Distinct carried files whose result is red. Deliberately NOT part of
        // this run's exit code (the carried-FAIL contract, closing summary) —
        // but a whole-suite-green consumer must see it here.
        carriedFailed: new Set(carried.filter(r => r.status !== 'pass').map(r => r.file)).size,
        recorded: new Set(all.map(r => r.file)).size,
        // Records dropped because their file left the suite (rule (a) above).
        staleDropped: staleDropped.length,
      },
      runs: priorRuns.concat([thisRun]),
      results: all,
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
      // `-r parent-watch.js` makes the child die with US. `detached: true` gives
      // it its own process group (so the timeout below can group-kill its
      // serve.js/Chromium grandchildren) but by the same token puts it OUT of
      // our group — so a SIGKILL of this runner from outside reaches nothing.
      // The preload closes that: it polls its ppid and tears its own group down
      // when we vanish. CC_HARNESS_GROUP_LEADER tells it the group kill is its
      // to make (true exactly because we detached it). See parent-watch.js.
      const child = spawn(process.execPath,
        ['-r', PARENT_WATCH, path.join(opts.dir, entry.file), ...(entry.args || [])], {
        cwd: opts.dir, detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { CC_HARNESS_GROUP_LEADER: '1' }, opts.env || {}),
      });
      inflight.add(child);
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      let timedOut = false;
      const deadline = entry.timeoutMs || opts.timeoutMs;
      const timer = setTimeout(() => {
        // `timedOut` is latched BEFORE the kill, so the graceful window cannot
        // relabel a timeout as an ordinary signalled failure.
        timedOut = true;
        killGroup(child);
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
    // sync: we call process.exit() a few lines down, so there is no later turn
    // in which a deferred SIGKILL could fire.
    for (const c of inflight) killGroup(c, { sync: true });
    stopLoad();
    checkpoint(false);
    process.stdout.write(`\ninterrupted — partial summary at ${summaryPath}\n`);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Splitting a suite with --filter is legitimate and will continue — the full
  // browser sweep does not fit one tool call. It should just never be silent
  // (todos/0339), so say how much of the suite this run covers, up front.
  if (opts.filter) {
    process.stdout.write(`\x1b[33m⚠ ${opts.name}: --filter=${opts.filter} selected `
      + `${selectedSet.size} of ${totalFiles} files — this run covers PART of the suite.\x1b[0m\n`);
  }
  // Rule (a) of the recorded==total contract, loud half: a dropped record must
  // be announced, never silently pruned (the no-silent-caps rule) — the reader
  // of a suddenly-partial record needs to know WHY it went partial.
  if (staleDropped.length) {
    process.stdout.write(`\x1b[33m⚠ ${opts.name}: dropped ${staleDropped.length} stale record(s) for `
      + `file(s) no longer in the suite: ${staleDropped.join(', ')}\x1b[0m\n`);
  }

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
  const recorded = new Set(carried.concat(resumed, results).map(r => r.file)).size;
  // The carried-FAIL contract (todos/0368). `failed` — and with it this run's
  // exit code — covers ONLY what this run measured (executed files + its own
  // resume chain). A carried FAIL does not fail this exit: the run that
  // measured it already exited red, and this run was explicitly asked not to
  // re-measure that file (it was filtered out). Failing here would push a lane
  // that just fixed file A under --filter=A to delete summary.json for a green
  // exit — destroying the whole-suite record the merge exists to keep. The red
  // stays VISIBLE instead: status 'fail' + carried tags on the record,
  // `files.carriedFailed` in the manifest and return value, and the count on
  // this closing line. A consumer that wants "whole suite green" must read the
  // RECORD (every result green AND recorded == total), never one exit code.
  const carriedFailed = new Set(carried.filter(r => r.status !== 'pass').map(r => r.file)).size;
  const parts = [`${passed} passed`, `${failed} failed`];
  if (resumed.length) parts.push(`${resumed.length} resumed`);
  if (carried.length) parts.push(`${carried.length} carried from earlier run(s)`);
  if (carriedFailed) parts.push(`\x1b[31m${carriedFailed} carried FAIL(s) — red in the record, not in this exit\x1b[0m`);
  if (bailed) parts.push('(fail-fast: remaining files not run)');
  const coverage = `[${selectedSet.size}/${totalFiles} selected, ${recorded}/${totalFiles} recorded]`;
  process.stdout.write(`\n${opts.name}: ${parts.join(', ')}  (${elapsed})  ${coverage}  `
    + `summary: ${path.relative(process.cwd(), summaryPath)}\n`);
  return {
    passed, failed, resumed: resumed.length, bailed, flake,
    files: { total: totalFiles, selected: selectedSet.size, carried: carried.length,
             carriedFailed, recorded, staleDropped: staleDropped.length },
  };
}

module.exports = { runSuite, parseSuiteArgs, usage, matchesFilter, memoryCappedJobs };
