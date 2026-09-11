const fs = require('fs');
const read = fs.readFile;
const target = '/Users/jku/git/c-compiler-small-callbacks/host.js';
fs.readFile = function(file, ...args) {
  if (file === target) {
    fs.appendFileSync('/tmp/784-browser-baseline-loads.jsonl', JSON.stringify({pid:process.pid,file,sha256:require('crypto').createHash('sha256').update(fs.readFileSync('/tmp/784-before-host.js')).digest('hex')})+'\n');
    file='/tmp/784-before-host.js';
  }
  return read.call(this,file,...args);
};
