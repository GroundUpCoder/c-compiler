#!/usr/bin/env node
'use strict';
// tests/netsurf/run.js — the `netsurf-patch` suite (todos/0423): the offline
// half of the vendor/netsurf patch-record invariant.
//
// `vendor/netsurf/update.sh`'s header claims the committed trees are
// byte-identically reproducible from upstream + patches/. The full proof
// needs the network (update.sh --check, on its cadence — README.md
// "Updating"); THIS suite is the half the ordinary gate can afford:
// patchcheck.mjs proves the committed (tree, diff) pair self-consistent by
// strict reverse-apply (frame + manifest + differential-when-dirty), and its
// test file keeps the acceptance proofs — injected drift fails, a
// constructed edit-without-record commit fails — alive as regressions.
//
//   node tests/netsurf/run.js [--filter=STR]
//
// Cheap by construction (two short node processes, no image, no browser, no
// network), so it sits right after `todos` in RUN_ORDER.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// Cross-tree preflight (todos/0341) — cases run with `cwd: ROOT`, so a
// main-tree copy launched from a worktree would otherwise validate MAIN's
// patch record and report it as yours.
require('../lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/netsurf/run.js' });

const CASES = [
  // The standing check itself: frame + manifest over the real tree, plus the
  // worktree-vs-HEAD differential whenever vendor/netsurf is dirty.
  { name: 'patchcheck',       argv: ['vendor/netsurf/patchcheck.mjs'] },
  // Its own tests: unit reverse-apply shapes + scratch-repo acceptance proofs.
  { name: 'patchcheck-tests', argv: ['tests/netsurf/patchcheck.test.mjs'] },
];

function main() {
  const filter = (process.argv.find(a => a.startsWith('--filter=')) || '').slice(9);
  const cases = filter ? CASES.filter(c => c.name.includes(filter)) : CASES;
  if (!cases.length) {
    process.stdout.write(`netsurf-patch: no case matches --filter=${filter} (have: ${CASES.map(c => c.name).join(', ')})\n`);
    process.exit(1);
  }

  let failed = 0;
  const t0 = Date.now();
  for (const c of cases) {
    process.stdout.write(`\n── ${c.name} ──\n$ node ${c.argv.join(' ')}\n`);
    const r = spawnSync('node', c.argv, { cwd: ROOT, stdio: 'inherit' });
    const ok = r.status === 0 && !r.error;
    if (!ok) {
      failed++;
      process.stdout.write(`   FAIL ${c.name} (${r.error ? r.error.message : `exit ${r.status}`})\n`);
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\nnetsurf-patch suite: ${cases.length - failed}/${cases.length} passed, ${failed} failed  (${secs}s)\n`);
  process.exit(failed ? 1 : 0);
}

main();
