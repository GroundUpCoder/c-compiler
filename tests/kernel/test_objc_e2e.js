'use strict';
// #772: /bin/cc reads Objective-C from BlockFS, emits a real executable,
// and the kernel launches it as a fresh Wasm process.
const assert = require('assert');
const { driveBoot } = require('./lib/drive.js');
const fixture = require('../objc/os-script.js');
const script = ["cat > /root/objc-round2.sh <<'OBJC_SCRIPT_END'", fixture.source, 'OBJC_SCRIPT_END',
  'sh /root/objc-round2.sh', 'echo OBJC-RESULT=$?', 'exit'].join('\n');
const r = driveBoot(script, { prefix: 'os-objc-', timeout: 900000 });
assert.equal(r.status, 0, String(r.stderr));
assert.match(String(r.stdout), /OBJC-RESULT=0/, String(r.stdout));
assert.match(String(r.stdout),new RegExp('OBJC-COUNT='+fixture.count),String(r.stdout));
console.log('PASS Objective-C /bin/cc + kernel process launch:',fixture.count,'programs');
