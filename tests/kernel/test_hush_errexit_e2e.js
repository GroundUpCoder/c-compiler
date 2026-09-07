#!/usr/bin/env node
'use strict';
// #769: compare the actual gucOS shell to native sh, including failures in
// bodies/later commands so suppressing errexit globally cannot pass.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');
const {driveBoot} = require('./lib/drive.js');
const script = fs.readFileSync(path.join(__dirname, '../fixtures/hush-errexit.sh'), 'utf8');
const expected = cp.execFileSync('/bin/sh', ['-c', script], {encoding:'utf8'});
const r = driveBoot(["cat > /root/errexit.sh <<'EOF'", script, 'EOF',
  'sh /root/errexit.sh', 'exit'], {prefix:'hush-errexit-', timeout:60000});
assert.strictEqual(r.status, 0, r.stderr);
assert.strictEqual(r.stdout, expected);
console.log('hush errexit: while/until/multi-condition exceptions and body failures match native sh');
