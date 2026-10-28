'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const assert = require('assert'), cp = require('child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
function setup(kind) {
  assert.strictEqual(process.argv[2], '--execute', 'prepared instrument; requires an explicit authorized launch');
  const configPath = path.resolve(process.argv[3]);
  const c = JSON.parse(fs.readFileSync(configPath));
  assert(c.grantReference && c.grantReference !== 'PENDING', 'coordinator window/reference required');
  assert(c.allowedKinds.includes(kind), 'workload not selected by launch configuration');
  assert.strictEqual(hashFile(process.execPath), c.node.sha256, 'Node executable drift');
  const which = cp.execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
  assert.strictEqual(hashFile(which), c.node.sha256, 'helpers using literal node resolve a different executable');
  for (const [file, hash] of Object.entries(c.sources)) assert.strictEqual(hashFile(path.join(c.root, file)), hash, file);
  for (const [file, hash] of Object.entries(c.instruments)) assert.strictEqual(hashFile(path.join(__dirname, file)), hash, file);
  for (const [file, hash] of Object.entries(c.fixtures || {})) assert.strictEqual(hashFile(file), hash, file);
  assert.strictEqual(cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: c.root, encoding: 'utf8' }).trim(), c.base);
  assert.strictEqual(sha(cp.execFileSync('git', ['diff', '--cached', '--binary'], { cwd: c.root, maxBuffer: 32 << 20 })), c.indexPatchSha256);
  assert.strictEqual(cp.execFileSync('git', ['diff', '--name-only'], { cwd: c.root, encoding: 'utf8' }).trim(), '', 'unstaged source drift');
  // Unique retained output: never remove or reuse an earlier evidence directory.
  fs.mkdirSync(c.output, { recursive: false });
  function record(name, value) { fs.writeFileSync(path.join(c.output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); }
  record('launch.json', { kind, configPath, configSha256: hashFile(configPath), config: c,
    executable: fs.realpathSync(process.execPath), executableSha256: hashFile(process.execPath), versions: process.versions,
    argv: process.argv, started: new Date().toISOString() });
  return { c, record };
}
module.exports = { setup, sha, hashFile };
