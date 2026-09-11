const fs = require('fs');
const Module = require('module');
const root = '/Users/jku/git/c-compiler-small-callbacks';
const target = root + '/host.js';
const old = Module._extensions['.js'];
Module._extensions['.js'] = function(mod, filename) {
  if (filename !== target) return old(mod, filename);
  const source = fs.readFileSync('/tmp/784-before-host.js', 'utf8');
  fs.appendFileSync('/tmp/784-baseline-loads.jsonl', JSON.stringify({pid:process.pid,threadId:require('worker_threads').threadId,hash:require('crypto').createHash('sha256').update(source).digest('hex')})+'\n');
  mod._compile(source, filename);
};
const drive = require(root + '/tests/kernel/lib/drive.js');
const original = drive.driveBoot;
drive.driveBoot = (script, opts) => original(script, {...opts,nodeArgs:['-r',__filename,...(opts.nodeArgs||[])]});
