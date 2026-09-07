#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {driveBoot, section} = require('./lib/drive.js');
const source = fs.readFileSync(path.join(__dirname, '../fixtures/frame-lifecycle.c'), 'utf8');
const script = ["cat > /root/frame.c <<'EOF'", source, 'EOF',
  'cc -g /root/frame.c -o /root/frame.out',
  'cc -g -DFRAME_EXIT /root/frame.c -o /root/exit.out'];
for (const [binary, status] of [['frame', 139], ['exit', 23]]) {
  script.push('rm -f /tmp/frame-go', '/root/' + binary + '.out 2>/tmp/frame.err &',
    'PID=$!', 'wmctl wait win frame-lifecycle 10000', 'touch /tmp/frame-go',
    'wait $PID; echo ' + binary + '-RC=$?', 'wmctl wait nowin frame-lifecycle 10000',
    'echo ==' + binary, 'wmctl list', 'cat /tmp/frame.err', 'echo ==cut');
}
script.push('echo HOST-SURVIVED', 'exit');
const r = driveBoot(script, {prefix: 'frame-life-', timeout: 60000});
assert.strictEqual(r.status, 0, r.stderr);
assert(/frame-RC=139/.test(r.stdout), r.stdout);
assert(/exit-RC=23/.test(r.stdout), r.stdout);
assert(/HOST-SURVIVED/.test(r.stdout));
for (const binary of ['frame', 'exit']) {
  const out = section(r.stdout, binary);
  assert(!out.includes('\tframe-lifecycle'), 'dead window survived: ' + out);
  assert.strictEqual(/backtrace/.test(out), binary === 'frame', out);
}
console.log('frame trap reaped as 139, clean frame exit reaped as 23, both windows removed; host survived');
