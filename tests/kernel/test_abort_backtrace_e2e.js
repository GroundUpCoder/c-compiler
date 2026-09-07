#!/usr/bin/env node
'use strict';
// #760: real worker SIGABRT must deliver its caller chain before kernel reap.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {driveBoot, section} = require('./lib/drive.js');
const src = fs.readFileSync(path.join(__dirname, '../fixtures/abort-backtrace.c'), 'utf8');
const script = ["cat > /root/abort.c <<'EOF'", src, 'EOF', 'cc -g /root/abort.c -o /root/abort.out || exit 91'];
for (const mode of ['abort', 'assert', 'exit', 'handled']) {
  script.push('echo ==' + mode, '/root/abort.out ' + mode + ' 2>/tmp/abort.err; echo RC=$?',
    'cat /tmp/abort.err', 'echo ==cut');
}
const chain = fs.readFileSync(path.join(__dirname, '../fixtures/debug-flags.c'), 'utf8');
script.push("cat > /root/chain.c <<'EOF'", chain, 'EOF',
  'cc -g2 -fno-inline /root/chain.c -o /root/chain || exit 92',
  'echo ==debug-flags', '/root/chain 2>/tmp/chain.err; echo RC=$?',
  'cat /tmp/chain.err', 'echo ==cut', 'echo HOST-SURVIVED', 'exit');
const r = driveBoot(script, {prefix: 'abort-report-', timeout: 60000});
assert.strictEqual(r.status, 0, r.stderr);
assert(r.stdout.includes('HOST-SURVIVED'), r.stdout);
for (const mode of ['abort', 'assert', 'exit', 'handled']) {
  const out = section(r.stdout, mode);
  assert(out.includes('RC=134'), out);
  assert.strictEqual(out.includes('wasm backtrace'), mode !== 'exit', out);
  if (mode !== 'exit') {
    for (const name of ['depth3', 'depth2', 'depth1', 'main']) assert(new RegExp('\\b' + name + '\\b').test(out), out);
    assert(out.includes('/root/abort.c:'), out);
    assert(!out.includes('wasm trap'), out);
  }
  if (mode === 'assert') assert(out.includes('Assertion failed:'), out);
  if (mode === 'handled') assert(out.includes('handled 6'), out);
}
assert(!r.stderr.includes('wasm backtrace'), 'child report leaked outside redirected fd2');
const debug = section(r.stdout, 'debug-flags');
assert(debug.includes('RC=139'), debug);
for (const name of ['depth3', 'depth2', 'depth1', 'main'])
  assert(new RegExp('#\\d+\\s+' + name + '\\s+at ').test(debug), debug);
assert(debug.includes('/root/chain.c:1'), debug);
console.log('abort/assert/handler caller chains on real redirected fd2; exit134 quiet; shell survives');
