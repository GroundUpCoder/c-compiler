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
//   - --resume (skip files that passed in the previous summary AND whose own
//     source has not changed since that pass — see staleForResume, #455),
//     --filter, --fail-fast, --timeout, -j, --list
//   - a summary that records its own SCOPE (todos/0339): `filter`, a `files`
//     block (total / selected / executed / carried / recorded) and a `runs`
//     list, and results MERGED across runs so a two-`--filter`-half sweep
//     accounts for the whole suite instead of the second half deleting the
//     first. See the selection + merge blocks in runSuite.
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

// ---- member-registry completeness (ticket #314) ----
//
// A suite whose member list is HARDCODED can hold a file that is named and
// located exactly like every other member and still executes NOWHERE: the
// diff→suite planner maps the new path to the suite (unmapped: []), the runner
// executes its normal list, totals agree, and the gate goes green with the new
// test never having run. `recorded == total` cannot catch it — the member list
// defines `total`, so the transform is being verified with its own key. This
// bit three times (test_punes_e2e.js, 2026-07-18; os/gcode/test/smoke.mjs;
// tests/kernel/test_win32rc.js, live on the #311 lane).
//
// This asserts SET EQUALITY between the directory and the declared list before
// anything runs: every on-disk file matching `pattern` must be a declared
// member (or a NAMED allowlist entry carrying its owner), and every declared
// member must exist on disk. Diverge → refuse to run, naming the file — the
// same fail-loud design the diff table applies to a new tools/ path
// (todos/0333), applied to suite membership. Callers with hardcoded lists
// (tests/kernel/run.js, tests/blockfs/run.js) invoke this BEFORE taking the
// heavy lock; glob-discovered suites (the browser sweep) need no call — their
// list IS the directory.
//
// exclude: [{ file, owner }] — a deliberate exclusion must name the live
// ticket that owns registering it, and the entry must come out in the same
// change that registers the file (a stale entry — file gone, or file now
// declared — fails here, so the allowlist cannot outlive its reason).
function assertMemberRegistry({ dir, pattern, entries, exclude = [], label }) {
  const onDisk = fs.readdirSync(dir).filter(f => pattern.test(f)).sort();
  const onDiskSet = new Set(onDisk);
  const declared = entries.map(e => e.file);
  const declaredSet = new Set(declared);
  const errs = [];
  if (declaredSet.size !== declared.length) {
    const seen = new Set();
    for (const f of declared) {
      if (seen.has(f)) errs.push(`${f}: declared MORE THAN ONCE`);
      seen.add(f);
    }
  }
  const exclByFile = new Map(exclude.map(e => [e.file, e]));
  for (const [f, e] of exclByFile) {
    if (declaredSet.has(f)) errs.push(`${f}: both declared AND excluded (owner ${e.owner}) — the allowlist entry outlived its reason; remove it`);
    else if (!onDiskSet.has(f)) errs.push(`${f}: excluded (owner ${e.owner}) but no longer on disk — the allowlist entry outlived its file; remove it`);
  }
  for (const f of onDisk) {
    if (!declaredSet.has(f) && !exclByFile.has(f)) {
      errs.push(`${f}: exists on disk but is NOT a declared member — it would execute NOWHERE. `
        + `Register it in ${label}'s member list, or add a named allowlist entry with its owning ticket.`);
    }
  }
  for (const f of declaredSet) {
    if (!onDiskSet.has(f)) errs.push(`${f}: declared but MISSING on disk`);
  }
  if (errs.length) {
    process.stderr.write(`\x1b[31m[suite-registry] ${label}: the member list does not match ${dir}:\x1b[0m\n`);
    for (const e of errs) process.stderr.write(`  ${e}\n`);
    process.exit(2);
  }
  process.stdout.write(`registry: ${declaredSet.size} declared + ${exclude.length} excluded == ${onDisk.length} on disk (${label})\n`);
}

