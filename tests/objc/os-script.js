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
for (const [name,source] of Object.entries(round2.crossTU)) file(name,source);
for (const order of ['base.m sub.m main.m','main.m sub.m base.m']) {
  lines.push('cc -g '+order+' -o cross.out && ./cross.out || exit 1', "echo 'OBJC-PASS cross-TU "+order+"'");
}
const count = positives.length+2;
lines.push('echo OBJC-COUNT='+count);
module.exports = {source:lines.join('\n')+'\n',count};
