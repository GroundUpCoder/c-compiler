#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {driveBoot} = require('./lib/drive.js');
const script = fs.readFileSync(path.join(__dirname, '../fixtures/spawn-build.sh'), 'utf8');
const r = driveBoot(["cat > /root/build.sh <<'EOF'", script, 'EOF',
  'sh /root/build.sh 2>/root/build.err; echo BUILD-RC=$?',
  'cat /root/build.err', 'echo SURVIVED', 'exit'], {prefix:'spawn-build-', timeout:120000});
assert.strictEqual(r.status, 0, r.stderr);
assert(r.stdout.includes('SURVIVED'), r.stdout);
assert(r.stdout.includes('BUILD-RC=0') && r.stdout.includes('TOTAL=35100'), r.stdout + r.stderr);
assert(!/could not start|SEGV/.test(r.stdout), r.stdout);
console.log('40-module shell generation + compile + execution: TOTAL=35100; shell survived');