// ---- resume freshness (ticket #455) ----
//
// `--resume` used to skip on STATUS ALONE: a file that said `pass` in the
// previous summary was skipped, full stop — no mtime, no hash, no look at the
// file on disk. So editing a test and then "re-running with --resume to
// confirm" skipped the very file that was edited, and printed green. That is
// the same shape as the defects this estate keeps finding: a mechanism that
// reports PASS while the thing under test never executed. (The case that found
// it: test_gdi32_e2e.js on the 277-278 lane, where a `return` had shadowed a
// live check — the confirming run would have proved nothing.)
//
// The evidence of a pass is its per-file LOG, and the log path is recomputed
// here the way runOne writes it rather than read from the record's `log` field
// (that field is relative to the CWD of whichever run wrote it; the artifactDir
// is absolute and stable). A resumed result carries its ORIGINAL log forward,
// so the log's mtime keeps meaning "when this file last actually executed",
// however long the resume chain is.
//
// Returns a human-readable reason to RE-EXECUTE, or null to allow the resume:
//   - no log ............ no evidence the pass ever happened here; run it.
//   - source newer ...... the file changed since it passed; the pass is stale.
// Deliberately scoped to the member's OWN source, not its transitive read set —
// dependency-level freshness is ticket #151 and is a much heavier mechanism.
// The narrow check closes the case that actually bit, at one statSync per file.
// What that leaves open is registered (LIABILITIES L77): a member whose own
// source is untouched still resumes when a HELPER it reads has changed.
function staleForResume(entry, opts) {
  const logPath = path.join(opts.artifactDir, entry.file.replace(/[\/\\]/g, '_') + '.log');
  let logMs;
  try { logMs = fs.statSync(logPath).mtimeMs; }
  catch { return `no per-file log at ${path.relative(process.cwd(), logPath)} — no evidence of that pass in this artifact dir`; }
  const srcPath = path.join(opts.dir, entry.file);
  let srcMs;
  try { srcMs = fs.statSync(srcPath).mtimeMs; }
  catch { return `source ${entry.file} is missing on disk`; }
  if (srcMs > logMs) {
    return `source changed since its passing log (source ${new Date(srcMs).toISOString()} > log ${new Date(logMs).toISOString()})`;
  }
  return null;
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
  --resume      skip files that PASSED in the previous run (summary.json) and
                whose own source file has not been modified since that pass
                (#455 — an edited test is re-executed, never resumed; its
                DEPENDENCIES are not checked, that is #151)
  --list        print the (filtered) file list and exit
  --repeat N    run each selected file N times; report a per-file flake rate
                (a non-flaky file is N/N green). Disables --resume. (0147)
  --under-load[=N]  run under CPU contention: N busy-loop generators steal
                cores for the duration (bare flag = one per core). Surfaces
                sleep/timing regressions the idle box hides. (0147)

Artifacts: <artifactDir>/summary.json (checkpointed after every file) and
<artifactDir>/<file>.log (combined stdout+stderr per file).

summary.json records the run's SCOPE (todos/0339): \`filter\`, a \`files\` block
(total / selected / executed / resumed / carried / recorded) and a \`runs\` list.
Results are MERGED across runs — a suite split into two --filter halves ends up
with one record accounting for the whole suite, with each half's results tagged
by the run that measured them. \`recorded\` == \`total\` is what "the whole suite
was covered" looks like on disk.
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
  // Stamped before anything is scheduled: the execution-evidence check at the
  // end (ticket #314) compares per-file log mtimes against this instant.
  const evidenceT0 = Date.now();
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
  // Results for files this run did not select are carried forward, tagged, and
  // stamped with the run that actually measured them. Merging must never make a
  // stale result look fresh: `carried` says it was not measured now, and
  // `carriedFrom` (plus the `runs` list) says exactly when it was. A file this
  // run DID select is never carried — its fresh result replaces the old one,
  // and if fail-fast stopped before it ran, the record simply lacks it.
  const carried = prevResults
    .filter(r => !selectedSet.has(r.file))
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
      if (!r || r.status !== 'pass') return true;
      const why = staleForResume(e, opts);
      if (why) {
        process.stdout.write(`\x1b[33mresume: ${e.file} NOT resumed — ${why}\x1b[0m\n`);
        return true;
      }
      resumed.push(r);
      return false;
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
  let evidence = null;
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
        recorded: new Set(all.map(r => r.file)).size,
      },
      runs: priorRuns.concat([thisRun]),
      results: all,
      ...(flake ? { flake } : {}),
      ...(evidence ? { evidence } : {}),
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
      // A re-run must not destroy failure evidence (ticket #456): when the
      // previous invocation recorded a non-pass for this file, its log is the
      // only artifact of that red, and the solo re-run used to DIAGNOSE it
      // would otherwise truncate it into a PASS — the original #456 red
      // survived nowhere but a dispatcher probe log. Move it aside under a
      // .redN suffix before opening. Green logs are overwritten freely, so
      // the archive only grows while a file is actually failing; summary.json
      // stays the authoritative count (the header comment's *.log rule).
      const prior = prevByFile.get(entry.file);
      if (prior && prior.status !== 'pass' && fs.existsSync(logPath)) {
        let n = 1, redPath;
        do { redPath = logPath.replace(/\.log$/, `.red${n}.log`); n++; }
        while (fs.existsSync(redPath));
        try {
          fs.renameSync(logPath, redPath);
          process.stdout.write(`red log preserved → ${path.relative(process.cwd(), redPath)}\n`);
        } catch (e) {
          process.stdout.write(`warning: could not preserve red log ${logPath}: ${e.message}\n`);
        }
      }
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

  // ---- execution evidence (ticket #314) ----
  //
  // The POSITIVE half of the coverage guard: every member the run selected must
  // have a per-file log whose mtime post-dates the run's start. The keys —
  // the directory glob and the log files' mtimes — are independent of this
  // runner's own bookkeeping (results/summary counters), which is the point:
  // a member that is registered but silently never scheduled has no fresh log,
  // no matter what the counters say. This is exactly the discriminator that
  // caught test_win32rc.js at gate time (its missing log was the tell; exit
  // code 0 was not).
  //
  //   fresh run ... every selected member's log mtime >= run start, or FAIL.
  //   --resume .... resumed files deliberately keep their old logs, so THIS
  //                 check asserts their existence only, and the summary line
  //                 says so — a resumed run never silently claims fresh full
  //                 coverage. What the old log is now known to be current FOR
  //                 is the member's own source: the resume predicate refused to
  //                 resume any file edited since that log (#455). Its
  //                 DEPENDENCIES are still unchecked (#151).
  //   fail-fast ... a bailed run already failed and printed which files were
  //                 not run; evidence is skipped with a note instead of
  //                 re-flagging every unrun member.
  if (opts.evidence && !opts.list) {
    if (bailed) {
      process.stdout.write('evidence: not asserted (fail-fast bailed before the suite completed)\n');
    } else {
      const excl = new Set((opts.evidence.exclude || []).map(e => e.file || e));
      const expected = fs.readdirSync(opts.dir)
        .filter(f => opts.evidence.pattern.test(f) && !excl.has(f) && matchesFilter(f, opts.filter))
        .sort();
      const resumedSet = new Set(resumed.map(r => r.file));
      const problems = [];
      let freshN = 0, resumedN = 0;
      for (const f of expected) {
        const base = f.replace(/[\/\\]/g, '_');
        const cands = repeat > 1
          ? Array.from({ length: repeat }, (_, k) => path.join(opts.artifactDir, `${base}.rep${k + 1}.log`))
          : [path.join(opts.artifactDir, base + '.log')];
        const mtimes = cands.map(p => { try { return fs.statSync(p).mtimeMs; } catch { return null; } })
          .filter(m => m != null);
        if (!mtimes.length) { problems.push(`${f}: NO per-file log — the runner never executed it`); continue; }
        if (resumedSet.has(f)) { resumedN++; continue; }
        if (Math.max(...mtimes) < evidenceT0) {
          problems.push(`${f}: log predates this run (${new Date(Math.max(...mtimes)).toISOString()} < ${new Date(evidenceT0).toISOString()}) — not executed by it`);
          continue;
        }
        freshN++;
      }
      evidence = { expected: expected.length, fresh: freshN, resumedExistenceOnly: resumedN,
                   problems: problems.length ? problems : undefined };
      if (problems.length) {
        failed += problems.length;
        for (const p of problems) process.stdout.write(`\x1b[31mEVIDENCE ${p}\x1b[0m\n`);
      } else {
        process.stdout.write(`evidence: ${freshN}/${expected.length} selected members have logs post-dating the run start`
          + (resumedN ? ` (+${resumedN} resumed: log existence only — source unchanged since it (#455), dependencies NOT checked (#151))` : '') + '\n');
      }
    }
  }

  checkpoint(true);
  const elapsed = fmtSecs(Date.now() - t0);
  const recorded = new Set(carried.concat(resumed, results).map(r => r.file)).size;
  const parts = [`${passed} passed`, `${failed} failed`];
  if (resumed.length) parts.push(`${resumed.length} resumed`);
  if (carried.length) parts.push(`${carried.length} carried from earlier run(s)`);
  if (bailed) parts.push('(fail-fast: remaining files not run)');
  const coverage = `[${selectedSet.size}/${totalFiles} selected, ${recorded}/${totalFiles} recorded]`;
  process.stdout.write(`\n${opts.name}: ${parts.join(', ')}  (${elapsed})  ${coverage}  `
    + `summary: ${path.relative(process.cwd(), summaryPath)}\n`);
  return {
    passed, failed, resumed: resumed.length, bailed, flake,
    files: { total: totalFiles, selected: selectedSet.size, carried: carried.length, recorded },
  };
}

module.exports = { runSuite, parseSuiteArgs, usage, matchesFilter, memoryCappedJobs, assertMemberRegistry };
