'use strict';
// #772: /bin/cc reads Objective-C from BlockFS, emits a real executable,
// and the kernel launches it as a fresh Wasm process.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { driveBoot } = require('./lib/drive.js');
const source = fs.readFileSync(path.join(__dirname, '../objc/core.m'), 'utf8');
const script = ["cat > /root/core.m <<'OBJC_SOURCE_END'", source, 'OBJC_SOURCE_END',
  'cc -g /root/core.m -o /root/core.out && /root/core.out',
  'echo OBJC-RESULT=$?', 'exit'].join('\n');
const r = driveBoot(script, { prefix: 'os-objc-', timeout: 900000 });
assert.equal(r.status, 0, String(r.stderr));
assert.match(String(r.stdout), /OBJC-RESULT=0/, String(r.stdout));
console.log('PASS Objective-C /bin/cc + kernel process launch');
