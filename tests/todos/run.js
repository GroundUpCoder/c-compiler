#!/usr/bin/env node
'use strict';
// tests/todos/run.js — the `todos` suite: the liability register validator
// and its tests (todos/done/0286), plus the Lnn id-allocator tests.
//
// The register validator has to gate from a suite because the pre-commit hook
// is per-clone opt-in (`git config core.hooksPath todos/githooks`) — a
// validator whose only trigger is opt-in config is prose. This suite is what
// makes it gate. (Until the 2026-07-30 queue cutover it also ran the
// queue-manifest validator; the file-based queue is retired — see CLAUDE.md
// "Tickets & the work queue".)
//
//   node tests/todos/run.js [--filter=STR]
//
// Cheap by construction (a few short node processes, no image, no browser),
// so it can sit at the front of RUN_ORDER and fail in a second.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// Cross-tree preflight (todos/0341) — every case below runs with `cwd: ROOT`,
// so without this a main-tree copy launched from a worktree would validate
// MAIN's queue and register and report it as yours.
require('../lib/tree-guard.js').assertSameTree(__dirname, { label: 'tests/todos/run.js' });

const CASES = [
  { name: 'liabilities-check', argv: ['todos/liabilities.js', 'check'] },
  { name: 'liabilities-tests', argv: ['todos/liabilities.test.js'] },
  // The id allocator's freshness half (todos/0360). Real clones over local
  // paths, so it stays offline and cheap like the rest of this suite.
  { name: 'idspace-tests',     argv: ['todos/idspace.test.js'] },
];

function main() {
  const filter = (process.argv.find(a => a.startsWith('--filter=')) || '').slice(9);
  const cases = filter ? CASES.filter(c => c.name.includes(filter)) : CASES;
  if (!cases.length) {
    process.stdout.write(`todos: no case matches --filter=${filter} (have: ${CASES.map(c => c.name).join(', ')})\n`);
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
  process.stdout.write(`\ntodos suite: ${cases.length - failed}/${cases.length} passed, ${failed} failed  (${secs}s)\n`);
  process.exit(failed ? 1 : 0);
}

main();
