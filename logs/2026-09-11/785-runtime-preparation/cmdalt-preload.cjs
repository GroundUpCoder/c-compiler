'use strict';
// Opt-in current fixture observation. No original source/assertion edits.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { hashFile } = require('./common.cjs');
const configPath = process.env.IDENTITY785_CONFIG;
assert(configPath, 'missing authorized instrument configuration');
const c = JSON.parse(fs.readFileSync(configPath));
assert(c.grantReference && c.grantReference !== 'PENDING' && c.allowedKinds.includes('cmdalt'));
assert.strictEqual(hashFile(process.execPath), c.node.sha256);
for (const f of ['host.js', 'kernel.js', 'tests/kernel/test_cmdalt_e2e.js', 'os/cmdalt.h'])
  assert.strictEqual(hashFile(path.join(c.root, f)), c.sources[f], f);
const K = require(path.join(c.root, 'kernel.js'));
const original = K.Kernel.prototype._fsRpc;
K.Kernel.prototype._fsRpc = function (pcb, op, req) {
  const full = op === K.OP.FS_CHMOD ? this._pathFor(pcb, req.path) : null;
  if (full !== '/usr/local/bin/python' || (req.mode & 0o777) !== 0o755)
    return original.call(this, pcb, op, req);
  const ownRespond = Object.prototype.hasOwnProperty.call(this, '_respond');
  const respond = this._respond; let success = false;
  this._respond = function (target, reply) {
    if (target === pcb) success = !!reply && !reply.errno;
    return respond.apply(this, arguments);
  };
  let result;
  try { result = original.call(this, pcb, op, req); }
  finally { if (ownRespond) this._respond = respond; else delete this._respond; }
  if (!success) return result;
  // Read-only stat walks can touch error slots. Preserve every relevant slot
  // so the observation cannot change a later syscall's errno provenance.
  const owner = this._fs, backends = [owner, ...owner._mounts.map(m => m.fs)];
  const errors = backends.map(f => f._lastError);
  let observation;
  try {
    observation = { kind: 'post-existing-shadow-chmod', pid: pcb.pid, hostPid: process.pid,
      node: { executable: fs.realpathSync(process.execPath), sha256: hashFile(process.execPath), versions: process.versions },
      sourcePins: c.sources, files: {} };
    for (const name of ['/usr/local/bin/python', '/usr/bin/cmdalt'])
      observation.files[name] = { stat: owner.stat(name), lstat: owner.lstat(name) };
    observation.volumes = owner._mounts.map(m => ({ prefix: m.prefix, identity: owner.getVolumeIdentity(m.prefix) }));
  } catch (e) { observation = { kind: 'observation-error', error: e.stack }; }
  finally { backends.forEach((f, i) => { f._lastError = errors[i]; }); }
  fs.appendFileSync(path.join(c.output, 'cmdalt-identity.jsonl'), JSON.stringify(observation) + '\n');
  return result;
};
// Retain the actual generated fixture bytes/hash immediately before each boot.
const drive = require(path.join(c.root, 'tests/kernel/lib/drive.js'));
const driveBoot = drive.driveBoot;
let boots = 0;
drive.driveBoot = function (script, opts) {
  assert(opts && opts.image, 'explicit current cmdalt fixture required');
  const number = process.pid + '-' + (++boots);
  const bytes = fs.readFileSync(opts.image);
  fs.writeFileSync(path.join(c.output, 'cmdalt-' + number + '.img'), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(c.output, 'cmdalt-' + number + '.json'), JSON.stringify({
    imagePath: opts.image, imageSha256: require('./common.cjs').sha(bytes), script, opts,
    testSha256: hashFile(path.join(c.root, 'tests/kernel/test_cmdalt_e2e.js')),
  }, null, 2), { flag: 'wx' });
  const r = driveBoot.apply(this, arguments);
  fs.writeFileSync(path.join(c.output, 'cmdalt-' + number + '.stdout'), r.stdout || '', { flag: 'wx' });
  fs.writeFileSync(path.join(c.output, 'cmdalt-' + number + '.stderr'), r.stderr || '', { flag: 'wx' });
  fs.writeFileSync(path.join(c.output, 'cmdalt-' + number + '.exit.json'), JSON.stringify({ status: r.status, signal: r.signal, error: r.error && String(r.error) }), { flag: 'wx' });
  return r;
};
