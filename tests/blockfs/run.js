#!/usr/bin/env node
'use strict';
// Runs the whole BlockFS test suite. Pass --long for the deeper fuzz pass.
//   node tests/blockfs/run.js [--long] [-j N] [--filter=S] [--resume] ...
//
// Engine: tests/lib/suite-runner.js (todos/0081) — parallel by default
// (every file is an independent in-process MemoryByteStore world), per-file
// logs + checkpointed summary.json in build/test-blockfs/.
const path = require('path');
const os = require('os');
const { runSuite, parseSuiteArgs, usage, assertMemberRegistry } = require('../lib/suite-runner.js');

// Cross-tree preflight (todos/0341) — artifactDir below is resolved from this
// file's location, so a cross-tree launch overwrites another tree's
// build/test-blockfs/summary.json with a run it never made.
require('../lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/blockfs/run.js' });

const argv = process.argv.slice(2);
const long = argv.includes('--long');
const rest = argv.filter(a => a !== '--long');

const tests = [
  { file: 'test_tlsf.js' },
  { file: 'test_tlsf64.js' },
  { file: 'test_v4.js' },
  { file: 'test_dev.js' },
  { file: 'test_migrate.js' },
  { file: 'test_openworkspace.js' },
  { file: 'test_fsck_v4.js' },
  { file: 'test_readonly.js' },
  { file: 'test_mounts.js' },
  { file: 'test_blockfs.js' },
  { file: 'test_stdin_sab.js' },
  { file: 'test_e2e.js' },
  { file: 'test_fsck.js' },
  { file: 'test_posix.js' },
  { file: 'test_fuzz.js', args: long ? ['--long'] : [], timeoutMs: long ? 3600000 : 600000 },
];

const defaults = { jobs: Math.max(1, os.cpus().length - 2), timeoutMs: 600000 };
const opts = parseSuiteArgs(rest, defaults);
if (opts.help) { process.stdout.write(usage('tests/blockfs/run.js [--long]', defaults)); process.exit(0); }

// #314: this list is hardcoded like the kernel suite's, so it gets the same
// guard — a test_*.js on disk that no row names refuses the run instead of
// silently never executing (no exclusions today; a deliberate one must carry
// its owning ticket).
const MEMBER_RE = /^test_.*\.js$/;
assertMemberRegistry({
  dir: __dirname, pattern: MEMBER_RE, entries: tests,
  exclude: [], label: 'tests/blockfs/run.js',
});

// #549: member files must exit NATURALLY (`process.exitCode = …`), never via
// `process.exit()`. process.exit()'s shortcut teardown joins the V8 worker
// pool while a concurrent sparkplug/maglev compile job can be parked in
// CollectionBarrier::AwaitCollectionBackground waiting on a main-thread GC
// that will never come (nodejs/node#54918, unfixed as of v25.8.2) — the file
// then hangs AFTER printing its pass summary and the runner records a 600 s
// timeout, turning a green gate red. Measured here: 4 hangs in ~1700 spawns
// of test_mounts.js with process.exit, 0 in 19200 without (logs/2026-08-07).
// Natural exit disposes the isolate first, which cancels those jobs safely.
const fs = require('fs');
for (const t of tests) {
  const src = fs.readFileSync(path.join(__dirname, t.file), 'utf8');
  if (/\bprocess\.exit\s*\(/.test(src)) {
    process.stderr.write(
      `tests/blockfs/run.js: ${t.file} calls process.exit() — use ` +
      `\`process.exitCode = …\` and exit naturally (#549: process.exit can ` +
      `deadlock Node's platform shutdown and read as a 600s timeout).\n`);
    process.exit(2);
  }
}

runSuite(tests, {
  name: 'blockfs suite',
  dir: __dirname,
  artifactDir: path.resolve(__dirname, '../../build/test-blockfs'),
  jobs: opts.jobs, timeoutMs: opts.timeoutMs, filter: opts.filter,
  failFast: opts.failFast, resume: opts.resume, list: opts.list,
  repeat: opts.repeat, underLoad: opts.underLoad,
  evidence: { pattern: MEMBER_RE, exclude: [] },
}).then(r => process.exit(r.failed ? 1 : 0))
  .catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
