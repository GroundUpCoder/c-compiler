'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert');
const { setup } = require('./common.cjs');
const { c, record } = setup('cmdalt');
require(path.join(c.root, 'tests/lib/heavy-lock.js')).joinHeavyLock({ name: '#785 current cmdalt observation' });
assert(!process.env.NODE_OPTIONS, 'review existing NODE_OPTIONS explicitly before combining preloads');
const preload = path.join(__dirname, 'cmdalt-preload.cjs');
const r = cp.spawnSync(process.execPath, [path.join(c.root, 'tests/kernel/test_cmdalt_e2e.js')], {
  cwd: c.root, encoding: 'utf8', timeout: c.cmdalt.timeoutMs, maxBuffer: 128 << 20,
  env: { ...process.env, IDENTITY785_CONFIG: path.resolve(process.argv[3]), NODE_OPTIONS: '--require=' + JSON.stringify(preload) },
});
record('cmdalt-result.json', { status: r.status, signal: r.signal, error: r.error && String(r.error), stdout: r.stdout, stderr: r.stderr });
assert.strictEqual(r.status, 0, 'original current cmdalt test must pass all original assertions');
const observations = fs.readFileSync(path.join(c.output, 'cmdalt-identity.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
assert(observations.length > 0, 'current identity observation required');
for (const row of observations) {
  assert.strictEqual(row.kind, 'post-existing-shadow-chmod');
  const a = row.files['/usr/local/bin/python'].stat, b = row.files['/usr/bin/cmdalt'].stat;
  assert(a && b, 'both actual paths measured');
  assert(a.dev !== b.dev || a.ino !== b.ino, 'current shadow and dispatcher differ');
}
record('outcome.json', { status: 'pass' });
