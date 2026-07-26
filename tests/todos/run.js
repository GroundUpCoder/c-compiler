#!/usr/bin/env node
'use strict';
// tests/todos/run.js — the `todos` suite: the queue manifest + liability
// register validators, and their own tests (todos/0286).
//
// These validators existed (queue.js) or are new (liabilities.js), but neither
// was reachable from any suite: tests/run.js IGNOREd all of todos/, and the
// pre-commit hook that runs `queue.js check` is per-clone opt-in
// (`git config core.hooksPath todos/githooks`). A validator whose only trigger
// is opt-in config is prose. This suite is what makes them gate.
//
//   node tests/todos/run.js [--filter=STR]
//
// Cheap by construction (four short node processes, no image, no browser), so
// it can sit at the front of RUN_ORDER and fail in a second.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const CASES = [
  { name: 'queue-check',       argv: ['todos/queue.js', 'check'] },
  { name: 'queue-tests',       argv: ['todos/queue.test.js'] },
  { name: 'liabilities-check', argv: ['todos/liabilities.js', 'check'] },
  { name: 'liabilities-tests', argv: ['todos/liabilities.test.js'] },
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
