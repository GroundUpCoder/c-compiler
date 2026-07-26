#!/usr/bin/env node
// The browser OS sweep as ONE command (todos/0081): runs every os-*.mjs
// acceptance file in this directory — real Chromium, real serve.js, full OS
// boot each, exactly as when run by hand — SERIALLY (deliberate: the 0045
// one-kernel-per-origin boot lock plus CPU contention make concurrent
// Chromium+OS boots flaky by construction; see todos/0081).
//
//   node os-sweep.mjs                # the full sweep, alphabetical
//   node os-sweep.mjs --filter=shell # just os-shell.mjs
//   node os-sweep.mjs --resume       # skip files that passed last run
//   node os-sweep.mjs --fail-fast
//
// Engine: ../lib/suite-runner.js — per-file logs + an incrementally
// checkpointed summary.json in ../../build/test-browser/, per-file timeout
// with process-group kill (each test spawns its own serve.js + Chromium;
// a hung page can't wedge the sweep or leak servers).
//
// The sweep list is DISCOVERED (os-*.mjs), so new acceptance files join
// automatically — no second list to keep in sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite, parseSuiteArgs, usage } from '../lib/suite-runner.js';
import { ensurePrebakedImage } from '../lib/image-fixture.js';
import { acquireHeavyLock } from '../lib/heavy-lock.js';
import { preflight } from '../lib/harness-leaks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const files = fs.readdirSync(__dirname)
  .filter(f => /^os-.*\.mjs$/.test(f) && f !== 'os-sweep.mjs')
  .sort()
  .map(file => ({ file }));

const defaults = { jobs: 1, timeoutMs: 600000 };
const opts = parseSuiteArgs(process.argv.slice(2), defaults);
if (opts.help) { process.stdout.write(usage('tests/browser/os-sweep.mjs', defaults)); process.exit(0); }
if (opts.jobs !== 1) { process.stderr.write('os-sweep is serial by design (0045 boot lock + contention); ignoring -j\n'); opts.jobs = 1; }

// Heavy-suite mutual exclusion: this sweep drives a real Chromium per file;
// refuse to start if another heavy runner (the kernel suite, or a second
// sweep) already owns the host — their overlap is what crashed the machine on
// 2026-07-25. Taken before the bake so two sweeps can't both bake either.
if (!opts.list) acquireHeavyLock({ name: 'browser os sweep' });

// Leak pre-flight — AFTER the lock, deliberately. Holding it proves no other
// heavy suite is mid-flight, so the reaper cannot race one; a lane that lost the
// lock exits 3 above and never gets here. What it reaps is only ever provably
// abandoned (dead owner pid / PPID 1), so a hand-run single os-*.mjs, which
// takes no lock at all, is safe too. It also names any stray serve.js BEFORE
// the run — a squatted fixed port is the sweep's classic false red, and
// diagnosing it after the fact costs a whole sweep.
if (!opts.list) preflight({ name: 'browser os sweep' });

// 0082 pre-step: a missing/version-stale/INPUT-stale prebaked
// os/os-system.img re-bakes once, visibly, before Chromium ever launches.
// (serve.js runs the same gate per test file; this keeps the one bake out
// of the first test's timing and log.)
if (!opts.list) ensurePrebakedImage();

runSuite(files, {
  name: 'browser os sweep',
  dir: __dirname,
  artifactDir: path.resolve(__dirname, '../../build/test-browser'),
  jobs: 1, timeoutMs: opts.timeoutMs, filter: opts.filter,
  failFast: opts.failFast, resume: opts.resume, list: opts.list,
  repeat: opts.repeat, underLoad: opts.underLoad,
}).then(r => process.exit(r.failed ? 1 : 0))
  .catch(e => { process.stderr.write(`Fatal: ${e.stack || e.message}\n`); process.exit(2); });
