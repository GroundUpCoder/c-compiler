'use strict';
// The same round-two programs run through the actual /bin/cc driver on both
// gucOS hosts. This module only builds the shell input; it supplies no Wasm.
const fs = require('fs');
const path = require('path');
const cases = require('./cases.js');
const round2 = require('./round2.js');
const positives = [['core',fs.readFileSync(path.join(__dirname,'core.m'),'utf8')], ...cases.positive, ...round2.positive];
const lines = ['mkdir -p /root/objc-round2', 'cd /root/objc-round2'];
function file(name,source) {
  lines.push("cat > '"+name+"' <<'OBJC_FIXTURE_END'",source,'OBJC_FIXTURE_END');
}
for (const [i,[name,source]] of positives.entries()) {
  file('case'+i+'.m',source);
  lines.push('cc -g case'+i+'.m -o case.out && ./case.out || exit 1', "echo 'OBJC-PASS "+name+"'");
}
let count = positives.length;
for (const program of round2.crossPrograms) {
  for (const [name,source] of Object.entries(program.files)) file(name,source);
  for (const order of program.orders) {
    lines.push('cc -g '+order.join(' ')+' -o cross.out && ./cross.out || exit 1', "echo 'OBJC-PASS "+program.name+" "+order.join(' ')+"'");
    count++;
  }
}
lines.push('echo OBJC-COUNT='+count);
module.exports = {source:lines.join('\n')+'\n',count};
