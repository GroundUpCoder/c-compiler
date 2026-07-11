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
const { runSuite, parseSuiteArgs, usage } = require('../lib/suite-runner.js');

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

runSuite(tests, {
  name: 'blockfs suite',
  dir: __dirname,
  artifactDir: path.resolve(__dirname, '../../build/test-blockfs'),
  jobs: opts.jobs, timeoutMs: opts.timeoutMs, filter: opts.filter,
  failFast: opts.failFast, resume: opts.resume, list: opts.list,
  repeat: opts.repeat, underLoad: opts.underLoad,
}).then(r => process.exit(r.failed ? 1 : 0))
  .catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
