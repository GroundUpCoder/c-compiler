'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
module.exports = function () {
  const root = path.resolve(__dirname, '../..'), base = path.join(root, 'build/async782');
  fs.mkdirSync(base, {recursive: true});
  const directory = fs.mkdtempSync(path.join(base, 'node-' + Date.now() + '-'));
  const pins = {};
  for (const file of ['compiler.js', 'host.js', 'tests/host/run.js',
    'tests/host/test_async_lifecycle.js', 'tests/host/async-lifecycle-evidence.js', 'tests/foundation/corpus.js']) {
    pins[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  const state = {start: new Date().toISOString(),
    head: cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    pins, status: 'running', records: []};
  function save() { fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(state, null, 2) + '\n'); }
  save(); console.log('Async lifecycle evidence:', directory);
  return {
    record(record) {
      const i = state.records.findIndex(r => r.name === record.name);
      if (i < 0) state.records.push({...record}); else state.records[i] = {...record};
      save();
    },
    bytes(record, bytes) { fs.writeFileSync(path.join(directory, record.name + '.wasm'), bytes); },
    finish(error) {
      Object.assign(state, {end: new Date().toISOString(), status: error ? 'fail' : 'pass', done: !error});
      if (error) state.error = error.stack || String(error);
      save();
    }
  };
};
